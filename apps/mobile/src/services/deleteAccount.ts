// Delete my data (mobile spec 5.8, 7.2, contract 4.7, FD 14, FD 28, FD 91 (e)), in three steps and in this order,
// since the operator relay refuses an account's kind 5s once it is deleted:
//   1. the operator: kind 5s for every wrap the phone knows of, and for every save when the operator relay is in
//      the user's 10002; every blob on the operator Blossom server; then DELETE /account. Unreachable after a
//      minute of retries, or DELETE /account refused, and nothing else runs: the key stays, to try again.
//   2. every other server: each other write relay gets kind 5s for every save, the connected-browsers record
//      included, and the generated identity's lists (also sent to the indexer); each other Blossom server named in
//      a save's text.servers, the mirror among them, gets a delete for every blob. A relay is confirmed when it
//      answered OK to every kind 5, a server when it answered 2xx or 404 to every delete; each gets a minute.
//   3. the phone: the key file, Block Store, the database and the files.
// Each step's result is kept in a delete_account job, so a deletion cut short resumes where it stopped.
import { DEVICES_D, KIND, buildDeletions, deleteBlob, httpAuth, type CryptoPort, type NostrEvent, type Signer } from '@shelf/protocol';
import type { SqlDb } from '../data/db';
import type { RelayAnswer } from './send';

export type DelPorts = {
  db: SqlDb;
  now: () => number;
  signer: Signer;
  defaults: { operator: { relay: string; blossom: string; api: string }; indexer: string[] };
  publish: (relay: string, event: NostrEvent) => Promise<RelayAnswer>;
  fetch: typeof fetch;
  crypto: CryptoPort;
  sleep: (ms: number) => Promise<void>;
  /** Step 3, on the phone's storage. */
  wipePhone: () => Promise<void>;
  /** Each server's minute (spec 7.2). */
  budgetMs?: number;
};

export type Target = { url: string; kind: 'relay' | 'server'; host: string };
export type Result = 'wait' | 'done' | 'fail';
export type Progress = { operator: Result; others: Record<string, Result>; phone: Result };
export type Outcome = 'done' | 'partial' | 'failed';

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};
const trim = (u: string) => u.replace(/\/+$/, '');

/** The servers step 2 asks: other write relays in the 10002, and other Blossom servers that hold a save's text. */
export function deleteTargets(db: SqlDb, owner: string, operator: { relay: string; blossom: string }): Target[] {
  const relays = db.all<{ url: string }>("SELECT url FROM relays WHERE owner = ? AND write = 1 AND source != 'indexer' ORDER BY rowid", owner)
    .map((r) => r.url).filter((u) => trim(u) !== trim(operator.relay));
  const named = db.all<{ text_servers: string }>('SELECT text_servers FROM items WHERE owner = ? AND text_servers IS NOT NULL', owner)
    .flatMap((r) => JSON.parse(r.text_servers) as string[]);
  const mirrors = db.all<{ url: string }>("SELECT url FROM servers WHERE owner = ? AND role != 'operator'", owner).map((r) => r.url);
  const servers = [...new Set([...named, ...mirrors].map(trim))].filter((u) => u !== trim(operator.blossom));
  return [
    ...[...new Set(relays)].map((url) => ({ url, kind: 'relay' as const, host: host(url) })),
    ...servers.map((url) => ({ url, kind: 'server' as const, host: host(url) })),
  ];
}

const JOB = 'delete_account';

export function progressOf(db: SqlDb): Progress | null {
  const r = db.get<{ data: string }>('SELECT data FROM jobs WHERE id = ?', JOB);
  return r ? (JSON.parse(r.data) as Progress) : null;
}

function save(p: DelPorts, prog: Progress): void {
  p.db.run(
    `INSERT INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES (?, 'delete_account', 'running', 0, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    JOB, JSON.stringify(prog), p.now(), p.now(),
  );
}

/** Tries until it succeeds or the minute is spent: 2 s, then doubling. */
async function withinMinute(p: DelPorts, attempt: () => Promise<boolean>): Promise<boolean> {
  const budget = p.budgetMs ?? 60_000;
  let spent = 0;
  for (let wait = 2000; ; wait *= 2) {
    if (await attempt().catch(() => false)) return true;
    if (spent + wait > budget) return false;
    await p.sleep(wait);
    spent += wait;
  }
}

/** Every d this identity holds: saves, saves from a newer Shelf, and the connected-browsers record. */
function allDs(db: SqlDb, owner: string): string[] {
  const items = db.all<{ hash: string }>('SELECT hash FROM items WHERE owner = ?', owner).map((r) => `shelf/item/${r.hash}`);
  const future = db.all<{ d: string }>('SELECT d FROM items_future WHERE owner = ?', owner).map((r) => r.d);
  return [...new Set([...items, ...future, DEVICES_D])];
}

function blobs(db: SqlDb, owner: string): string[] {
  return db.all<{ s: string }>('SELECT DISTINCT text_sha256 AS s FROM items WHERE owner = ? AND text_sha256 IS NOT NULL', owner).map((r) => r.s);
}

async function wrapDeletions(p: DelPorts, owner: string): Promise<NostrEvent[]> {
  const ids = p.db.all<{ wrap_id: string }>('SELECT wrap_id FROM inbox_seen WHERE owner = ?', owner).map((r) => r.wrap_id);
  const out: NostrEvent[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const tags = [...ids.slice(i, i + 50).map((id) => ['e', id]), ['k', String(KIND.giftWrap)]];
    out.push(await p.signer.signEvent({ kind: KIND.deletion, created_at: p.now(), tags, content: '' }));
  }
  return out;
}

/**
 * The generated identity's lists (C§4.7): the a tags the contract gives, and, RULED, an e tag for each list event the
 * phone sent or saw, since some relays (strfry among them) honour an a tag only for addressable kinds.
 */
async function listDeletion(p: DelPorts): Promise<NostrEvent | null> {
  const pk = p.signer.pubkey();
  // a nostr user's lists are shared with their other apps and are never deleted (C§4.7); their rewrite without
  // Shelf's entries comes with the rest of the nostr user's deletion
  if (p.db.get<{ provider: string }>('SELECT provider FROM identities WHERE pubkey = ?', pk)?.provider !== 'local') return null;
  const ids = p.db.all<{ event_id: string }>("SELECT event_id FROM lists WHERE owner = ? AND kind IN (?, ?) AND d = '' AND event_id IS NOT NULL", pk, KIND.relayList, KIND.serverList)
    .map((r) => ['e', r.event_id]);
  return p.signer.signEvent({
    kind: KIND.deletion, created_at: p.now(), content: '',
    tags: [['a', `${KIND.relayList}:${pk}:`], ['a', `${KIND.serverList}:${pk}:`], ...ids, ['k', String(KIND.relayList)], ['k', String(KIND.serverList)]],
  });
}

/** Sends every event to a relay; true when it answered OK to each (a relay that refuses one hasn't confirmed). */
async function sendAll(p: DelPorts, relay: string, events: NostrEvent[]): Promise<boolean> {
  for (const e of events) {
    const a = await p.publish(relay, e);
    if (!a.ok && !/^duplicate:/.test(a.reason)) return false;
  }
  return true;
}

async function deleteBlobs(p: DelPorts, server: string, shas: string[]): Promise<boolean> {
  for (const s of shas) if (!(await deleteBlob(server, s, p.signer, p.fetch)).ok) return false;
  return true;
}

async function stepOperator(p: DelPorts, owner: string): Promise<boolean> {
  const op = p.defaults.operator;
  const inList = !!p.db.get("SELECT 1 FROM relays WHERE owner = ? AND url = ? AND source != 'indexer'", owner, op.relay);
  // in the 10002, it gets everything step 2 sends the other relays: the saves' deletions and the lists'
  const lists = await listDeletion(p);
  const events = [...(await wrapDeletions(p, owner)), ...(inList ? [...(await buildDeletions(p.signer, allDs(p.db, owner), p.now())), ...(lists ? [lists] : [])] : [])];
  // the relay answering at all is what this step needs; a kind 5 it refuses doesn't stop the account's deletion
  const reached = await withinMinute(p, async () => {
    for (const e of events) await p.publish(op.relay, e);
    return true;
  });
  const shas = blobs(p.db, owner);
  const cleared = reached && (await withinMinute(p, () => deleteBlobs(p, op.blossom, shas)));
  if (!cleared) return false;
  const url = `${trim(op.api)}/account`;
  return withinMinute(p, async () => {
    const res = await p.fetch(url, { method: 'DELETE', headers: { Authorization: await httpAuth(p.signer, url, 'DELETE', null, p.crypto) } });
    return res.ok || res.status === 404;
  });
}

async function stepOther(p: DelPorts, owner: string, t: Target): Promise<boolean> {
  if (t.kind === 'server') return withinMinute(p, () => deleteBlobs(p, t.url, blobs(p.db, owner)));
  const lists = await listDeletion(p);
  const events = [...(await buildDeletions(p.signer, allDs(p.db, owner), p.now())), ...(lists ? [lists] : [])];
  return withinMinute(p, () => sendAll(p, t.url, events));
}

/**
 * Runs or resumes the deletion, reporting each step as it resolves. failed: the operator couldn't be reached or
 * refused, and nothing else ran. partial: some other server didn't confirm; the phone is wiped all the same.
 */
export async function deleteEverything(p: DelPorts, report: (prog: Progress) => void): Promise<Outcome> {
  const owner = p.signer.pubkey();
  const targets = deleteTargets(p.db, owner, p.defaults.operator);
  const prog: Progress = progressOf(p.db) ?? { operator: 'wait', others: Object.fromEntries(targets.map((t) => [t.url, 'wait'])), phone: 'wait' };
  report(prog);
  if (prog.operator !== 'done') {
    prog.operator = (await stepOperator(p, owner)) ? 'done' : 'fail';
    report({ ...prog });
    if (prog.operator === 'fail') {
      p.db.run('DELETE FROM jobs WHERE id = ?', JOB);
      return 'failed';
    }
    save(p, prog);
  }
  // the lists go from the indexer as well, unreported: it holds nothing else of this identity
  const lists = await listDeletion(p);
  if (lists) await Promise.all(p.defaults.indexer.map((r) => p.publish(r, lists).catch(() => undefined)));
  await Promise.all(targets.filter((t) => prog.others[t.url] === 'wait').map(async (t) => {
    prog.others[t.url] = (await stepOther(p, owner, t)) ? 'done' : 'fail';
    save(p, prog);
    report({ ...prog, others: { ...prog.others } });
  }));
  await p.wipePhone();
  prog.phone = 'done';
  report({ ...prog });
  return Object.values(prog.others).some((r) => r === 'fail') ? 'partial' : 'done';
}
