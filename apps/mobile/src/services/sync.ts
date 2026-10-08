// Inbound sync (mobile spec 4.5), phases 1, 3 and 5: the active identity's lists, then its saves and deletions
// from every read relay, paged back to the cursor, then the texts. The relay pool and files are ports, so this
// runs in tests.
//
// RULED: until nostr sign-in arrives (week 4), every identity on the phone is Shelf's own, so one with no relay
// rows (a reinstall that adopted Block Store's key) is seeded with the generated lists before its published
// 10002 is read; relays that list adds are read from too.
//
// Every relay's pages are collected before anything is applied, and saves are applied before deletions, so a
// save still held by a relay that missed its deletion can't come back in the same run.
import { DEVICES_D, KIND, T_TAG, decryptText, newest, readDevicesEvent, readItemEvent, readRelayList } from '@shelf/protocol';
import { deriveArticle, type Derived } from '../reader/blocks';
import type { CryptoPort, NostrEvent, Signer } from '@shelf/protocol';
import type { SqlDb } from '../data/db';
import { absorbRecord, queueRecord } from '../data/devices';
import { KEEP_COPIES, getSetting } from '../data/settings';
import { readUserLists, settleUserLists } from './nostrSignIn';
import { markBacked } from '../data/backup';
import { indexerRelays, listServers, recordList, relayEntries, seedGeneratedLists, type DefaultsLike } from '../data/lists';
import {
  applyDeletion, applyItem, getCursor, hashInUse, readRelays, setCursor, textCached, textMissing, textQueue,
  type Stream, type TextJob,
} from '../data/sync';

export type Filter = { kinds: number[]; authors?: string[]; '#t'?: string[]; '#k'?: string[]; '#p'?: string[]; since?: number; until?: number; limit?: number };

export type SyncPorts = {
  db: SqlDb;
  now: () => number;
  signer: (pubkey: string) => Promise<Signer | null>;
  /** The events matching filters until EOSE; throws when the relay can't be reached. */
  query: (relay: string, filters: Filter[]) => Promise<NostrEvent[]>;
  fetch: typeof fetch;
  crypto: CryptoPort;
  defaults: () => Promise<DefaultsLike>;
  files: { writeText: (hash: string, markdown: string, derived?: Derived) => void; removeText: (hash: string) => void; removeAll: (hash: string) => void };
  /** The article open in the Reader, whose remote position waits. */
  openHash?: () => string | null;
  onHeldWord?: (hash: string, word: number) => void;
};

/** Relays may send fewer than the limit (NIP-01), so paging stops only when a page brings nothing new. */
export const PAGE = 500;
/** The cursor is moved back five minutes for clock skew between relays. */
export const SKEW = 300;
const MAX_PAGES = 200;

export async function pageStream(query: SyncPorts['query'], relay: string, base: Filter): Promise<NostrEvent[]> {
  const seen = new Map<string, NostrEvent>();
  let until: number | undefined;
  for (let i = 0; MAX_PAGES > i; i++) {
    const page = await query(relay, [{ ...base, limit: PAGE, ...(until === undefined ? {} : { until }) }]);
    let fresh = 0;
    let oldest = until ?? Infinity;
    for (const e of page) {
      if (!seen.has(e.id)) {
        seen.set(e.id, e);
        fresh++;
      }
      oldest = Math.min(oldest, e.created_at);
    }
    if (fresh === 0) break;
    // The next page's until is the oldest seen, inclusive: events sharing that second aren't skipped.
    until = oldest;
  }
  return [...seen.values()];
}

export function streamFilter(stream: Stream, owner: string, since: number | null): Filter {
  const base: Filter = stream === 'items'
    ? { kinds: [KIND.appData], authors: [owner], '#t': [T_TAG] }
    : { kinds: [KIND.deletion], authors: [owner], '#k': [String(KIND.appData)] };
  return since === null ? base : { ...base, since: Math.max(0, since - SKEW) };
}

type Collected = { relay: string; stream: Stream; events: NostrEvent[] };

async function collect(p: SyncPorts, owner: string, startedAt: number): Promise<Collected[]> {
  const jobs = readRelays(p.db, owner).flatMap((relay) => (['items', 'deletions'] as Stream[]).map((stream) => ({ relay, stream })));
  const results = await Promise.all(
    jobs.map(async ({ relay, stream }) => {
      try {
        const events = await pageStream(p.query, relay, streamFilter(stream, owner, getCursor(p.db, relay, stream, owner)?.since ?? null));
        return { relay, stream, events };
      } catch {
        return null; // unreachable: its cursor stays, and the next trigger asks again
      }
    }),
  );
  const ok = results.filter((r): r is Collected => r !== null);
  for (const r of ok) setCursor(p.db, startedAt, r.relay, r.stream, owner, startedAt);
  return ok;
}

export type SyncResult = { items: number; deletions: number; texts: number; missing: number };

function partition<T>(xs: T[], test: (x: T) => boolean): [T[], T[]] {
  return [xs.filter(test), xs.filter((x) => !test(x))];
}

/** Copies of the connected-browsers record (C§4.9), merged in by token; republished when this phone holds more. */
async function absorbRecords(p: SyncPorts, owner: string, signer: Signer, records: NostrEvent[]): Promise<void> {
  let republish = false;
  for (const e of records) {
    try {
      republish = absorbRecord(p.db, owner, await readDevicesEvent(signer, e), e.id, e.created_at) || republish;
    } catch {
      // another identity's, or a version this phone doesn't read: left alone
    }
  }
  if (republish) queueRecord(p.db, p.now(), owner);
}

async function applyAll(p: SyncPorts, owner: string, signer: Signer, collected: Collected[]): Promise<Pick<SyncResult, 'items' | 'deletions'>> {
  const unique = (s: Stream) => [...new Map(collected.filter((c) => c.stream === s).flatMap((c) => c.events).map((e) => [e.id, e])).values()];
  let items = 0;
  const [records, saves] = partition(unique('items'), (e) => e.tags.some((t) => t[0] === 'd' && t[1] === DEVICES_D));
  await absorbRecords(p, owner, signer, records);
  for (const e of saves.sort((a, b) => a.created_at - b.created_at)) {
    let read;
    try {
      read = await readItemEvent(signer, e);
    } catch {
      continue; // not a save of this identity's, or a NIP-44 failure: dropped (4.5)
    }
    const a = applyItem(p.db, p.now(), owner, read.hash, e, read.item, p.openHash?.());
    if (a.outcome === 'insert' || a.outcome === 'take' || a.outcome === 'future') items++;
    if (a.textReplaced) p.files.removeText(read.hash);
    if (a.outcome === 'future' && !hashInUse(p.db, read.hash)) p.files.removeAll(read.hash);
    if (a.heldWord !== undefined) p.onHeldWord?.(read.hash, a.heldWord);
  }
  let deletions = 0;
  for (const e of unique('deletions')) {
    for (const hash of applyDeletion(p.db, owner, e)) {
      deletions++;
      if (!hashInUse(p.db, hash)) p.files.removeAll(hash);
    }
  }
  return { items, deletions };
}

/** One text from its servers, then the identity's 10063 servers: 'ok', 'missing' everywhere, or 'offline'. */
export async function fetchText(p: SyncPorts, job: TextJob): Promise<'ok' | 'missing' | 'offline'> {
  const named = job.text_servers ? (JSON.parse(job.text_servers) as string[]) : [];
  const servers = [...new Set([...named, ...listServers(p.db, job.owner)])];
  let unreachable = 0;
  for (const server of servers) {
    let bytes: Uint8Array;
    try {
      const res = await p.fetch(`${server.replace(/\/+$/, '')}/${job.text_sha256}`, { method: 'GET' });
      if (!res.ok) {
        if (res.status >= 500 || res.status === 429) unreachable++;
        continue;
      }
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      unreachable++;
      continue;
    }
    let markdown: string;
    try {
      markdown = await decryptText(bytes, { sha256: job.text_sha256, key: job.text_key, nonce: job.text_nonce }, p.crypto);
    } catch {
      continue; // the wrong bytes, or a key that doesn't open them: as if this server lacked it
    }
    const derived = deriveArticle(markdown);
    p.files.writeText(job.hash, markdown, derived);
    textCached(p.db, job, derived.spoken);
    return 'ok';
  }
  if (unreachable > 0) return 'offline';
  textMissing(p.db, job);
  return 'missing';
}

/** Phase 1: the identity's newest 10002 and 10063 from the indexer and its relays, recorded; new relays joined. */
export async function syncLists(p: SyncPorts, owner: string): Promise<void> {
  if (!p.db.get('SELECT 1 FROM relays WHERE owner = ?', owner)) {
    const d = await p.defaults();
    const provider = p.db.get<{ provider: string }>('SELECT provider FROM identities WHERE pubkey = ?', owner)?.provider;
    if (provider === 'local' || !provider) seedGeneratedLists(p.db, owner, d);
    else {
      // a nostr user's own lists, read until found or confirmed absent (4.6); nothing is published meanwhile
      const lists = await readUserLists({ db: p.db, now: p.now, defaults: d, query: p.query }, owner);
      if (!settleUserLists(p.db, p.now(), owner, d, lists, getSetting(p.db, KEEP_COPIES) !== '0')) return;
    }
  }
  const relays = [...new Set([...indexerRelays(p.db, owner), ...relayEntries(p.db, owner).map((r) => r.url)])];
  // a nostr user's profile comes with their lists, for You's name and picture (FD 12, G12)
  const nostr = (p.db.get<{ provider: string }>('SELECT provider FROM identities WHERE pubkey = ?', owner)?.provider ?? 'local') !== 'local';
  const kinds = nostr ? [KIND.relayList, KIND.serverList, KIND.metadata] : [KIND.relayList, KIND.serverList];
  const copies = (await Promise.all(relays.map((r) => p.query(r, [{ kinds, authors: [owner] }]).catch(() => [])))).flat();
  for (const kind of kinds) {
    const latest = newest(copies.filter((e) => e.kind === kind && e.pubkey === owner));
    const held = p.db.get<{ created_at: number }>("SELECT created_at FROM lists WHERE owner = ? AND kind = ? AND d = ''", owner, kind);
    if (!latest || (held && held.created_at >= latest.created_at)) continue;
    recordList(p.db, owner, kind, latest.id, latest.created_at, JSON.stringify(latest));
    if (kind !== KIND.relayList) continue;
    for (const e of readRelayList(latest)) {
      p.db.run("INSERT OR IGNORE INTO relays (url, owner, read, write, source, added_by_shelf) VALUES (?, ?, ?, ?, 'user', 0)", e.url, owner, e.read ? 1 : 0, e.write ? 1 : 0);
    }
  }
}

/** Phase 1, phase 3 then phase 5 for the active identity. Restartable: cursors move only after a relay answers in full. */
export async function syncInbound(p: SyncPorts): Promise<SyncResult> {
  const owner = p.db.get<{ pubkey: string }>("SELECT pubkey FROM identities WHERE role = 'active'")?.pubkey;
  const signer = owner ? await p.signer(owner) : null;
  if (!owner || !signer) return { items: 0, deletions: 0, texts: 0, missing: 0 };
  return syncOwner(p, owner, signer);
}

/** The same for any identity on the phone: a move collects its source's library this way (C§4.8 step 2). */
export async function syncOwner(p: SyncPorts, owner: string, signer: Signer): Promise<SyncResult> {
  await syncLists(p, owner);
  const collected = await collect(p, owner, p.now());
  const { items, deletions } = await applyAll(p, owner, signer, collected);
  // a save seen on a relay the operator doesn't run is backed up there (FD 93)
  const operator = (await p.defaults()).operator.relay;
  for (const c of collected) if (c.stream === 'items' && c.relay !== operator) for (const e of c.events) markBacked(p.db, e.id);
  let texts = 0;
  let missing = 0;
  for (const job of textQueue(p.db, owner, p.openHash?.())) {
    const r = await fetchText(p, job);
    if (r === 'ok') texts++;
    if (r === 'missing') missing++;
  }
  return { items, deletions, texts, missing };
}
