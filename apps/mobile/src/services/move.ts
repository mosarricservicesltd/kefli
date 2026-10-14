// The move (contract 4.8, mobile spec 4.10): a library goes from the source key S, a local key the phone holds, to
// the target T, any signer. Its steps, each recorded in the move job so a move cut short resumes where it stopped:
//   0. prepare T: registered, and its lists in place (as at any sign-in);
//   1. collect both libraries; a save from a newer Kefli in either stops the move here, S untouched;
//   2. copy each of S's saves to T through the outbox (data/move.ts), S's own unsent rows withdrawn;
//   3. move S's connected browsers: POST /devices as T, and a pair-ack sealed by S carrying T and moved_from;
//   4. confirm: T's outbox empty, then every copied save read back and opened from min(2, n) of T's write relays;
//   5. retire S: its inbox drained once more (anything found goes back to step 2), what changed under S since the
//      copy carried to T, kind 5s for its saves and its connected-browsers record to its write relays,
//      DELETE /account as S, then S off the phone.
// S stays whole until step 5, so a save is never deleted before its copy exists under T.
import { bytesToHex } from '@noble/hashes/utils.js';
import { DEVICES_D, KIND, LIBRARY_KEY_D, T_TAG, buildDeletions, httpAuth, readItemEvent, type CryptoPort, type NostrEvent, type Signer } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { enqueue } from '../data/outbox';
import { itemAddresses, newestVersion } from '../data/libraryKey';
import { listServers, writeRelays } from '../data/lists';
import { indexText } from '../data/sync';
import { carryChanges, copySave, moveJob, newerInEither, retireLocal, saveMove, sourceMark, sourceSaves, type MoveJob } from '../data/move';
import type { SaveTargets, StagedBlob } from '../data/saves';
import { registered } from './connect';
import type { RelayAnswer } from './send';
import type { Filter } from './sync';
import { pageStream } from './sync';

export type MoveDefaults = { operator: { relay: string; blossom: string; api: string }; mirrors: string[] };

export type MovePorts = {
  db: SqlDb;
  now: () => number;
  source: Signer;
  target: Signer;
  defaults: () => Promise<MoveDefaults>;
  query: (relay: string, filters: Filter[]) => Promise<NostrEvent[]>;
  publish: (relay: string, event: NostrEvent) => Promise<RelayAnswer>;
  fetch: typeof fetch;
  crypto: CryptoPort;
  readStaged: (sha256: string) => Promise<Uint8Array | null>;
  stage: (sha256: string, bytes: Uint8Array) => string;
  /** A save's spoken words, from its text on the phone, for its search entry under T. */
  spoken: (hash: string) => string | null;
  /**
   * Step 1: an identity's lists, saves and deletions from its read relays, as a sync applies them. False when some
   * events wait for a signer that didn't answer, so the step waits too rather than moving on without them (F14).
   */
  collect: (owner: string, signer: Signer) => Promise<boolean>;
  runOutbox: () => Promise<unknown>;
  /** Step 5: S's inbox, drained one last time into S's rows. */
  drainSourceInbox: () => Promise<void>;
  /** Step 5's end: S out of the key file, and Block Store given T's mnemonic or emptied. */
  retireKeys: () => Promise<void>;
  report?: (moved: number, total: number) => void;
};

/** done; newer: a save from a newer Kefli stopped it before step 2; waiting: a later run carries on. */
export type MoveOutcome = 'done' | 'newer' | 'waiting';

const targetsOf = (d: MoveDefaults): SaveTargets => ({ api: d.operator.api, blossom: d.operator.blossom, mirror: d.mirrors[0] });

async function prepare(p: MovePorts, job: MoveJob): Promise<boolean> {
  const ok = await registered({ db: p.db, now: p.now, owner: job.to, defaults: p.defaults, runOutbox: p.runOutbox });
  if (!ok) return false;
  if (!(await p.collect(job.to, p.target))) return false;
  return !!p.db.get('SELECT 1 FROM relays WHERE owner = ?', job.to);
}

/** S's ciphertext for a save, staged for T's upload: already on the phone, or fetched from where S's copy names. */
export async function stagedBlob(p: MovePorts, from: string, hash: string): Promise<StagedBlob | null | 'missing'> {
  const row = p.db.get<{ text_sha256: string | null; text_servers: string | null }>('SELECT text_sha256, text_servers FROM items WHERE owner = ? AND hash = ?', from, hash);
  const sha = row?.text_sha256;
  if (!sha) return null;
  let bytes = await p.readStaged(sha);
  if (!bytes) {
    const named = row.text_servers ? (JSON.parse(row.text_servers) as string[]) : [];
    const servers = [...new Set([...named, ...listServers(p.db, from), (await p.defaults()).operator.blossom])];
    for (const s of servers) {
      try {
        const res = await p.fetch(`${s.replace(/\/+$/, '')}/${sha}`, { method: 'GET' });
        if (!res.ok) continue;
        const got = new Uint8Array(await res.arrayBuffer());
        if (bytesToHex(p.crypto.sha256(got)) === sha) {
          bytes = got;
          break;
        }
      } catch {
        // the next server
      }
    }
  }
  if (!bytes) return 'missing';
  return { sha256: sha, size: bytes.length, path: p.stage(sha, bytes) };
}

/**
 * RULED: a text no server has (and the phone never staged) can't be owned by T, so its save is copied without
 * text, as a sync leaves a missing blob: the Reader says it couldn't get the text. Unreachable servers wait instead.
 */
async function copyAll(p: MovePorts, job: MoveJob): Promise<boolean> {
  const t = targetsOf(await p.defaults());
  // RULED: S's unsent rows go now that the newer check has passed: every save goes out under T instead
  // except old addresses still to retire (F5), which step 5 names with S's saves
  p.db.run("DELETE FROM outbox WHERE signer = ? AND state IN ('held','queued','dead') AND NOT (op = 'delete_item' AND subject LIKE 'retire:%')", job.from);
  const todo = sourceSaves(p.db, job.from, job.moved);
  const total = job.moved.length + todo.length;
  for (const hash of todo) {
    let blob = await stagedBlob(p, job.from, hash);
    if (blob === 'missing') {
      if (!(await anyServerAnswers(p, job.from, hash))) return false;
      p.db.run("UPDATE items SET text_state = 'failed', fail_reason = 'blob_missing' WHERE owner = ? AND hash = ?", job.from, hash);
      blob = null;
    }
    job.marks[hash] = sourceMark(p.db, job.from, hash);
    if (copySave(p.db, p.now(), job, hash, blob, t) === 'copied') indexCopy(p, job.to, hash);
    job.moved.push(hash);
    saveMove(p.db, p.now(), job);
    p.report?.(job.moved.length, total);
  }
  return true;
}

async function anyServerAnswers(p: MovePorts, from: string, hash: string): Promise<boolean> {
  const row = p.db.get<{ text_sha256: string; text_servers: string | null }>('SELECT text_sha256, text_servers FROM items WHERE owner = ? AND hash = ?', from, hash);
  const servers = row?.text_servers ? (JSON.parse(row.text_servers) as string[]) : [(await p.defaults()).operator.blossom];
  for (const s of servers) {
    try {
      const res = await p.fetch(`${s.replace(/\/+$/, '')}/${row?.text_sha256}`, { method: 'HEAD' });
      if (res.status < 500 && res.status !== 429) return true;
    } catch {
      // unreachable
    }
  }
  return false;
}

function indexCopy(p: MovePorts, owner: string, hash: string): void {
  const row = p.db.get<{ id: number; title: string | null; site: string | null; url: string; text_state: string }>('SELECT id, title, site, url, text_state FROM items WHERE owner = ? AND hash = ?', owner, hash);
  if (!row) return;
  const spoken = row.text_state === 'cached' ? p.spoken(hash) : null;
  indexText(p.db, row, spoken ?? '');
}

/**
 * Step 3: each browser connected to S gets T, a new token, and the pair-ack S seals (C§4.8, 4.4), on the operator
 * relay, where the browser listens (C§4.4: the pair relay is always the operator's). A browser known only from the
 * synced record has no relay on this phone (F19). One this move has already paired with T, or is pairing, is left
 * alone, so a move that goes back to step 2 for saves found at the end doesn't pair a browser twice.
 */
export function queueBrowsers(p: Pick<MovePorts, 'db' | 'now' | 'crypto'>, job: MoveJob, operator: { api: string; relay: string }): number {
  const live = p.db.all<{ device_pubkey: string; label: string }>(
    `SELECT device_pubkey, label FROM devices WHERE owner = ? AND revoked_at IS NULL
       AND device_pubkey NOT IN (SELECT device_pubkey FROM devices WHERE owner = ? AND revoked_at IS NULL AND connected_at >= ? AND device_pubkey IS NOT NULL)
       AND device_pubkey NOT IN (SELECT json_extract(payload, '$.device_pubkey') AS pk FROM outbox WHERE op = 'pair_ack' AND signer = ? AND pk IS NOT NULL)
     GROUP BY device_pubkey ORDER BY connected_at`, job.from, job.to, job.since, job.to);
  for (const b of live) {
    const token = bytesToHex(p.crypto.randomBytes(32));
    // the API moves the browser to T on a release S signs when this is sent (C§4.8 step 4, sendPostDevice)
    const post = enqueue(p.db, p.now(), {
      op: 'post_device', signer: job.to, subject: token, payload: { device_pubkey: b.device_pubkey, label: b.label, moved_from: job.from }, targets: [`${operator.api}/devices`],
    });
    enqueue(p.db, p.now(), {
      op: 'pair_ack', signer: job.to, subject: token, targets: [operator.relay], dependsOn: post,
      payload: { device_pubkey: b.device_pubkey, label: b.label, token, relay: operator.relay, moved_from: job.from },
    });
  }
  return live.length;
}

/**
 * Step 4: T owns every blob and holds every browser, and every copied save reads back and opens on min(2, n) of T's
 * write relays. RULED: any two that answer in full will do, so a public relay that is down (its sends still
 * retrying) doesn't hold the move; the blobs must be T's first, since DELETE /account as S leaves only what T owns.
 */
export async function confirmed(p: MovePorts, job: MoveJob): Promise<boolean> {
  // a row that died is left to the read-back, which finds what it failed to send
  if (p.db.get("SELECT 1 FROM outbox WHERE signer = ? AND op IN ('register','upload_blob','mirror_blob','post_device','pair_ack') AND state IN ('held','queued','sending')", job.to)) return false;
  const relays = writeRelays(p.db, job.to);
  const need = Math.min(2, relays.length);
  if (!need) return false;
  const want = p.db.all<{ hash: string }>('SELECT hash FROM items WHERE owner = ? AND hash IN (SELECT value FROM json_each(?))', job.to, JSON.stringify(job.moved)).map((r) => r.hash);
  let good = 0;
  for (const relay of relays) {
    if (await holdsAll(p, relay, job.to, want)) good++;
    if (good === need) return true;
  }
  return false;
}

async function holdsAll(p: MovePorts, relay: string, owner: string, want: string[]): Promise<boolean> {
  let events: NostrEvent[];
  try {
    events = await pageStream(p.query, relay, { kinds: [KIND.appData], authors: [owner], '#t': [T_TAG] });
  } catch {
    return false;
  }
  const found = new Set<string>();
  for (const e of events) {
    try {
      found.add((await readItemEvent(p.target, e)).hash);
    } catch {
      // not one of T's saves, or one that doesn't open: as if absent
    }
  }
  return want.every((h) => found.has(h));
}

/** Step 5's servers: kind 5s for S's saves and record (unconfirmed, RULED), then DELETE /account as S, which must succeed. */
async function retireRemote(p: MovePorts, job: MoveJob): Promise<boolean> {
  // each save at every address it is at, never a plain hash it wasn't published under (F5), the saves deleted while
  // the move ran whose kind 5s are still to go out (F20), and S's records
  const ds = [
    ...itemAddresses(p.db, job.from),
    ...p.db.all<{ d: string }>('SELECT d FROM items_future WHERE owner = ?', job.from).map((r) => r.d),
    DEVICES_D, LIBRARY_KEY_D,
  ];
  // dated past the newest version of anything they name, whatever this phone's clock says (F36)
  const deletions = await buildDeletions(p.source, [...new Set(ds)], Math.max(p.now(), newestVersion(p.db, job.from) + 1));
  await Promise.all(writeRelays(p.db, job.from).map(async (relay) => {
    for (const e of deletions) await p.publish(relay, e).catch(() => undefined);
  }));
  const url = `${(await p.defaults()).operator.api.replace(/\/+$/, '')}/account`;
  try {
    const res = await p.fetch(url, { method: 'DELETE', headers: { Authorization: await httpAuth(p.source, url, 'DELETE', null, p.crypto) } });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

async function retire(p: MovePorts, job: MoveJob): Promise<'again' | boolean> {
  await p.drainSourceInbox().catch(() => undefined);
  if (sourceSaves(p.db, job.from, job.moved).length) return 'again';
  // what changed under S since its saves were copied goes to T before S's rows go (F20), marked carried in the same
  // transaction and saved before any of S's retirement goes out, so a later pass reads S's missing rows as retired
  p.db.tx(() => {
    carryChanges(p.db, p.now(), job);
    saveMove(p.db, p.now(), job);
  });
  if (!(await retireRemote(p, job))) return false;
  retireLocal(p.db, job.from, job.to);
  await p.retireKeys();
  return true;
}

/** One step's result: on to the next step, stay where the step itself put the job, or how this run ends. */
type Step = 'next' | 'stay' | MoveOutcome;

/** Step 1: both libraries collected in full, stopped by a save from a newer Kefli in either (C§10, FD 91 (i)). */
async function collectBoth(p: MovePorts, job: MoveJob): Promise<Step> {
  if (newerInEither(p.db, job.from, job.to)) return 'newer';
  const fromAll = await p.collect(job.from, p.source);
  const toAll = await p.collect(job.to, p.target);
  if (!fromAll || !toAll) return 'waiting';
  return newerInEither(p.db, job.from, job.to) ? 'newer' : 'next';
}

/** Step 3: the browsers queued with the step moved on, in one transaction, so each is paired once. */
async function pairBrowsers(p: MovePorts, job: MoveJob): Promise<Step> {
  const { operator } = await p.defaults();
  job.step++;
  p.db.tx(() => {
    queueBrowsers(p, job, operator);
    saveMove(p.db, p.now(), job);
  });
  await p.runOutbox();
  return 'stay';
}

/** Step 5: S retired, or back to the copy for a save found at the end. */
async function retireStep(p: MovePorts, job: MoveJob): Promise<Step> {
  const r = await retire(p, job);
  if (r === 'again') {
    job.step = 2;
    saveMove(p.db, p.now(), job);
    return 'stay';
  }
  if (!r) return 'waiting';
  saveMove(p.db, p.now(), job, 'done');
  return 'done';
}

const STEPS: ((p: MovePorts, job: MoveJob) => Promise<Step>)[] = [
  async (p, job) => ((await prepare(p, job)) ? 'next' : 'waiting'),
  collectBoth,
  async (p, job) => {
    if (!(await copyAll(p, job))) return 'waiting';
    await p.runOutbox();
    return 'next';
  },
  pairBrowsers,
  async (p, job) => {
    await p.runOutbox();
    return (await confirmed(p, job)) ? 'next' : 'waiting';
  },
  retireStep,
];

/** Runs or resumes the move job (the database's, unless given), as far as it can go now. */
export async function runMove(p: MovePorts, given?: MoveJob | null): Promise<MoveOutcome> {
  // read here, since the code gate's parser loses a function whose default parameter calls another
  const job = given === undefined ? moveJob(p.db) : given;
  if (!job) return 'done';
  for (let guard = 0; guard < 12; guard++) {
    const r = await STEPS[Math.min(job.step, STEPS.length - 1)](p, job);
    if (r === 'stay') continue;
    if (r !== 'next') return r;
    job.step++;
    saveMove(p.db, p.now(), job);
  }
  return 'waiting';
}
