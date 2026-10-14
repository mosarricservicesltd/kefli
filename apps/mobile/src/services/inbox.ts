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
  KIND, UnwrapError, acceptSaveRequest, decryptText, unwrap, type DevicesRecord, type NostrEvent, type Rumor, type SaveRequest, type Signer,
} from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { localRecord } from '../data/devices';
import {
  INBOX_BLOB_LIFE, admit, failedBlobs, giveUpBlob, noteDeviceSave, queueDeleteWrap, recordSeen, seenOutcome, type Outcome,
} from '../data/inbox';
import type { Pending } from '../data/pending';
import type { SaveTargets } from '../data/saves';
import { getCursor, setCursor } from '../data/sync';
import { deriveArticle } from '../reader/blocks';
import type { PageOutcome, ParserResult } from './page';
import { settle, type PendingPorts } from './pending';
import type { Filter } from './sync';
import { TooLarge, open } from '../net/http';

/** The extension's 2 MB of HTML plus the GCM tag. */
export const INBOX_MAX_BYTES = 2 * 1_048_576 + 16;
export const WRAP_LOOKBACK = 172_800 + 300;
/** How long a wrap the signer can't open, or that can't be taken, keeps the inbox's cursor waiting for it (F3). */
export const WRAP_PATIENCE = 7 * 86_400;
// a wrap's created_at is up to two days early (NIP-59), so a week past it is at least five days of trying; NIP-59
// never dates one later, so one dated more than a week ahead is no wrap of the browser's, and can't hold the cursor
// for as long as its date says
const stale = (p: InboxPorts, w: NostrEvent) => Math.abs(p.now() - w.created_at) > WRAP_PATIENCE;

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
 * What one drain learns as it goes: the connected-browsers record, read once; whether the signer has stopped
 * answering; and whether the Blossom server has, after which the drain's other blobs wait for the next drain rather
 * than each waiting out the deadline.
 */
type Drain = { devices: DevicesRecord; blobsDown: boolean };

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

async function handle(p: InboxPorts, owner: string, wrapId: string, rumor: Rumor, seal: NostrEvent, blossom: string, drain: Drain, retry = false): Promise<Outcome> {
  const j = judge(p.db, owner, rumor, seal, blossom, drain.devices);
  const d = rumor.tags.find((x) => x[0] === 'd')?.[1] ?? null;
  if ('outcome' in j) {
    recordSeen(p.db, p.now(), wrapId, { owner, outcome: j.outcome, requestD: j.outcome === 'ignored_foreign' ? null : d });
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

/** One drain of the inbox. Restartable: the cursor moves only after the relay answers. */
export async function drainInbox(p: InboxPorts, owner: string): Promise<InboxResult> {
  const out: InboxResult = {};
  const d = await p.defaults();
  const relay = d.operator.relay;
  const drain: Drain = { devices: localRecord(p.db, owner), blobsDown: false };
  await retryBlobs(p, owner, d.operator.blossom, out, drain);
  const startedAt = p.now();
  const since = getCursor(p.db, relay, 'inbox', owner)?.since;
  let wraps: NostrEvent[];
  try {
    wraps = await p.query(relay, [{ kinds: [KIND.giftWrap], '#p': [owner], ...(since === undefined ? {} : { since: Math.max(0, since - WRAP_LOOKBACK) }) }]);
  } catch {
    return out; // unreachable: the cursor stays
  }
  let held = false;
  // once the signer hasn't answered, the rest of this drain's wraps wait for the next one unasked, since they would
  // fail the same way, two minutes each for a bunker, as sync's do (F14)
  let waiting = false;
  for (const w of wraps.sort((a, b) => a.created_at - b.created_at)) {
    if (w.kind !== KIND.giftWrap || seenOutcome(p.db, w.id)) continue;
    if (waiting) {
      held = true;
      continue;
    }
    let opened: Awaited<ReturnType<typeof unwrap>>;
    try {
      opened = await unwrap(p.signer, w);
    } catch (e) {
      // the signer couldn't answer (out of sight, timed out, declined): the wrap waits for the next drain, unrecorded,
      // and the cursor stays so it is fetched again (F3); one still failing after a week is filed as not ours
      if (!(e instanceof UnwrapError)) {
        waiting = true;
        if (!stale(p, w)) {
          held = true;
          continue;
        }
      }
      // not a wrap this key opens: someone else's message sharing the p tag
      recordSeen(p.db, p.now(), w.id, { owner, outcome: 'ignored_foreign' });
      out.ignored_foreign = (out.ignored_foreign ?? 0) + 1;
      continue;
    }
    let o: Outcome;
    try {
      o = await handle(p, owner, w.id, opened.rumor, opened.seal, d.operator.blossom, drain);
    } catch {
      // ours, but taking it failed part way (a signer, the network, the database): tried again next drain (F3)
      if (!stale(p, w)) {
        held = true;
        continue;
      }
      o = 'ignored_foreign';
      recordSeen(p.db, p.now(), w.id, { owner, outcome: o });
    }
    out[o] = (out[o] ?? 0) + 1;
  }
  if (!held) setCursor(p.db, startedAt, relay, 'inbox', owner, startedAt);
  return out;
}
