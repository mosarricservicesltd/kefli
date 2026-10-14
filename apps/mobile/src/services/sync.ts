// Inbound sync (mobile spec 4.5), phases 1, 3 and 5: the active identity's lists, then its saves and deletions
// from every read relay, paged back to the cursor, then the texts. The relay pool and files are ports, so this
// runs in tests.
//
// RULED: until nostr sign-in arrives (week 4), every identity on the phone is Kefli's own, so one with no relay
// rows (a reinstall that adopted Block Store's key) is seeded with the generated lists before its published
// 10002 is read; relays that list adds are read from too.
//
// Every relay's pages are collected before anything is applied, and saves are applied before deletions, so a
// save still held by a relay that missed its deletion can't come back in the same run. The cursors move only once
// everything collected has been applied (F14).
import {
  DEVICES_D, KIND, LIBRARY_KEY_D, T_TAG, decryptText, isSignerFailure, newest, readDevicesEvent, readItemEvent, readLibraryKeyEvent,
  readRelayList, readServerList,
} from '@kefli/protocol';
import { deriveArticle, type Derived } from '../reader/blocks';
import type { CryptoPort, NostrEvent, Signer } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { absorbRecord, queueRecord } from '../data/devices';
import { KEEP_COPIES, getSetting } from '../data/settings';
import { readUserLists, settleUserLists } from './nostrSignIn';
import { markBacked } from '../data/backup';
import { TooLarge, open } from '../net/http';
import {
  heldServerList, indexerRelays, keepListedServers, listServers, recordList, relayEntries, seedGeneratedLists, writeRelays, type DefaultsLike,
} from '../data/lists';
import { adoptLibraryKey, libraryKey, makeLibraryKey, moveToKeyedAddresses } from '../data/libraryKey';
import {
  applyDeletion, applyItem, getCursor, hashInUse, readRelays, setCursor, textCached, textMissing, textQueue,
  type Stream, type TextJob,
} from '../data/sync';

export type Filter = { kinds: number[]; authors?: string[]; '#t'?: string[]; '#d'?: string[]; '#k'?: string[]; '#p'?: string[]; since?: number; until?: number; limit?: number };

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
/**
 * Each read reaches a day back past its cursor. The cursor is this phone's clock and an event carries the clock of the
 * device that made it, so devices whose clocks are up to a day apart still see each other's changes (F36). An event
 * a row already holds is not opened again, so the overlap asks the signer little: only for versions a row doesn't hold.
 */
export const SKEW = 86_400;
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

async function collect(p: SyncPorts, owner: string): Promise<Collected[]> {
  const relays = readRelays(p.db, owner);
  const jobs = relays.flatMap((relay) => (['items', 'deletions'] as Stream[]).map((stream) => ({ relay, stream })));
  // while any relay's saves are read from the start (one just added, say), every relay's deletions are too, so a
  // save it still holds can't come back past a deletion the others got long ago (F35)
  const backfilling = relays.some((r) => !getCursor(p.db, r, 'items', owner));
  const results = await Promise.all(
    jobs.map(async ({ relay, stream }) => {
      try {
        const since = stream === 'deletions' && backfilling ? null : getCursor(p.db, relay, stream, owner)?.since ?? null;
        const events = await pageStream(p.query, relay, streamFilter(stream, owner, since));
        return { relay, stream, events };
      } catch {
        return null; // unreachable: its cursor stays, and the next trigger asks again
      }
    }),
  );
  return results.filter((r): r is Collected => r !== null);
}

/** waiting: events the signer didn't answer for, which keep every cursor where it was so the next sync asks again (F14). */
export type SyncResult = { items: number; deletions: number; texts: number; missing: number; waiting: number };

/** Reads an event through the signer, or null for one it can't read; see applyAll. */
type Open = <T>(read: () => Promise<T>) => Promise<T | null>;

function partition<T>(xs: T[], test: (x: T) => boolean): [T[], T[]] {
  return [xs.filter(test), xs.filter((x) => !test(x))];
}

/** Copies of the connected-browsers record (C§4.9), merged in by token; republished when this phone holds more. */
async function absorbRecords(p: SyncPorts, owner: string, signer: Signer, records: NostrEvent[], open: Open): Promise<void> {
  let republish = false;
  for (const e of records) {
    // null: another identity's, or a version this phone doesn't read, left alone; or waiting for the signer
    const read = await open(() => readDevicesEvent(signer, e));
    if (read) republish = absorbRecord(p.db, owner, read, e.id, e.created_at) || republish;
  }
  if (republish) queueRecord(p.db, p.now(), owner);
}

async function applyAll(p: SyncPorts, owner: string, signer: Signer, collected: Collected[]): Promise<Pick<SyncResult, 'items' | 'deletions' | 'waiting'>> {
  const unique = (s: Stream) => [...new Map(collected.filter((c) => c.stream === s).flatMap((c) => c.events).map((e) => [e.id, e])).values()];
  let items = 0;
  let waiting = 0;
  // A signer that didn't answer (out of sight, timed out, declined) says nothing about the event: it and every event
  // after it wait, unasked, since the rest would fail the same way, two minutes each for a bunker (F14). Any other
  // failure is not a save of this identity's, or a NIP-44 failure, and the event is dropped (4.5).
  const open: Open = async (read) => {
    if (waiting) {
      waiting++;
      return null;
    }
    try {
      return await read();
    } catch (e) {
      if (isSignerFailure(e)) waiting++;
      return null;
    }
  };
  const [records, saves] = partition(unique('items'), (e) => e.tags.some((t) => t[0] === 'd' && t[1] === DEVICES_D));
  await absorbRecords(p, owner, signer, records, open);
  // the event a row already holds merges as keep (4.5), so the day of overlap (F36) is read without asking the signer
  const held = new Set(p.db.all<{ event_id: string }>('SELECT event_id FROM items WHERE owner = ? AND event_id IS NOT NULL', owner).map((r) => r.event_id));
  for (const e of saves.filter((x) => !held.has(x.id)).sort((a, b) => a.created_at - b.created_at)) {
    const read = await open(() => readItemEvent(signer, e));
    if (!read) continue;
    const a = applyItem(p.db, p.now(), owner, read.hash, e, read.item, p.openHash?.());
    if (a.outcome === 'insert' || a.outcome === 'take' || a.outcome === 'future') items++;
    if (a.textReplaced) p.files.removeText(read.hash);
    if (a.outcome === 'future' && !hashInUse(p.db, read.hash)) p.files.removeAll(read.hash);
    if (a.heldWord !== undefined) p.onHeldWord?.(read.hash, a.heldWord);
  }
  // deletions need no signer; with the cursors kept they are read again alongside the saves that wait
  let deletions = 0;
  for (const e of unique('deletions')) {
    for (const hash of applyDeletion(p.db, owner, e)) {
      deletions++;
      if (!hashInUse(p.db, hash)) p.files.removeAll(hash);
    }
  }
  return { items, deletions, waiting };
}

/** A text is never larger than the largest file one is made from, a 20 MB PDF (4.2). */
export const TEXT_MAX_BYTES = 20 * 1024 * 1024;
/** How long one server has to send a whole text. */
export const TEXT_TIMEOUT_MS = 60_000;

type Got = { status: number; bytes: Uint8Array | null };

/**
 * One blob from one server, the deadline running until the whole body is in (F12, through net/http's open, as pages
 * and images are read): the status, and a 2xx's bytes (null past TEXT_MAX_BYTES, declared or streamed). Throws when
 * the server can't be reached or doesn't finish within TEXT_TIMEOUT_MS.
 */
async function getBlob(p: SyncPorts, url: string): Promise<Got> {
  const o = await open(p.fetch, url, { method: 'GET' }, TEXT_TIMEOUT_MS);
  if (!o.res.ok) {
    o.done();
    return { status: o.res.status, bytes: null };
  }
  try {
    return { status: o.res.status, bytes: await o.read(TEXT_MAX_BYTES) };
  } catch (e) {
    if (e instanceof TooLarge) return { status: o.res.status, bytes: null };
    throw e;
  }
}

/** One text from its servers, then the identity's 10063 servers: 'ok', 'missing' everywhere, or 'offline'. */
export async function fetchText(p: SyncPorts, job: TextJob): Promise<'ok' | 'missing' | 'offline'> {
  const named = job.text_servers ? (JSON.parse(job.text_servers) as string[]) : [];
  // the 10063 as published is asked as well as the rows kept from it (C§8, F37); each server once, slash or not
  const listed = [...named, ...listServers(p.db, job.owner), ...heldServerList(p.db, job.owner)];
  const servers = [...new Set(listed.map((s) => s.replace(/\/+$/, '')))];
  let unreachable = 0;
  for (const server of servers) {
    let bytes: Uint8Array;
    try {
      const got = await getBlob(p, `${server}/${job.text_sha256}`);
      if (got.status < 200 || got.status > 299) {
        if (got.status >= 500 || got.status === 429) unreachable++;
        continue;
      }
      if (!got.bytes) continue; // larger than any text: as if this server lacked it
      bytes = got.bytes;
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
  takeNewerLists(p.db, owner, copies, kinds);
}

/**
 * Of the copies read, the newest of each kind, taken in when it is newer than the one held: recorded, and a 10002's or
 * a 10063's relays and servers joined, those of the person's own it no longer names removed. Sync reads them, and so
 * does the list send just before it builds its own, so a list another app published since the last sync isn't
 * overwritten. A relay joins only when the held list didn't name it: one it named that is gone from the table was
 * removed here, and stays removed.
 */
export function takeNewerLists(db: SqlDb, owner: string, copies: NostrEvent[], kinds: number[]): void {
  for (const kind of kinds) {
    const latest = newest(copies.filter((e) => e.kind === kind && e.pubkey === owner));
    const held = db.get<{ created_at: number; raw: string | null }>("SELECT created_at, raw FROM lists WHERE owner = ? AND kind = ? AND d = ''", owner, kind);
    if (!latest || (held && held.created_at >= latest.created_at)) continue;
    recordList(db, owner, kind, latest.id, latest.created_at, JSON.stringify(latest));
    if (kind === KIND.serverList) keepListedServers(db, owner, readServerList(latest));
    if (kind !== KIND.relayList) continue;
    const entries = readRelayList(latest);
    const before = heldRelays(held?.raw ?? null);
    for (const e of entries) {
      if (before.has(e.url)) continue;
      db.run("INSERT OR IGNORE INTO relays (url, owner, read, write, source, added_by_app) VALUES (?, ?, ?, ?, 'user', 0)", e.url, owner, e.read ? 1 : 0, e.write ? 1 : 0);
    }
    // a relay of the person's own that the newer list dropped was removed elsewhere (FD 113), unless this phone
    // added it after that list was made
    const listed = new Set(entries.map((e) => e.url));
    for (const r of db.all<{ url: string; added_at: number | null }>("SELECT url, added_at FROM relays WHERE owner = ? AND source = 'user'", owner)) {
      if (!listed.has(r.url) && (r.added_at ?? 0) <= latest.created_at) db.run('DELETE FROM relays WHERE owner = ? AND url = ?', owner, r.url);
    }
  }
}

/** The relays a held 10002 names; none when there is no list or it doesn't read. */
function heldRelays(raw: string | null): Set<string> {
  try {
    return new Set(raw ? readRelayList(JSON.parse(raw) as NostrEvent).map((e) => e.url) : []);
  } catch {
    return new Set();
  }
}

/**
 * Phase 1, after the lists: the library key (F5, C§4.3). The newest record on the write relays is taken (another phone
 * may have made it first). With none on any of them, once every one has answered, a key is made here and its record
 * goes out; an identity made on this phone makes its own at its first publish instead.
 */
export async function syncLibraryKey(p: SyncPorts, owner: string): Promise<void> {
  const relays = writeRelays(p.db, owner);
  const signer = await p.signer(owner);
  if (!relays.length || !signer) return;
  const found: NostrEvent[] = [];
  let answered = 0;
  await Promise.all(relays.map(async (r) => {
    try {
      found.push(...(await p.query(r, [{ kinds: [KIND.appData], authors: [owner], '#d': [LIBRARY_KEY_D] }])));
      answered++;
    } catch {
      // unreachable: no say in whether a key exists
    }
  }));
  const latest = newest(found.filter((e) => e.pubkey === owner && e.tags.some((t) => t[0] === 'd' && t[1] === LIBRARY_KEY_D)));
  if (latest) {
    try {
      adoptLibraryKey(p.db, p.now(), owner, await readLibraryKeyEvent(signer, latest), latest.created_at);
    } catch {
      // a record that doesn't open, or a version this phone doesn't read: as if absent, and nothing is made over it
    }
  } else if (!libraryKey(p.db, owner) && answered === relays.length) {
    makeLibraryKey(p.db, p.now(), owner, p.crypto.randomBytes);
  }
  // with the key known, any save still at another address (a library from before v1.10) is queued to move
  moveToKeyedAddresses(p.db, p.now(), owner);
}

/**
 * Phase 1, phase 3 then phase 5 for the active identity. Restartable: a relay's cursors move only once it has answered
 * in full and everything collected has been applied, so a kill or a signer that didn't answer loses nothing (F14).
 */
export async function syncInbound(p: SyncPorts): Promise<SyncResult> {
  const owner = p.db.get<{ pubkey: string }>("SELECT pubkey FROM identities WHERE role = 'active'")?.pubkey;
  const signer = owner ? await p.signer(owner) : null;
  if (!owner || !signer) return { items: 0, deletions: 0, texts: 0, missing: 0, waiting: 0 };
  return syncOwner(p, owner, signer);
}

/** The same for any identity on the phone: a move collects its source's library this way (C§4.8 step 2). */
export async function syncOwner(p: SyncPorts, owner: string, signer: Signer): Promise<SyncResult> {
  await syncLists(p, owner);
  await syncLibraryKey(p, owner);
  const startedAt = p.now();
  const collected = await collect(p, owner);
  const { items, deletions, waiting } = await applyAll(p, owner, signer, collected);
  if (!waiting) for (const c of collected) setCursor(p.db, startedAt, c.relay, c.stream, owner, startedAt);
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
  return { items, deletions, texts, missing, waiting };
}
