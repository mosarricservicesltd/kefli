// Sync's phase 4, the inbox (mobile spec 4.7, contract 4.4): gift wraps for this identity on the operator relay,
// read after AUTH from 172,800 + 300 seconds before the last drain (NIP-59 lets a wrap's created_at lie up to two
// days back). Each is unwrapped and judged once:
//   - anything but a kind 30078 save request is someone else's message: ignored_foreign;
//   - unreadable JSON is failed_parse, a version not understood ignored_version (C§10);
//   - a token that isn't a connected entry of the record, or a seal by another key: ignored_token.
// An accepted request becomes a save. Its HTML, when there is some, comes from the operator Blossom server only,
// capped and checked against its sha256: Readability's content HTML, which the canonical Markdown conversion
// (kefliMarkdown) turns into the save's text, with the title and the rest as the extension read them; a blob that can't be read is failed_blob and
// tried again from wrap_json at each drain. Only created, merged and unarchived queue delete_wrap; every other
// wrap is left, so a phone without the record yet can't remove a save another phone still needs.
//
// RULED: a request naming another server for its HTML is taken without it, and the page is fetched instead, so a
// save from a connected browser is never lost to a bad field.
import {
  KIND, SAVE_REQUEST_MAX_BYTES, UnwrapError, acceptSaveRequest, decryptText, eventBytes, opensWraps, unwrap, type DevicesRecord, type NostrEvent,
  type Rumor, type SaveRequest, type Signer,
} from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { localRecord } from '../data/devices';
import {
  INBOX_BLOB_LIFE, admit, endInboxScan, failedBlobs, forgetIgnored, giveUpBlob, inboxScan, keepInboxScan, noteDeviceSave, queueDeleteWrap,
  recordSeen, seenState, waitingSince, type InboxScan, type Outcome,
} from '../data/inbox';
import type { Pending } from '../data/pending';
import type { SaveTargets } from '../data/saves';
import { getCursor, setCursor } from '../data/sync';
import { deriveArticle } from '../reader/blocks';
import type { PageOutcome, ParserResult } from './page';
import { settle, type PendingPorts } from './pending';
import { PAGE, type Filter } from './sync';
import { TooLarge, open } from '../net/http';

/** The extension's 2 MB of HTML plus the GCM tag. */
export const INBOX_MAX_BYTES = 2 * 1_048_576 + 16;
export const WRAP_LOOKBACK = 172_800 + 300;
/** How long a wrap the signer can't open, or that can't be taken, keeps the inbox's cursor waiting for it (F3). */
export const WRAP_PATIENCE = 7 * 86_400;
// the week runs from the first drain that tried the wrap (waitingSince), whatever its created_at says: NIP-59 backdates
// it, the phone may first see it late, and one dated ahead would otherwise wait as long as its date said
const stale = (p: InboxPorts, owner: string, w: NostrEvent) => p.now() - waitingSince(p.db, p.now(), w.id, owner) > WRAP_PATIENCE;

export type InboxPorts = Pick<PendingPorts, 'db' | 'now' | 'crypto' | 'stage' | 'unstage' | 'writeText' | 'targets'> & {
  signer: Signer;
  query: (relay: string, filters: Filter[]) => Promise<NostrEvent[]>;
  fetch: typeof fetch;
  /** kefliMarkdown in the parser WebView (C§4.4). */
  markdown: (contentHtml: string, url: string) => Promise<ParserResult>;
  defaults: () => Promise<{ operator: { relay: string; blossom: string } }>;
};

export type InboxResult = Partial<Record<Outcome, number>>;

type Judged = { outcome: Exclude<Outcome, 'created' | 'merged' | 'unarchived' | 'failed_blob'> } | { request: SaveRequest; label: string; token: string };

/**
 * The rules of 4.7's steps 1 and 2 for an opened wrap. A request whose address isn't a link is failed_parse: no save
 * can be made from it, and taking it would fail the same way at every drain. devices is the connected-browsers
 * record, read once a drain rather than once a wrap.
 */
export function judge(db: SqlDb, owner: string, rumor: Rumor, seal: NostrEvent, operatorBlossom: string, devices = localRecord(db, owner)): Judged {
  let v = acceptSaveRequest(rumor, seal, devices, operatorBlossom);
  if (!v.ok && v.reason === 'server') {
    const r = JSON.parse(rumor.content) as SaveRequest;
    v = acceptSaveRequest({ ...rumor, content: JSON.stringify({ ...r, html: null }) }, seal, devices, operatorBlossom);
  }
  if (v.ok) return { request: v.request, label: v.device.label, token: v.device.token };
  if (v.reason === 'other') return { outcome: 'ignored_foreign' };
  if (v.reason === 'malformed') return { outcome: 'failed_parse' };
  if (v.reason === 'version') return { outcome: readable(rumor.content) ? 'ignored_version' : 'failed_parse' };
  return { outcome: 'ignored_token' };
}

function readable(json: string): boolean {
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
}

/**
 * The save's text from the browser's content HTML (C§4.4): the canonical Markdown conversion, with the metadata the
 * extension read from the live page. The extension applied the guard before sending HTML, so it isn't applied again.
 */
export async function fromBrowser(p: Pick<InboxPorts, 'markdown'>, r: SaveRequest, contentHtml: string): Promise<Exclude<PageOutcome, { kind: 'offline' }>> {
  const m = await p.markdown(contentHtml, r.url).catch((): ParserResult => ({ ok: false, reason: 'error' }));
  if (!m.ok) return { kind: 'failed', reason: 'not_readable', finalUrl: r.url };
  const derived = deriveArticle(m.markdown);
  const result = { ...m, title: r.title, byline: r.byline, site: r.site, lang: r.lang, hero: r.hero, canonical: r.canonical, readerable: true };
  return { kind: 'parsed', finalUrl: r.url, result, words: derived.words, spoken: derived.spoken, derived };
}

/** How long the inbox blob's server has to send the whole blob, as for a text (F12). */
export const INBOX_TIMEOUT_MS = 60_000;

/**
 * What reading an inbox blob came to: its HTML; 'missing', the server answering without it (404 and the like);
 * 'unreachable', the server not answering in time, or with 5xx or 429; or 'bad', bytes that can't be this capture
 * (larger than any capture is, another blob's, or ones its key doesn't open as UTF-8), which no later try changes.
 */
export type BlobRead = { html: string } | { failed: 'missing' | 'unreachable' | 'bad' };

/**
 * The inbox blob's HTML, or why not. The deadline covers the whole body and the cap is counted as it streams
 * (net/http, F12), so a server that trickles or never ends can't hold the inbox.
 */
export async function fetchBlob(p: Pick<InboxPorts, 'fetch' | 'crypto'>, html: NonNullable<SaveRequest['html']>): Promise<BlobRead> {
  let blob: Uint8Array;
  try {
    const o = await open(p.fetch, `${html.server.replace(/\/+$/, '')}/${html.sha256}`, { method: 'GET' }, INBOX_TIMEOUT_MS);
    if (!o.res.ok) {
      o.done();
      return { failed: o.res.status >= 500 || o.res.status === 429 ? 'unreachable' : 'missing' };
    }
    blob = await o.read(INBOX_MAX_BYTES);
  } catch (e) {
    return { failed: e instanceof TooLarge ? 'bad' : 'unreachable' };
  }
  try {
    const text = await decryptText(blob, { sha256: html.sha256, key: html.key, nonce: html.nonce }, p.crypto);
    return new TextEncoder().encode(text).length > INBOX_MAX_BYTES - 16 ? { failed: 'bad' } : { html: text };
  } catch {
    return { failed: 'bad' };
  }
}

/** The inbox blob's HTML, or null when it can't be had or doesn't check out. */
export async function readBlob(p: Pick<InboxPorts, 'fetch' | 'crypto'>, html: NonNullable<SaveRequest['html']>): Promise<string | null> {
  const got = await fetchBlob(p, html);
  return 'html' in got ? got.html : null;
}

function pendingRow(db: SqlDb, owner: string, hash: string): Pending | undefined {
  return db.get<Pending>('SELECT id, hash, url, shared_url, published, event_id, x_state FROM items WHERE owner = ? AND hash = ?', owner, hash);
}

/**
 * What one drain learns as it goes: the connected-browsers record, read once; how many wraps it has opened; whether
 * the signer has stopped answering, and whether it has opened anything since it last didn't; and whether the Blossom
 * server has stopped answering, after which the drain's other blobs wait for the next drain rather than each waiting
 * out the deadline.
 */
type Drain = { devices: DevicesRecord; opens: number; waiting: boolean; answered: boolean; blobsDown: boolean };

/**
 * An accepted request, made a save; its HTML read and parsed when it brings some. A blob that can't be this capture
 * is given up at once, and the page fetched instead, as once one has expired: trying again would only fetch the same
 * bytes, up to 2 MB of them, at every drain for two weeks.
 */
async function take(p: InboxPorts, owner: string, wrapId: string, j: Extract<Judged, { request: SaveRequest }>, wrapJson: string, retry: boolean, drain: Drain): Promise<Outcome> {
  const d = await p.defaults();
  const t: SaveTargets = await p.targets();
  const a = admit(p.db, p.now(), owner, j.request, j.label, t);
  const seen = { owner, requestD: null, device: j.token, hash: a.hash };
  if (a.fetch) {
    const got: BlobRead = drain.blobsDown ? { failed: 'unreachable' } : await fetchBlob(p, j.request.html!);
    if ('failed' in got && got.failed !== 'bad') {
      if (got.failed === 'unreachable') drain.blobsDown = true;
      recordSeen(p.db, p.now(), wrapId, { ...seen, outcome: 'failed_blob', wrapJson });
      return 'failed_blob';
    }
    const item = pendingRow(p.db, owner, a.hash);
    if ('html' in got) {
      if (item) await settle(p, owner, item, await fromBrowser(p, j.request, got.html));
    } else giveUpBlob(p.db, owner, a.hash);
  }
  // A retried wrap finds the save it made itself: still its creation.
  const outcome = retry && a.outcome === 'merged' ? 'created' : a.outcome;
  noteDeviceSave(p.db, p.now(), owner, j.token);
  recordSeen(p.db, p.now(), wrapId, { ...seen, outcome });
  queueDeleteWrap(p.db, p.now(), owner, wrapId, d.operator.relay);
  return outcome;
}

/**
 * The longest d kept with a wrap's outcome: kefli/save-request/ and a uuid is 55. Anyone can send a wrap whose rumor's
 * d runs to 9 KB, and the outcome of each was kept with it, up to 260 MB a day under the most the relay lets everyone
 * together send one person (C§3.2).
 */
const REQUEST_D_MAX = 128;

async function handle(p: InboxPorts, owner: string, wrapId: string, rumor: Rumor, seal: NostrEvent, blossom: string, drain: Drain, retry = false): Promise<Outcome> {
  const j = judge(p.db, owner, rumor, seal, blossom, drain.devices);
  const d = rumor.tags.find((x) => x[0] === 'd')?.[1] ?? null;
  if ('outcome' in j) {
    const requestD = j.outcome === 'ignored_foreign' || d === null || d.length > REQUEST_D_MAX ? null : d;
    recordSeen(p.db, p.now(), wrapId, { owner, outcome: j.outcome, requestD });
    return j.outcome;
  }
  return take(p, owner, wrapId, j, JSON.stringify({ rumor, seal }), retry, drain);
}

/**
 * Blobs that failed before: tried again from the kept rumor; past the blob's life, or once the request is no longer
 * taken (its browser disconnected since), the page is fetched instead, so the save doesn't wait on a blob for ever.
 * Each is tried on its own: one whose taking fails (the network, the database) stays failed_blob for the next drain,
 * and the drain goes on to the wraps that came since. Once the server hasn't answered, the rest wait unasked.
 */
async function retryBlobs(p: InboxPorts, owner: string, blossom: string, out: InboxResult, drain: Drain): Promise<void> {
  for (const row of failedBlobs(p.db, owner)) {
    try {
      const { rumor, seal } = JSON.parse(row.wrap_json) as { rumor: Rumor; seal: NostrEvent };
      const j = judge(p.db, owner, rumor, seal, blossom, drain.devices);
      const expired = 'request' in j && p.now() >= j.request.captured_at + INBOX_BLOB_LIFE;
      if (!expired && 'request' in j && drain.blobsDown) continue;
      if (!('request' in j) || expired) {
        const hash = p.db.get<{ hash: string }>('SELECT hash FROM inbox_seen WHERE wrap_id = ?', row.wrap_id)?.hash;
        if (hash) giveUpBlob(p.db, owner, hash);
      }
      const o = await handle(p, owner, row.wrap_id, rumor, seal, blossom, drain, true);
      out[o] = (out[o] ?? 0) + 1;
    } catch {
      // left as it is, for the next drain
    }
  }
}

/**
 * How many of the relay's answers a drain reads back through its window. The relay sends the newest wraps first, at
 * most PAGE an answer, and anyone can send wraps nobody takes, which stay on it: read in one answer, as it was, 500
 * newer ones hid every browser save beneath them for good. Ten answers reach beneath 5,000, more than a day and a
 * half of the most one address may send one person (C§3.2: 120 an hour).
 */
export const INBOX_PAGES = 10;
/**
 * How often a drain reads back past the newest answer while the window holds more than one: at most every quarter
 * of an hour, the background drain's own interval, so a flood that sets off a drain for every wrap it sends (the
 * live subscription) can't make each of them read ten answers.
 */
export const INBOX_DEEP_EVERY = 15 * 60;
/** The most wraps one drain opens, two decrypts each: the rest wait for the next drain, the cursor staying. */
export const INBOX_UNWRAPS = PAGE;

/** relay and owner → when a drain last read back through a full window. */
const readDeep = new Map<string, number>();

/**
 * What a drain read: the wraps no drain has judged that could hold a save request, in the order they are opened
 * (unjudged); the time the cursor may move to once they are all opened, null while the read didn't reach the window's
 * end; and the scan still under way (InboxScan), which a wrap left unopened marks.
 */
type WindowRead = { wraps: NostrEvent[]; upTo: number | null; scan: InboxScan | null };

/**
 * A wrap the size of a save request's limit or more can't hold one (C§4.4: under 8 KB, which the extension keeps to),
 * so it is neither opened, two decrypts a bunker answers over the network, nor kept: a flood of 16 KB wraps kept 80 MB
 * a deep read.
 */
const mayHoldRequest = (w: NostrEvent) =>
  w.kind === KIND.giftWrap && w.content.length < SAVE_REQUEST_MAX_BYTES && eventBytes(w) < SAVE_REQUEST_MAX_BYTES;

const oldestOf = (page: NostrEvent[]) => page.reduce((t, e) => Math.min(t, e.created_at), Infinity);

/**
 * The window's wraps, newest answer first, paged back by until as sync pages (NIP-01). The newest answer is always
 * read; one short of PAGE is the whole window, the operator's strfry answering at most PAGE (its maxFilterLimit).
 * While the last deep read is old enough, up to INBOX_PAGES - 1 more answers go on down the window from where the
 * last deep read stopped (InboxScan), so every part of a window too large for one deep read is read in turn. A full
 * answer that brings nothing new is a second holding more wraps than an answer, as a flood all dated to one second
 * makes, and is stepped past; any other answer that brings nothing new is the window's end. Only a read that reached it
 * moves the cursor (WindowRead.upTo), and a scan only once no wrap it read was left unopened: moved past wraps it never
 * read or left unopened, as a drain reading the newest answer alone moved it, the cursor dropped a save beneath a flood
 * out of the window for good.
 */
async function readWindow(p: InboxPorts, relay: string, owner: string, since: number | undefined, now: number): Promise<WindowRead> {
  const key = `${relay} ${owner}`;
  const base = { kinds: [KIND.giftWrap], '#p': [owner], ...(since === undefined ? {} : { since: Math.max(0, since - WRAP_LOOKBACK) }) };
  const ask = (until?: number) => p.query(relay, [{ ...base, limit: PAGE, ...(until === undefined ? {} : { until }) }]);
  const read = unjudged(p.db);
  const first = await ask();
  read.take(first);
  const whole = first.length < PAGE;
  if (whole) endInboxScan(p.db, relay, owner);
  if (!first.length || now - (readDeep.get(key) ?? -Infinity) < INBOX_DEEP_EVERY) {
    return { wraps: read.wraps(), upTo: whole ? now : null, scan: whole ? null : inboxScan(p.db, relay, owner) };
  }
  readDeep.set(key, now);
  const held = inboxScan(p.db, relay, owner);
  // a scan goes on beneath the newest answer, which this read has just had
  const scan = { until: Math.min(held?.until ?? Infinity, oldestOf(first)), startedAt: held?.startedAt ?? now, left: held?.left ?? false };
  for (let i = 1; i < INBOX_PAGES; i++) {
    const page = await ask(scan.until);
    const fresh = read.take(page);
    if (!fresh && page.length < PAGE) {
      endInboxScan(p.db, relay, owner);
      return { wraps: read.wraps(), upTo: scan.left ? null : scan.startedAt, scan: null };
    }
    scan.until = fresh ? oldestOf(page) : oldestOf(page) - 1;
  }
  keepInboxScan(p.db, relay, owner, scan);
  return { wraps: read.wraps(), upTo: null, scan };
}

/**
 * After a wrap the signer didn't open: whether it is still answering. One that opened a wrap since it last didn't is;
 * otherwise it is asked to open a probe (opensWraps). A signer that isn't answering would fail every other wrap the
 * same way, two minutes each for a bunker, so they wait unasked, as sync's do (F14). One that answers failed this wrap
 * alone, as anyone can make a wrap do (a ciphertext a bunker never replies to, a resolver that returns nothing for
 * it): stopping there, as every drain retried that wrap first, held every browser save behind it for a week.
 */
async function stillAnswering(p: InboxPorts, owner: string, drain: Drain): Promise<boolean> {
  const answering = drain.answered || (await opensWraps(p.signer, owner));
  drain.answered = false;
  return answering;
}

/**
 * One wrap opened and judged (4.7), or 'held' for the next drain. The signer couldn't answer (out of sight, timed out,
 * declined): the wrap waits, unrecorded but for when it was first tried, and the cursor stays so it is fetched again
 * (F3); unless the signer is still answering (stillAnswering), the drain's other wraps wait unasked. Taking it failed
 * part way (the network, the database): it is tried again at the next drain. Either way, one still failing a week
 * after its first try is filed as not ours.
 */
async function openOne(p: InboxPorts, owner: string, w: NostrEvent, blossom: string, drain: Drain): Promise<Outcome | 'held'> {
  drain.opens++;
  let opened: Awaited<ReturnType<typeof unwrap>>;
  try {
    opened = await unwrap(p.signer, w);
    drain.answered = true;
  } catch (e) {
    if (!(e instanceof UnwrapError)) {
      if (!(await stillAnswering(p, owner, drain))) drain.waiting = true;
      if (!stale(p, owner, w)) return 'held';
    }
    // not a wrap this key opens: someone else's message sharing the p tag
    recordSeen(p.db, p.now(), w.id, { owner, outcome: 'ignored_foreign' });
    return 'ignored_foreign';
  }
  try {
    return await handle(p, owner, w.id, opened.rumor, opened.seal, blossom, drain);
  } catch {
    if (!stale(p, owner, w)) return 'held';
    recordSeen(p.db, p.now(), w.id, { owner, outcome: 'ignored_foreign' });
    return 'ignored_foreign';
  }
}

const byAge = (a: NostrEvent, b: NostrEvent) => a.created_at - b.created_at;

/**
 * What a read keeps: each wrap once (take returns how many of an answer were new to the read), and only one that may
 * hold a request (mayHoldRequest) and that no drain has judged, so what was read before costs no memory. wraps() is
 * the order they are opened: those never tried, oldest first, then those already waiting (a signer that didn't open
 * them, a taking that failed), so that wraps which keep failing, which anyone can send, are tried after the drain's
 * other wraps rather than spending its budget ahead of them.
 */
function unjudged(db: SqlDb) {
  const ids = new Set<string>();
  const fresh: NostrEvent[] = [];
  const tried: NostrEvent[] = [];
  const take = (page: NostrEvent[]): number => {
    let added = 0;
    for (const e of page) {
      if (ids.has(e.id)) continue;
      ids.add(e.id);
      added++;
      const state = mayHoldRequest(e) ? seenState(db, e.id) : 'ignored_foreign';
      if (state === null) fresh.push(e);
      else if (state === 'waiting') tried.push(e);
    }
    return added;
  };
  return { take, wraps: () => [...fresh.sort(byAge), ...tried.sort(byAge)] };
}

/** One drain of the inbox. Restartable: the cursor moves only after the relay answers, and as WindowRead.upTo allows. */
export async function drainInbox(p: InboxPorts, owner: string): Promise<InboxResult> {
  const out: InboxResult = {};
  const d = await p.defaults();
  const relay = d.operator.relay;
  const drain: Drain = { devices: localRecord(p.db, owner), opens: 0, waiting: false, answered: false, blobsDown: false };
  await retryBlobs(p, owner, d.operator.blossom, out, drain);
  const startedAt = p.now();
  const since = getCursor(p.db, relay, 'inbox', owner)?.since;
  let read: WindowRead;
  try {
    read = await readWindow(p, relay, owner, since, startedAt);
  } catch {
    return out; // unreachable: the cursor stays
  }
  let held = false;
  for (const w of read.wraps) {
    // once the signer hasn't answered, and past the drain's budget, the rest wait for the next drain unasked
    const o = drain.waiting || drain.opens >= INBOX_UNWRAPS ? 'held' : await openOne(p, owner, w, d.operator.blossom, drain);
    if (o === 'held') held = true;
    else out[o] = (out[o] ?? 0) + 1;
  }
  // a wrap left for the next drain keeps the scan from moving the cursor when it ends: it reads the window again
  if (held && read.scan) keepInboxScan(p.db, relay, owner, { ...read.scan, left: true });
  if (!held && read.upTo !== null) {
    setCursor(p.db, startedAt, relay, 'inbox', owner, read.upTo);
    // with the window two days back from here, outcomes from two weeks ago are of wraps no drain reads again
    forgetIgnored(p.db, p.now(), owner);
  }
  return out;
}
