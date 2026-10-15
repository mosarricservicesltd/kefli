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
  DEVICES_D, KIND, LIBRARY_KEY_D, LibraryKeyVersionError, T_TAG, decryptText, isSignerFailure, newest, readDevicesEvent, readItemEvent, readLibraryKeyEvent,
  readServerList, replaces,
} from '@kefli/protocol';
import { bytesToHex } from '@noble/hashes/utils.js';
import { deriveArticle, type Derived } from '../reader/blocks';
import type { CryptoPort, NostrEvent, Signer } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { absorbRecord, queueRecord } from '../data/devices';
import { KEEP_COPIES, getSetting } from '../data/settings';
import { readUserLists, settleUserLists } from './nostrSignIn';
import { markBacked } from '../data/backup';
import { TooLarge, open, serverHops } from '../net/http';
import {
  heldServerList, indexerRelays, keepListedRelays, keepListedServers, listServers, recordList, relayEntries, relaysNamed, seedGeneratedLists,
  serversNamed, writeRelays, type DefaultsLike,
} from '../data/lists';
import { adoptLibraryKey, libraryKey, makeLibraryKey, moveToKeyedAddresses } from '../data/libraryKey';
import {
  applyDeletions, applyItem, blobServers, getCursor, hashInUse, readRelays, setCursor, textCached, textMissing, textQueue,
  type Stream, type TextJob,
} from '../data/sync';

export type Filter = { kinds: number[]; authors?: string[]; '#t'?: string[]; '#d'?: string[]; '#k'?: string[]; '#p'?: string[]; since?: number; until?: number; limit?: number };

export type SyncPorts = {
  db: SqlDb;
  now: () => number;
  signer: (pubkey: string) => Promise<Signer | null>;
  /**
   * The events matching filters once the relay has sent EOSE; throws when the relay can't be reached or doesn't finish
   * its answer (net/pool CutShort), so a page is whole or the read fails, and a cursor never moves past a cut.
   */
  query: (relay: string, filters: Filter[]) => Promise<NostrEvent[]>;
  fetch: typeof fetch;
  crypto: CryptoPort;
  defaults: () => Promise<DefaultsLike>;
  files: { writeText: (hash: string, markdown: string, derived?: Derived) => void; removeText: (hash: string) => void; removeAll: (hash: string) => void };
  /** The article open in the Reader, whose remote position waits. */
  openHash?: () => string | null;
  onHeldWord?: (hash: string, word: number) => void;
  /** The local stack's build (services/config.ts LOCAL_STACK), whose blob servers a redirect may reach on loopback. */
  localStack?: boolean;
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

/**
 * Whether an event is dated more than SKEW past this phone's clock, which it then waits for, unread. Relays refuse
 * events that far ahead (strfry's 15 minutes), and one taken dates every later change past it, a list (nextListTime),
 * a kind 5 (after the newest version), a save (max(now, last + 1)), which those relays refuse in turn; a kind 5 dated
 * 2100 would also delete the save made again tomorrow. The phone's clock is near enough to go by: the operator's API
 * takes a NIP-98 header only within 60 s of its own (C§6).
 */
export const notYet = (e: { created_at: number }, now: number) => e.created_at > now + SKEW;

/** An addressable event's address (NIP-01: kinds 30000 to 39999, by author and d), at which only the newest counts. */
const addressOf = (e: NostrEvent) => (e.kind >= 30_000 && e.kind < 40_000 ? `${e.kind}:${e.pubkey}:${e.tags.find((t) => t[0] === 'd')?.[1] ?? ''}` : null);

/**
 * A relay's events for base, paged back by until. Of an addressable event, only the newest version read is kept
 * (replaces), which is all any reader of these uses: an archival relay, or a hostile one that kept everything, answered
 * a first read with every version of every save, 30,000 events (57 MB) for 300 saves of 100 versions each, and up to
 * MAX_PAGES answers a relay, all held at once. Every id read is still counted, so paging goes on as before. Given now,
 * an event dated past it by more than SKEW is left out (notYet), so the newest version kept is one that is due. A page
 * the relay cuts short throws here as the query does (net/pool CutShort), rather than passing for an answer: one cut
 * before anything new came was read as the stream's end, and the cursor moved past every event beneath it.
 */
export async function pageStream(query: SyncPorts['query'], relay: string, base: Filter, now = Infinity): Promise<NostrEvent[]> {
  const read: StreamRead = { ids: new Set(), kept: new Map() };
  let until: number | undefined;
  for (let i = 0; MAX_PAGES > i; i++) {
    const page = await query(relay, [{ ...base, limit: PAGE, ...(until === undefined ? {} : { until }) }]);
    const taken = takePage(read, page, now, until ?? Infinity);
    if (taken.fresh === 0) break;
    // The next page's until is the oldest seen, inclusive: events sharing that second aren't skipped.
    until = taken.oldest;
  }
  return [...read.kept.values()];
}

/** What a stream has read (pageStream): every id, and the newest due version kept at each address. */
type StreamRead = { ids: Set<string>; kept: Map<string, NostrEvent> };

/** One page taken into what the stream has read: how many of its events were new, and the oldest of them all, or from. */
function takePage(read: StreamRead, page: NostrEvent[], now: number, from: number): { fresh: number; oldest: number } {
  let fresh = 0;
  let oldest = from;
  for (const e of page) {
    oldest = Math.min(oldest, e.created_at);
    if (read.ids.has(e.id)) continue;
    read.ids.add(e.id);
    fresh++;
    const at = addressOf(e) ?? e.id;
    const held = read.kept.get(at);
    if (!notYet(e, now) && (!held || replaces(e, held))) read.kept.set(at, e);
  }
  return { fresh, oldest };
}

export function streamFilter(stream: Stream, owner: string, since: number | null): Filter {
  const base: Filter = stream === 'items'
    ? { kinds: [KIND.appData], authors: [owner], '#t': [T_TAG] }
    : { kinds: [KIND.deletion], authors: [owner], '#k': [String(KIND.appData)] };
  return since === null ? base : { ...base, since: Math.max(0, since - SKEW) };
}

type Collected = { relay: string; stream: Stream; events: NostrEvent[] };

/** The oldest of the relays' saves cursors, or null while any relay's saves are read from the start. */
function savesFloor(p: SyncPorts, owner: string, relays: string[]): number | null {
  const saves = relays.map((r) => getCursor(p.db, r, 'items', owner)?.since ?? null);
  return saves.includes(null) ? null : Math.min(...(saves as number[]));
}

/**
 * Where a stream's read starts, null for the start: its own cursor, but a deletions read from no later than the oldest
 * saves cursor (savesFloor), so a save a relay still holds can't come back past a kind 5 the deletions reads have moved
 * beyond. While any relay's saves are read from the start (one just added, say), every relay's deletions are too (F35);
 * while one relay's saves read lags, cut short (net/pool CutShort) or unanswered while the deletions were read whole and
 * their cursors moved on, they are read from its cursor: read from their own, a save deleted meanwhile came back from
 * that relay with its kind 5 more than a day before every deletions read.
 */
function readsFrom(p: SyncPorts, owner: string, relay: string, stream: Stream, floor: number | null): number | null {
  const own = getCursor(p.db, relay, stream, owner)?.since ?? null;
  if (stream === 'items' || own === null) return own;
  return floor === null ? null : Math.min(own, floor);
}

async function collect(p: SyncPorts, owner: string): Promise<Collected[]> {
  const relays = readRelays(p.db, owner);
  const jobs = relays.flatMap((relay) => (['items', 'deletions'] as Stream[]).map((stream) => ({ relay, stream })));
  const floor = savesFloor(p, owner, relays);
  const results = await Promise.all(
    jobs.map(async ({ relay, stream }) => {
      try {
        const since = readsFrom(p, owner, relay, stream, floor);
        const events = await pageStream(p.query, relay, streamFilter(stream, owner, since), p.now());
        return { relay, stream, events };
      } catch {
        return null; // unreachable, or an answer cut short: its cursor stays, and the next trigger asks again
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

/**
 * The newest event at each address (NIP-01: the later created_at, a tie to the lower id), the only one of an address's
 * versions that can win, so the only one opened (4.5, C§8): an archival relay replaying every old version of a save,
 * or one that ignores since, would otherwise ask the signer once a version at every sync, and two saves another client
 * put at one address would both become rows.
 */
function newestAt(events: NostrEvent[]): NostrEvent[] {
  const best = new Map<string, NostrEvent>();
  for (const e of events) {
    const d = e.tags.find((t) => t[0] === 'd')?.[1] ?? '';
    const held = best.get(d);
    if (!held || replaces(e, held)) best.set(d, e);
  }
  return [...best.values()];
}

const isRecord = (e: NostrEvent) => e.tags.some((t) => t[0] === 'd' && t[1] === DEVICES_D);

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
  // an event dated more than a day ahead waits for its time, unread and unapplied (notYet)
  const due = (e: NostrEvent) => !notYet(e, p.now());
  const unique = (s: Stream) => [...new Map(collected.filter((c) => c.stream === s).flatMap((c) => c.events).filter(due).map((e) => [e.id, e])).values()];
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
  const [, saves] = partition(unique('items'), isRecord);
  // each relay's newest copy of the record, every one merged in (C§4.9)
  const records = [...new Map(collected.filter((c) => c.stream === 'items').flatMap((c) => newestAt(c.events.filter((e) => isRecord(e) && due(e)))).map((e) => [e.id, e])).values()];
  await absorbRecords(p, owner, signer, records, open);
  // the event a row already holds merges as keep (4.5), so the day of overlap (F36) is read without asking the signer
  const held = new Set(p.db.all<{ event_id: string }>('SELECT event_id FROM items WHERE owner = ? AND event_id IS NOT NULL', owner).map((r) => r.event_id));
  for (const e of newestAt(saves).filter((x) => !held.has(x.id)).sort((a, b) => a.created_at - b.created_at)) {
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
  for (const hash of applyDeletions(p.db, owner, unique('deletions'))) {
    deletions++;
    if (!hashInUse(p.db, hash)) p.files.removeAll(hash);
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
 * the server can't be reached or doesn't finish within TEXT_TIMEOUT_MS, and when it redirects where no hop may go
 * (net/http serverHops): a server named by a save or a 10063, the person's own or another app's, sent the phone on
 * to 192.168.1.1 as OkHttp followed it, and is now as one that doesn't answer.
 */
async function getBlob(p: SyncPorts, url: string): Promise<Got> {
  const o = await open(p.fetch, url, { method: 'GET' }, TEXT_TIMEOUT_MS, serverHops(p.localStack === true));
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

/** A row's text servers as written, or none if they don't read. */
function namedServers(job: TextJob): unknown[] {
  try {
    const named: unknown = job.text_servers ? JSON.parse(job.text_servers) : [];
    return Array.isArray(named) ? named : [];
  } catch {
    return [];
  }
}

/**
 * What one sync has found of the blob servers: one not answering (Infinity), or how many times one sent bytes that
 * weren't the blob asked for. Kept a sync, so a server can't cost it once a text (fetchText).
 */
export type Strikes = Map<string, number>;
/** How many blobs a server may answer with other bytes before the rest of the sync stops asking it. */
const WRONG_BYTES_MAX = 2;

/**
 * What a server's answer for a blob is: the blob asked for (its sha256); another's bytes; 'lacks', not there or larger
 * than any text; or 'down', not reached or not finished in time (status 0), 5xx or 429.
 */
function answerOf(got: Got, sha256: string, crypto: CryptoPort): 'blob' | 'other' | 'lacks' | 'down' {
  if (got.status === 0 || got.status >= 500 || got.status === 429) return 'down';
  if (got.status < 200 || got.status > 299 || !got.bytes) return 'lacks';
  return bytesToHex(crypto.sha256(got.bytes)) === sha256 ? 'blob' : 'other';
}

/**
 * One server's copy of a text's blob: its bytes, which are the blob asked for; 'lacks', not there, larger than any
 * text, or other bytes; or 'down' (answerOf). Once one is down, or has sent other bytes WRONG_BYTES_MAX times, the rest
 * of the sync doesn't ask it.
 */
async function fromServer(p: SyncPorts, server: string, sha256: string, strikes: Strikes): Promise<Uint8Array | 'lacks' | 'down'> {
  const struck = strikes.get(server) ?? 0;
  if (struck >= WRONG_BYTES_MAX) return 'down';
  const got = await getBlob(p, `${server}/${sha256}`).catch((): Got => ({ status: 0, bytes: null }));
  const answer = answerOf(got, sha256, p.crypto);
  if (answer === 'blob') return got.bytes!;
  if (answer === 'other') strikes.set(server, struck + 1);
  if (answer !== 'down') return 'lacks';
  strikes.set(server, Infinity);
  return 'down';
}

/**
 * One text from its servers, then the identity's 10063 servers: 'ok', 'missing' everywhere, or 'offline'. At most
 * TEXT_SERVERS_MAX of them, http(s) only (blobServers), however many the save or the lists name. strikes is what the
 * sync has found of the servers (Strikes): asked again for each text, one that accepts and never answers held a sync a
 * minute a text, 30 minutes for 30 and hours for a restored library, while every later sync waited on it, and one
 * sending up to 20 MB of other bytes, as a mirror gone bad can, cost that much a text. A text whose servers are down is
 * 'offline', and asked for at the next sync. The blob asked for whose key doesn't open it is 'missing' at once: every
 * server holding it holds the same bytes, which were fetched again from each.
 */
export async function fetchText(p: SyncPorts, job: TextJob, strikes?: Strikes): Promise<'ok' | 'missing' | 'offline'> {
  const struck: Strikes = strikes ?? new Map();
  // the 10063 as published is asked as well as the rows kept from it (C§8, F37); each server once, slash or not
  const servers = blobServers([...namedServers(job), ...listServers(p.db, job.owner), ...heldServerList(p.db, job.owner)]);
  let unreachable = 0;
  for (const server of servers) {
    const bytes = await fromServer(p, server, job.text_sha256, struck);
    if (bytes === 'down') unreachable++;
    if (typeof bytes === 'string') continue;
    let markdown: string;
    try {
      markdown = await decryptText(bytes, { sha256: job.text_sha256, key: job.text_key, nonce: job.text_nonce }, p.crypto);
    } catch {
      // the blob named, which its key doesn't open: no other server's copy would open either
      unreachable = 0;
      break;
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
  takeNewerLists(p.db, owner, copies, kinds, p.now());
}

/**
 * Of the copies read, the newest of each kind, taken in when it is newer than the one held: recorded, and a 10002's or
 * a 10063's relays and servers joined, those of the person's own it no longer names removed (data/lists
 * keepListedRelays, keepListedServers). Sync reads them, and so does the list send just before it builds its own, so a
 * list another app published since the last sync isn't overwritten. A relay or a server joins only when the held list
 * didn't name it, every entry of it read, past the LIST_MAX Kefli uses: one it named that is gone from the table was
 * removed here, and stays removed. Given now, a copy dated more than a day past it waits for its time (notYet): taken,
 * it froze the lists, every later one being older and every one sent from here dated after it.
 */
export function takeNewerLists(db: SqlDb, owner: string, copies: NostrEvent[], kinds: number[], now = Infinity): void {
  for (const kind of kinds) {
    const latest = newest(copies.filter((e) => e.kind === kind && e.pubkey === owner && !notYet(e, now)));
    const held = db.get<{ created_at: number; raw: string | null }>("SELECT created_at, raw FROM lists WHERE owner = ? AND kind = ? AND d = ''", owner, kind);
    if (!latest || (held && held.created_at >= latest.created_at)) continue;
    recordList(db, owner, kind, latest.id, latest.created_at, JSON.stringify(latest));
    const raw = held?.raw ?? null;
    if (kind === KIND.serverList) keepListedServers(db, owner, readServerList(latest), serversNamed(raw));
    if (kind === KIND.relayList) keepListedRelays(db, owner, latest, relaysNamed(raw));
  }
}

/**
 * Phase 1, after the lists: the library key (F5, C§4.3). The newest record on the write relays is taken (another phone
 * may have made it first). With none on any of them, once every one has answered, a key is made here and its record
 * goes out; an identity made on this phone makes its own at its first publish instead. The record opens with the
 * signer the sync was given for owner: a move's target is not the phone's identity until the move ends, and asked of
 * the ports, which answer for the phone's identity alone, its key was never learnt, so every copy of the switch waited
 * on it, unsent, and the move never finished.
 */
export async function syncLibraryKey(p: SyncPorts, owner: string, signer: Signer): Promise<void> {
  const relays = writeRelays(p.db, owner);
  if (!relays.length) return;
  const found: NostrEvent[] = [];
  let answered = 0;
  await Promise.all(relays.map(async (r) => {
    try {
      found.push(...(await p.query(r, [{ kinds: [KIND.appData], authors: [owner], '#d': [LIBRARY_KEY_D] }])));
      answered++;
    } catch {
      // unreachable, or an answer cut short: no say in whether a key exists
    }
  }));
  const records = [...new Map(found.filter((e) => e.pubkey === owner && e.tags.some((t) => t[0] === 'd' && t[1] === LIBRARY_KEY_D)).map((e) => [e.id, e])).values()];
  if (records.length) await takeLibraryKey(p, owner, signer, records);
  else if (!libraryKey(p.db, owner) && answered === relays.length) makeLibraryKey(p.db, p.now(), owner, p.crypto.randomBytes);
  // with the key known, any save still at another address (a library from before v1.10) is queued to move
  moveToKeyedAddresses(p.db, p.now(), owner);
}

/**
 * The newest record that reads is taken (F5): one another client spoilt (no JSON object, no 64-hex key) gives way to
 * the one before it, which other relays may still hold; taking the newest alone, a restored phone never learnt the key,
 * and held every save it made, unsent, for good. A record dated more than a day ahead waits for its time (notYet);
 * one of a version this phone doesn't read, or a signer that doesn't answer, stops it there, as before. Whatever
 * stops it, no key is made over a record the relays hold.
 */
async function takeLibraryKey(p: SyncPorts, owner: string, signer: Signer, records: NostrEvent[]): Promise<void> {
  const due = records.filter((e) => !notYet(e, p.now())).sort((a, b) => (replaces(a, b) ? -1 : replaces(b, a) ? 1 : 0));
  for (const e of due) {
    try {
      adoptLibraryKey(p.db, p.now(), owner, await readLibraryKeyEvent(signer, e), e.created_at);
      return;
    } catch (err) {
      if (isSignerFailure(err) || err instanceof LibraryKeyVersionError) return;
    }
  }
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
  await syncLibraryKey(p, owner, signer);
  const startedAt = p.now();
  const collected = await collect(p, owner);
  const { items, deletions, waiting } = await applyAll(p, owner, signer, collected);
  if (!waiting) for (const c of collected) setCursor(p.db, startedAt, c.relay, c.stream, owner, startedAt);
  // a save seen on a relay the operator doesn't run is backed up there (FD 93)
  const operator = (await p.defaults()).operator.relay;
  for (const c of collected) if (c.stream === 'items' && c.relay !== operator) for (const e of c.events) markBacked(p.db, e.id);
  let texts = 0;
  let missing = 0;
  const strikes: Strikes = new Map();
  for (const job of textQueue(p.db, owner, p.openHash?.())) {
    const r = await fetchText(p, job, strikes);
    if (r === 'ok') texts++;
    if (r === 'missing') missing++;
  }
  return { items, deletions, texts, missing, waiting };
}
