// Sync's phase 4, the inbox (mobile spec 4.7, contract 4.4): gift wraps for this identity on the operator relay,
// read after AUTH from 172,800 + 300 seconds before the last drain (NIP-59 lets a wrap's created_at lie up to two
// days back). Each is unwrapped and judged once:
//   - anything but a kind 30078 save request is someone else's message: ignored_foreign;
//   - unreadable JSON is failed_parse, a version not understood ignored_version (C§10);
//   - a token that isn't a connected entry of the record, or a seal by another key: ignored_token.
// An accepted request becomes a save. Its HTML, when there is some, comes from the operator Blossom server only,
// capped and checked against its sha256: Readability's content HTML, which the canonical Markdown conversion
// (kefliMarkdown) turns into the save's text, with the title and the rest as the extension read them; a blob that can't be read is failed_blob and
// tried again from wrap_json at each drain, for the save that drain made as it stands by then, while one the operator
// answers 404 for is gone (v1.12) and one that can't be this capture is given up: either way the save fetches its page
// at once. Only created, merged and unarchived queue delete_wrap, and with it the delete of the request's inbox blob
// (v1.12); every other wrap is left, so a phone without the record yet can't remove a save another phone still
// needs. A request whose save waits on its delete's Undo waits for the next drain.
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
  admit, closeWrap, endInboxScan, failedBlobs, forgetIgnored, giveUpBlob, inboxScan, keepInboxScan, noteDeviceSave, recordSeen, requestHash,
  savedState, seenState, usesBlob, waitingSince, waitsOnDelete, type CaptureRead, type InboxScan, type Kept, type Outcome,
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
const stale = (p: InboxPorts, owner: string, wrapId: string) => p.now() - waitingSince(p.db, p.now(), wrapId, owner) > WRAP_PATIENCE;

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
 * can be made from it, and taking it would fail the same way at every drain. record, when given, is the
 * connected-browsers record, read once a drain rather than once a wrap.
 */
export function judge(db: SqlDb, owner: string, rumor: Rumor, seal: NostrEvent, operatorBlossom: string, record?: DevicesRecord): Judged {
  const devices = record ?? localRecord(db, owner);
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
 * What reading the inbox blob gave: its HTML, with the blob's size as the operator stores it; gone, when the operator
 * answers 404 for it, as for a blob that has expired, been deleted or was never taken (C§4.4, v1.12); bad, bytes that
 * can't be this capture (larger than any capture is, another blob's, or ones its key doesn't open as UTF-8), which no
 * later try changes; or failed, when it can't be had now, down when the server isn't answering (not in time, or with
 * 5xx or 429) rather than answering without it.
 */
export type BlobRead = { kind: 'html'; html: string; size: number } | { kind: 'gone' } | { kind: 'bad' } | { kind: 'failed'; down?: true };

const GONE: BlobRead = { kind: 'gone' };
const BAD: BlobRead = { kind: 'bad' };
const FAILED: BlobRead = { kind: 'failed' };
const DOWN: BlobRead = { kind: 'failed', down: true };

/** What the operator's refusal says of the blob: gone at a 404 (v1.12), the server down at a 5xx or 429. */
const refused = (status: number): BlobRead => (status === 404 ? GONE : status >= 500 || status === 429 ? DOWN : FAILED);

/**
 * The inbox blob's HTML, or why not. The deadline covers the whole body and the cap is counted as it streams
 * (net/http, F12), so a server that trickles or never ends can't hold the inbox.
 */
export async function readBlob(p: Pick<InboxPorts, 'fetch' | 'crypto'>, html: NonNullable<SaveRequest['html']>): Promise<BlobRead> {
  let blob: Uint8Array;
  try {
    const o = await open(p.fetch, `${html.server.replace(/\/+$/, '')}/${html.sha256}`, { method: 'GET' }, INBOX_TIMEOUT_MS);
    if (!o.res.ok) return (o.done(), refused(o.res.status));
    blob = await o.read(INBOX_MAX_BYTES);
  } catch (e) {
    return e instanceof TooLarge ? BAD : DOWN;
  }
  try {
    const text = await decryptText(blob, { sha256: html.sha256, key: html.key, nonce: html.nonce }, p.crypto);
    return new TextEncoder().encode(text).length > INBOX_MAX_BYTES - 16 ? BAD : { kind: 'html', html: text, size: blob.length };
  } catch {
    return BAD;
  }
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
 * The save's text from the request's inbox blob: what reading the blob gave, the save given its text when it brought
 * some. A blob the operator no longer has is gone (v1.12), and one that can't be this capture is given up, since
 * trying again would only fetch the same bytes, up to 2 MB of them, at every drain for two weeks: either way the save
 * fetches its page at once, as a request without HTML does, rather than waiting out the blob's 14 days. One that
 * failed is tried again at the next drain, and once the server isn't answering, the drain's other blobs wait unasked.
 * A save deleted while its capture was read, its delete waiting on Undo, takes nothing from it (data/pending), so the
 * read counts as failed: the wrap is kept with its capture for the retry, which waits with the save (retake). Closed
 * then, with its capture deleted, it left a save shown again at "Getting the text…" for good.
 */
async function textFromBlob(p: InboxPorts, owner: string, hash: string, r: SaveRequest, drain: Drain): Promise<BlobRead> {
  const read = drain.blobsDown ? DOWN : await readBlob(p, r.html!);
  if (read.kind === 'failed' && read.down) drain.blobsDown = true;
  if (read.kind === 'gone' || read.kind === 'bad') giveUpBlob(p.db, owner, hash);
  if (read.kind !== 'html') return read;
  const item = pendingRow(p.db, owner, hash);
  if (item) await settle(p, owner, item, await fromBrowser(p, r, read.html));
  return waitsOnDelete(p.db, owner, hash) ? FAILED : read;
}

/** A capture this drain read, for its delete: its size, and now, which is after the browser uploaded it. */
const captureRead = (read: BlobRead | null, now: number): CaptureRead | undefined => (read?.kind === 'html' ? { size: read.size, up: now } : undefined);

/**
 * An accepted request, made a save; its HTML read and parsed when it brings some. Null when its save waits on its
 * delete's Undo (RULED), until the wrap has waited a week from its first try (F3): the wrap waits for the next drain,
 * so the save it makes or matches is the one left once the delete is done or undone, not one about to go with it.
 */
async function take(p: InboxPorts, owner: string, wrapId: string, j: Extract<Judged, { request: SaveRequest }>, wrapJson: string, drain: Drain): Promise<Outcome | null> {
  if (waitsOnDelete(p.db, owner, requestHash(j.request)) && !stale(p, owner, wrapId)) return null;
  const d = await p.defaults();
  const t: SaveTargets = await p.targets();
  const a = admit(p.db, p.now(), owner, j.request, j.label, t);
  const seen = { owner, requestD: null, device: j.token, hash: a.hash };
  const read = a.fetch ? await textFromBlob(p, owner, a.hash, j.request, drain) : null;
  if (read?.kind === 'failed') {
    recordSeen(p.db, p.now(), wrapId, { ...seen, outcome: 'failed_blob', wrapJson });
    return 'failed_blob';
  }
  noteDeviceSave(p.db, p.now(), owner, j.token);
  // the save no longer needs the capture: the wrap's kind 5 and the inbox blob's delete go together (C§4.4, v1.12)
  closeWrap(p.db, p.now(), wrapId, { ...seen, outcome: a.outcome }, d.operator, j.request.html, captureRead(read, p.now()));
  return a.outcome;
}

/**
 * The longest d kept with a wrap's outcome: kefli/save-request/ and a uuid is 55. Anyone can send a wrap whose rumor's
 * d runs to 9 KB, and the outcome of each was kept with it, up to 260 MB a day under the most the relay lets everyone
 * together send one person (C§3.2).
 */
const REQUEST_D_MAX = 128;

async function handle(p: InboxPorts, owner: string, wrapId: string, rumor: Rumor, seal: NostrEvent, blossom: string, drain: Drain): Promise<Outcome | null> {
  const j = judge(p.db, owner, rumor, seal, blossom, drain.devices);
  const d = rumor.tags.find((x) => x[0] === 'd')?.[1] ?? null;
  if ('outcome' in j) {
    const requestD = j.outcome === 'ignored_foreign' || d === null || d.length > REQUEST_D_MAX ? null : d;
    recordSeen(p.db, p.now(), wrapId, { owner, outcome: j.outcome, requestD });
    return j.outcome;
  }
  return take(p, owner, wrapId, j, JSON.stringify({ rumor, seal }), drain);
}

/** Within its 14 days the blob is read again; past them the save fetches its page instead (4.7), nothing read. */
async function blobOrPage(p: InboxPorts, owner: string, hash: string, r: SaveRequest, drain: Drain): Promise<BlobRead | null> {
  if (usesBlob(r, p.now())) return textFromBlob(p, owner, hash, r, drain);
  giveUpBlob(p.db, owner, hash);
  return null;
}

/**
 * The connected-browsers record as a kept wrap's first drain read it, the browser that sent it connected, as it was
 * then. The request is read again only as acceptance cleans one (C§4.4): its captured_at no later than its rumor, so a
 * time years ahead can't keep its blob tried for ever, and every field of its type.
 */
function asTaken(record: DevicesRecord, rumor: Rumor): DevicesRecord {
  const { token } = JSON.parse(rumor.content) as { token?: unknown };
  return { v: 1, devices: record.devices.map((e) => (e.token === token ? { ...e, revoked_at: null } : e)) };
}

/**
 * A kept wrap this phone no longer reads as a request even as its first drain took it, as when an update reads its
 * address as no link: its save, if it has one, fetches its page rather than waiting on the blob for ever, and the wrap
 * keeps the outcome it is given now.
 */
function noLongerTaken(p: InboxPorts, owner: string, k: Kept, outcome: Outcome): Outcome {
  if (k.hash) giveUpBlob(p.db, owner, k.hash);
  recordSeen(p.db, p.now(), k.wrap_id, { owner, outcome });
  return outcome;
}

/**
 * A wrap whose blob couldn't be read, tried again for the save its first drain made or matched (4.7), or null while
 * that save waits on its delete's Undo: the wrap waits with it, to find the save shown again or gone. The request was
 * taken at that drain, so it is read as that drain read it (asTaken), and a browser disconnected since leaves its save
 * to finish rather than waiting for its text for ever. RULED: the save keeps what was done to it meanwhile. One
 * deleted, here or on another phone, isn't made again and one archived stays archived, since this is the same save
 * request, not a new one (the repeat-save rule, C§4.1, is for a new save). Only a save still waiting for its text reads
 * the blob; the wrap then closes as the creation it was, with its kind 5 and its capture's delete (C§4.4, v1.12).
 */
async function retake(p: InboxPorts, owner: string, k: Kept, blossom: string, drain: Drain): Promise<Outcome | null> {
  const { rumor, seal } = JSON.parse(k.wrap_json) as { rumor: Rumor; seal: NostrEvent };
  const j = judge(p.db, owner, rumor, seal, blossom, asTaken(drain.devices, rumor));
  if ('outcome' in j) return noLongerTaken(p, owner, k, j.outcome);
  const save = k.hash ? savedState(p.db, owner, k.hash) : undefined;
  if (save && save.pending_delete_at !== null) return null;
  const read = k.hash && save?.text_state === 'fetching' ? await blobOrPage(p, owner, k.hash, j.request, drain) : null;
  if (read?.kind === 'failed') {
    recordSeen(p.db, p.now(), k.wrap_id, { owner, outcome: 'failed_blob', wrapJson: k.wrap_json });
    return 'failed_blob';
  }
  const d = await p.defaults();
  noteDeviceSave(p.db, p.now(), owner, j.request.token);
  closeWrap(p.db, p.now(), k.wrap_id, { owner, outcome: 'created' }, d.operator, j.request.html, captureRead(read, p.now()));
  return 'created';
}

/**
 * Blobs that failed before, tried again from the kept rumor, each on its own. One whose retry fails part way (a disk,
 * a signer, the network, the database) stays as it was, for the next drain, and the rest and the new wraps go on.
 * Once the server hasn't answered, the rest wait unasked.
 */
async function retryBlobs(p: InboxPorts, owner: string, blossom: string, out: InboxResult, drain: Drain): Promise<void> {
  for (const k of failedBlobs(p.db, owner)) {
    const o = await retake(p, owner, k, blossom, drain).catch((): null => null);
    if (o) tally(out, o);
  }
}

function tally(out: InboxResult, o: Outcome): void {
  out[o] = (out[o] ?? 0) + 1;
}

/**
 * How many of the relay's answers a deep read takes. The relay sends the newest wraps first, at most PAGE an answer,
 * and anyone can send wraps nobody takes, which stay on it: read in one answer, as it was, 500 newer ones hid every
 * browser save beneath them for good. A deep read takes the newest answer and nine more down the window, from where
 * the last deep read stopped (InboxScan), so a window of any depth is read through in turn, 4,500 wraps a deep read.
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
 * (unjudged), and whether more were read than kept (over); the time the cursor may move to once they are all opened,
 * null while the read didn't reach the window's end; and the scan still under way (InboxScan), which a wrap left
 * unopened marks.
 */
type WindowRead = { wraps: NostrEvent[]; over: boolean; upTo: number | null; scan: InboxScan | null };

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
  const done = (upTo: number | null, scan: InboxScan | null): WindowRead => ({ wraps: read.wraps(), over: read.over(), upTo, scan });
  const first = await ask();
  read.take(first);
  const whole = first.length < PAGE;
  if (whole) endInboxScan(p.db, relay, owner);
  if (!first.length || now - (readDeep.get(key) ?? -Infinity) < INBOX_DEEP_EVERY) {
    return done(whole ? now : null, whole ? null : inboxScan(p.db, relay, owner));
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
      return done(scan.left ? null : scan.startedAt, null);
    }
    scan.until = fresh ? oldestOf(page) : oldestOf(page) - 1;
  }
  keepInboxScan(p.db, relay, owner, scan);
  return done(null, scan);
}

/**
 * This identity's wraps on the operator relay (readWindow), from 172,800 + 300 seconds before the last drain or,
 * before the first, all of them (4.7); null when the relay can't be reached.
 */
async function windowSince(p: InboxPorts, relay: string, owner: string, now: number): Promise<WindowRead | null> {
  const since = getCursor(p.db, relay, 'inbox', owner)?.since;
  try {
    return await readWindow(p, relay, owner, since, now);
  } catch {
    return null;
  }
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
 * A wrap left for the next drain, unrecorded but for when a drain first tried it (waitingSince), the cursor staying so
 * it is fetched again (F3).
 */
const HELD = 'held';

/** Filed as someone else's message sharing the p tag, so the cursor moves on past it. */
function notOurs(p: InboxPorts, owner: string, w: NostrEvent): Outcome {
  recordSeen(p.db, p.now(), w.id, { owner, outcome: 'ignored_foreign' });
  return 'ignored_foreign';
}

/**
 * One wrap opened and judged (4.7), or held for the next drain. The signer couldn't answer (out of sight, timed out,
 * declined): the wrap waits, and unless the signer is still answering (stillAnswering), the drain's other wraps wait
 * unasked. Taking it failed part way (a signer, the network, the database), or its save waits on its delete's Undo:
 * it is tried again at the next drain. Either way, one still waiting a week after its first try is filed as not ours,
 * and so is one this key doesn't open.
 */
async function openOne(p: InboxPorts, owner: string, w: NostrEvent, blossom: string, drain: Drain): Promise<Outcome | typeof HELD> {
  drain.opens++;
  let opened: Awaited<ReturnType<typeof unwrap>>;
  try {
    opened = await unwrap(p.signer, w);
    drain.answered = true;
  } catch (e) {
    // not a wrap this key opens: someone else's message sharing the p tag
    if (e instanceof UnwrapError) return notOurs(p, owner, w);
    if (!(await stillAnswering(p, owner, drain))) drain.waiting = true;
    return stale(p, owner, w.id) ? notOurs(p, owner, w) : HELD;
  }
  try {
    return (await handle(p, owner, w.id, opened.rumor, opened.seal, blossom, drain)) ?? HELD;
  } catch {
    return stale(p, owner, w.id) ? notOurs(p, owner, w) : HELD;
  }
}

/**
 * The most wraps already waiting that a drain tries ahead of the rest. Those are tried first, so that while the signer
 * isn't answering the drain asks about the same wrap each time, whose week runs alone: asked about a new one each
 * drain, every save sent while the signer was away would wait out its week and be filed with it. Past this many,
 * which only wraps that keep failing for the signer while it answers come to, the drain's other wraps go first.
 */
export const INBOX_RETRIES = 100;

const byAge = (a: NostrEvent, b: NostrEvent) => a.created_at - b.created_at;

/**
 * What a read keeps: each wrap once (take returns how many of an answer were new to the read), and only one that may
 * hold a request (mayHoldRequest) and that no drain has judged, so what was read before costs no memory. wraps() is
 * the order they are opened: up to INBOX_RETRIES already waiting (a signer that didn't open them, a taking that
 * failed), then those never tried, each oldest first. A drain opens at most INBOX_UNWRAPS, so no more than that of the
 * waiting and twice that of the rest are kept, those to be opened first; over() says some were let go, which the drain
 * counts as left unopened.
 */
export function unjudged(db: SqlDb) {
  const ids = new Set<string>();
  const kept = { tried: [] as NostrEvent[], fresh: [] as NostrEvent[] };
  let over = false;
  const trim = (list: 'tried' | 'fresh', max: number, to: number) => {
    if (kept[list].length <= max) return;
    kept[list] = kept[list].sort(byAge).slice(0, to);
    over = true;
  };
  const take = (page: NostrEvent[]): number => {
    let added = 0;
    for (const e of page) {
      if (ids.has(e.id)) continue;
      ids.add(e.id);
      added++;
      const state = mayHoldRequest(e) ? seenState(db, e.id) : 'ignored_foreign';
      if (state === null || state === 'waiting') kept[state === 'waiting' ? 'tried' : 'fresh'].push(e);
    }
    trim('tried', 2 * INBOX_RETRIES, INBOX_RETRIES);
    trim('fresh', 2 * INBOX_UNWRAPS, INBOX_UNWRAPS);
    return added;
  };
  const wraps = () => [...kept.tried.sort(byAge).slice(0, INBOX_RETRIES), ...kept.fresh.sort(byAge), ...kept.tried.slice(INBOX_RETRIES)];
  return { take, wraps, over: () => over };
}

/**
 * Where a drain leaves the cursor. A wrap left for the next drain keeps the scan from moving it when the scan ends, so
 * the scan reads the window again; with none left, it moves as far as the read reached (WindowRead.upTo), and the
 * outcomes from two weeks ago, of wraps no drain reads again with the window two days back from here, are forgotten.
 */
function moveCursor(p: InboxPorts, relay: string, owner: string, startedAt: number, read: WindowRead, held: boolean): void {
  if (held && read.scan) keepInboxScan(p.db, relay, owner, { ...read.scan, left: true });
  if (held || read.upTo === null) return;
  setCursor(p.db, startedAt, relay, 'inbox', owner, read.upTo);
  forgetIgnored(p.db, p.now(), owner);
}

/** One drain of the inbox. Restartable: the cursor moves only after the relay answers, and as WindowRead.upTo allows. */
export async function drainInbox(p: InboxPorts, owner: string): Promise<InboxResult> {
  const out: InboxResult = {};
  const d = await p.defaults();
  const relay = d.operator.relay;
  const drain: Drain = { devices: localRecord(p.db, owner), opens: 0, waiting: false, answered: false, blobsDown: false };
  await retryBlobs(p, owner, d.operator.blossom, out, drain);
  const startedAt = p.now();
  const read = await windowSince(p, relay, owner, startedAt);
  if (!read) return out; // unreachable: the cursor stays
  // wraps read but let go (more than a drain opens) are left unopened as much as those the budget stops at
  let held = read.over;
  for (const w of read.wraps) {
    // once the signer hasn't answered, and past the drain's budget, the rest wait for the next drain unasked
    const o = drain.waiting || drain.opens >= INBOX_UNWRAPS ? HELD : await openOne(p, owner, w, d.operator.blossom, drain);
    if (o === HELD) held = true;
    else tally(out, o);
  }
  moveCursor(p, relay, owner, startedAt, read, held);
  return out;
}
