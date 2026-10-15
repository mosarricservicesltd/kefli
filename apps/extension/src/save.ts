// A browser save (contract 4.4): the captured HTML encrypted into an inbox blob for the operator Blossom server, then a
// save request wrapped to the user, rumor and seal by the device key, the wrap by a fresh key kept for Undo. Delivery
// uploads the blob, then publishes the wrap to the operator relay only; an upload the operator refuses for good sends the
// request again without its HTML (v1.12), and a wrap that waited is made again first, so the phone's look at its inbox
// finds it. Network calls come through Net, so the tests can play the relay and the server.
import { base64 } from '@scure/base';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { finalizeEvent } from 'nostr-tools/pure';
import { uploadBlob, deleteBlob, type BlossomOutcome } from '../../../packages/protocol/src/blossom';
import { EventTooLargeError } from '../../../packages/protocol/src/events';
import { itemHash } from '../../../packages/protocol/src/normalise';
import { SAVE_REQUEST_MAX_BYTES, wrapSaveRequest, type SaveRequest } from '../../../packages/protocol/src/pairing';
import type { CryptoPort } from '../../../packages/protocol/src/ports';
import type { LocalSigner, NostrEvent } from '../../../packages/protocol/src/signer';
import { encryptText } from '../../../packages/protocol/src/text';
import { unwrappableAddress, type Captured } from './captured';
import type { Defaults } from './defaults';
import type { Pairing } from './store';

export interface Net {
  upload(server: string, blob: Uint8Array, sha256: string, signer: LocalSigner): Promise<BlossomOutcome>;
  remove(server: string, sha256: string, signer: LocalSigner): Promise<BlossomOutcome>;
  /**
   * Resolves once the relay answers OK true; rejects on a refusal, a timeout or no connection. With the device key,
   * the connection AUTHs as the device first (F9).
   */
  publish(relay: string, event: NostrEvent, device?: LocalSigner): Promise<void>;
}

/**
 * How long an upload may take before it counts as unreachable and the save waits in the queue (F23): twenty seconds,
 * and a second more for every 32 KB, so the largest blob (2 MB of HTML, about 2.8 MB as sent) still has a slow uplink's
 * time. Without it a stalled upload held Saving… for ever.
 */
export function uploadTimeoutMs(bytes: number): number {
  return 20_000 + Math.ceil(bytes / 32_768) * 1000;
}

/**
 * fetch with a time limit: past it, the request is aborted and the call rejects, even from a fetch that pays the signal no
 * heed. The signal aborts reading the body too.
 */
export function timed(ms: number, get: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const signal = AbortSignal.timeout(ms);
    const gone = new Promise<never>((_ok, fail) => signal.addEventListener('abort', () => fail(signal.reason), { once: true }));
    return Promise.race([get(input, { ...init, signal }), gone]);
  };
}

/**
 * The most of an answer from Kefli's servers that is read: every answer the extension reads (a Blossom descriptor or
 * refusal, defaults.json, the pair-offers reply) is a few hundred bytes, and one far longer would otherwise be held
 * whole in the worker's memory before it could be refused.
 */
export const ANSWER_MAX_BYTES = 65_536;

/** fetch whose answer is cut off past max bytes: reading further fails, so a huge answer is never held whole. */
export function capped(max: number, get: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await get(input, init);
    if (Number(res.headers?.get('content-length') ?? 0) > max) {
      void res.body?.cancel().catch(() => undefined);
      throw new Error('answer too large');
    }
    if (!res.body || res.status < 200 || res.status > 599) return res;
    let seen = 0;
    const body = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        seen += chunk.byteLength;
        if (seen > max) out.error(new Error('answer too large'));
        else out.enqueue(chunk);
      },
    }));
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** How long Undo's removal of the inbox blob may take: past it Undo goes on, as it does when the removal fails. */
export const REMOVE_TIMEOUT_MS = 10_000;

export const fetchNet = (publish: Net['publish'], get: typeof fetch = fetch): Net => ({
  upload: (server, blob, sha, signer) => uploadBlob(server, blob, sha, signer, timed(uploadTimeoutMs(blob.length), capped(ANSWER_MAX_BYTES, get))),
  remove: (server, sha, signer) => deleteBlob(server, sha, signer, timed(REMOVE_TIMEOUT_MS, capped(ANSWER_MAX_BYTES, get))),
  publish,
});

/** A save that hasn't reached the relay yet, as the queue keeps it (extension spec 4). */
export interface Pending {
  /** The wrap's id. */
  id: string;
  wrap: NostrEvent;
  /**
   * The request and its uuid, NIP-44 encrypted to the device's own key, so a save still queued when the library moves
   * to another key can be wrapped again for it (contract 4.4); the wrap itself can't be opened by its sender.
   */
  sealed: string;
  /** The inbox blob as base64 until it is uploaded; null once uploaded, or when there was no HTML. */
  blob: string | null;
  sha256: string | null;
  /** The save's hash (contract 4.1, 4.3), for its cover; since v1.10 its address is keyed, the hash isn't. */
  hash: string;
  title: string;
  host: string;
  created_at: number;
  attempts: number;
  /** When its wrap was made, in Unix seconds (WRAP_FRESH_FOR); one queued by an earlier build has none, so counts as old. */
  wrapped_at?: number;
}

/**
 * How long a wrap may wait before it goes, in seconds (contract 4.4). The phone reads its inbox from two days and five
 * minutes before its last look, and NIP-59 dates a wrap up to two days back, so a wrap that waited in the queue longer
 * than five minutes while the phone looked could carry a date the phone has already read past, and never reach it. A wrap
 * made more than a minute ago is made again just before it goes, leaving four of the five minutes for the send and for
 * this computer's clock running behind the phone's.
 */
export const WRAP_FRESH_FOR = 60;

export interface Prepared {
  pending: Pending;
  /** The wrap's own key, which alone can retract it (Undo). */
  wrapKey: Uint8Array;
}

export interface SaveContext {
  device: LocalSigner;
  defaults: Defaults;
  pairing: Pairing;
  crypto: CryptoPort;
  now: number;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * What goes when a request is too large to wrap (F39), in this order: the page's own details first, starting with the
 * hero, often a long signed address; then the canonical address, which can change which save it is; and last the text,
 * which the phone then fetches itself. The address and token always stay.
 */
const SPARE = ['hero', 'byline', 'site', 'lang', 'title', 'canonical', 'html'] as const;

/** The address alone is too long to wrap, even with everything else left out (F39). */
export class AddressTooLongError extends Error {
  constructor() {
    super('the address is too long to send');
    this.name = 'AddressTooLongError';
  }
}

type Encrypted = Awaited<ReturnType<typeof encryptText>>;

/** The save as the queue keeps it, its blob only while the request still names the HTML (F39 may have spared it). */
function pendingOf(wrap: NostrEvent, sealed: string, request: SaveRequest, enc: Encrypted | null, now: number): Pending {
  const text = request.html && enc;
  return {
    id: wrap.id, wrap, sealed, blob: text ? base64.encode(text.blob) : null, sha256: text ? text.text.sha256 : null,
    hash: itemHash(request.url, request.canonical), title: request.title ?? hostOf(request.url), host: hostOf(request.url), created_at: now, attempts: 0,
    wrapped_at: now,
  };
}

/**
 * A field longer than a whole wrap's limit, which could never go in one: it is left out before the first try rather than
 * after a try for each field spared before it. A page's 1 MB title cost five wraps of a megabyte each, seven seconds of
 * the worker's time. The address, which can't be left out, is refused instead (addressFits).
 */
const unwrappable = (s: string | null) => s !== null && s.length > SAVE_REQUEST_MAX_BYTES;
const fitting = (s: string | null) => (unwrappable(s) ? null : s);

/**
 * An address that takes at most this much of a rumor (rumorBytes) always fits a wrap with its token alone: one of 2,576
 * bytes does, whatever its characters, and one of 2,577 doesn't. Every ordinary address takes less, and goes to its
 * wrap without the try alone (addressFits).
 */
export const ADDRESS_SURE_FIT_BYTES = 2_048;

/** What an address takes of the rumor a wrap seals: its UTF-8 bytes, escaped in the request's JSON and again in the rumor's. */
export function rumorBytes(url: string): number {
  return utf8ToBytes(JSON.stringify(JSON.stringify(url))).length;
}

/** Whether a wrap can hold the request: the wrap is made and let go, and nothing is sent. */
async function wraps(request: SaveRequest, uuid: string, ctx: SaveContext): Promise<boolean> {
  try {
    await wrapSaveRequest(ctx.device, ctx.pairing.user_pubkey, uuid, request, ctx.now);
    return true;
  } catch (e) {
    if (e instanceof EventTooLargeError) return false;
    throw e;
  }
}

/**
 * Whether any request can carry the address (F39), known before the HTML is encrypted or a wrap tried for each field the
 * request could spare: by its length for one no request can carry (ADDRESS_UNWRAPPABLE), and for one taking more of a
 * wrap than any ordinary address by wrapping the request the spare loop would end with, the address and token alone.
 * An address of 2,600 characters was refused only after its 2 MB of HTML was encrypted and eight wraps were tried.
 */
async function addressFits(bare: SaveRequest, uuid: string, ctx: SaveContext): Promise<boolean> {
  if (unwrappableAddress(bare.url)) return false;
  if (rumorBytes(bare.url) <= ADDRESS_SURE_FIT_BYTES) return true;
  return wraps(bare, uuid, ctx);
}

/**
 * The request and its wrap, the HTML encrypted with a fresh key; nothing is sent yet. A wrap has to stay under 8 KB, so a
 * page with a long address or hero loses what it can spare until it fits; one whose address can't fit even alone is
 * AddressTooLongError, at once.
 */
export async function prepare(c: Captured, ctx: SaveContext): Promise<Prepared> {
  const uuid = bytesToHex(ctx.crypto.randomBytes(16));
  const bare: SaveRequest = {
    v: 1, url: c.url, canonical: null, title: null, site: null, byline: null, lang: null, hero: null, captured_at: ctx.now, token: ctx.pairing.token, html: null,
  };
  if (!(await addressFits(bare, uuid, ctx))) throw new AddressTooLongError();
  const enc = c.html === null ? null : await encryptText(c.html, ctx.crypto);
  let request: SaveRequest = {
    ...bare, canonical: fitting(c.canonical), title: fitting(c.title), site: fitting(c.site), byline: fitting(c.byline), lang: fitting(c.lang), hero: fitting(c.hero),
    html: enc ? { ...enc.text, server: ctx.defaults.operator.blossom } : null,
  };
  for (let spared = 0; ; spared++) {
    try {
      const { wrap, wrapKey } = await wrapSaveRequest(ctx.device, ctx.pairing.user_pubkey, uuid, request, ctx.now);
      const sealed = await ctx.device.nip44Encrypt(ctx.device.pubkey(), JSON.stringify({ uuid, request }));
      return { pending: pendingOf(wrap, sealed, request, enc, ctx.now), wrapKey };
    } catch (e) {
      if (!(e instanceof EventTooLargeError)) throw e;
      if (spared === SPARE.length) throw new AddressTooLongError();
      request = { ...request, [SPARE[spared]]: null };
    }
  }
}

/** A request wrapped again: the new wrap, the key that alone can retract it, and the request sealed to the device. */
export interface Again {
  wrap: NostrEvent;
  wrapKey: Uint8Array;
  sealed: string;
}

/** What a request wrapped again changes: its token in a move, its HTML when the operator refused the upload. */
export type Change = (request: SaveRequest) => SaveRequest;

/**
 * A save's request read back from its copy sealed to the device, changed, and wrapped again for `to` with the same uuid,
 * so the phone reads the same save request under a new wrap, key and id. Null when the sealed copy can't be read, as for
 * a save queued before requests were kept.
 */
export async function wrapAgain(sealed: string, device: LocalSigner, to: string, change: Change, now: number): Promise<Again | null> {
  let kept: { uuid: string; request: SaveRequest };
  try {
    kept = JSON.parse(await device.nip44Decrypt(device.pubkey(), sealed));
  } catch {
    return null;
  }
  const request = change(kept.request);
  const { wrap, wrapKey } = await wrapSaveRequest(device, to, kept.uuid, request, now);
  return { wrap, wrapKey, sealed: await device.nip44Encrypt(device.pubkey(), JSON.stringify({ uuid: kept.uuid, request })) };
}

/** The request, changed, signed again and wrapped for the recipient of the wrap it replaces; null when that can't be done. */
async function wrapFor(p: Pick<Pending, 'wrap' | 'sealed'>, device: LocalSigner, change: Change, now: number): Promise<Again | null> {
  try {
    const to = p.wrap.tags.find((t) => t[0] === 'p')?.[1];
    return to ? await wrapAgain(p.sealed, device, to, change, now) : null;
  } catch {
    return null;
  }
}

/**
 * The request with `html` null (contract 4.4, v1.12), signed again and wrapped for the recipient of the wrap it replaces.
 * Null when that can't be done; the old wrap then goes as it was, and the phone, finding no blob, fetches the page.
 */
export function withoutText(p: Pick<Pending, 'wrap' | 'sealed'>, device: LocalSigner, now: number): Promise<Again | null> {
  return wrapFor(p, device, (r) => ({ ...r, html: null }), now);
}

/** The same request under a wrap made now, for a save that waited (WRAP_FRESH_FOR); null when that can't be done. */
export function freshWrap(p: Pick<Pending, 'wrap' | 'sealed'>, device: LocalSigner, now: number): Promise<Again | null> {
  return wrapFor(p, device, (r) => r, now);
}

export type Delivery = 'sent' | 'unreachable';

/** What delivery reads of a save, and may change: its blob goes once uploaded, and another wrap can take its wrap's place. */
export type Delivered = Pick<Pending, 'id' | 'wrap' | 'sealed' | 'blob' | 'sha256' | 'wrapped_at'>;

/**
 * What its caller does with a save between its upload and its publish: with `refused`, the operator refused the upload,
 * and the request goes again without its HTML (v1.12); otherwise a wrap that waited too long is made again
 * (WRAP_FRESH_FOR).
 */
export type BeforePublish = (p: Delivered, refused: boolean) => Promise<void>;

/**
 * The inbox blob's upload, while the save still has one: 'done' once the operator holds it, or when there is none to
 * send; 'refused' for any 4xx answer but 401 and 429 (contract 4.4 and 5), never tried again; and 'unreachable' for
 * anything else, a 5xx, a 507, a 401, a 429 or no answer, which the queue tries again.
 */
async function uploadInbox(p: Delivered, server: string, device: LocalSigner, net: Net): Promise<'done' | 'refused' | 'unreachable'> {
  if (p.blob === null || p.sha256 === null) return 'done';
  const up = await net.upload(server, base64.decode(p.blob), p.sha256, device).catch(() => null);
  if (!up || (!up.ok && !up.permanent)) return 'unreachable';
  p.blob = null;
  return up.ok ? 'done' : 'refused';
}

/**
 * The wrap published. A relay that refuses it answers by its own rules (blocked:, as Kefli's does for a library deleted,
 * or one that moved away and was retired), its limits (rate-limited:) or the event (invalid:), none of which anything in
 * this browser can lift, so a refusal waits to be tried again as a relay out of reach does. Read as the browser blocking
 * Kefli's server, it sent the person to Advanced, where nothing could help. A socket the browser blocks, as Brave's
 * Shields can, comes to the extension as a connection that failed, as one over a network that is down does.
 */
async function publishWrap(p: Delivered, relay: string, device: LocalSigner, net: Net): Promise<Delivery> {
  return net.publish(relay, p.wrap, device).then((): Delivery => 'sent', (): Delivery => 'unreachable');
}

/**
 * Uploads the blob if it is still here, then publishes the wrap. The blob going first means the phone finds the HTML
 * when the request arrives. When the operator refuses the upload for good, a 413 for room or size among the reasons,
 * the extension doesn't wait (contract 4.4 and 5, v1.12): `before` puts the request without its HTML in the wrap's
 * place, and that wrap goes, so the phone fetches the page itself. Otherwise `before` makes a wrap that waited too long
 * again, so the phone's look at its inbox finds it.
 */
export async function deliver(p: Delivered, server: string, relay: string, device: LocalSigner, net: Net, before: BeforePublish): Promise<Delivery> {
  const up = await uploadInbox(p, server, device, net);
  if (up === 'unreachable') return up;
  await before(p, up === 'refused');
  return publishWrap(p, relay, device, net);
}

/** Undo after the wrap reached the relay: a kind 5 signed by the wrap's key, and the inbox blob removed (contract 4.4). */
export async function retract(p: Pick<Pending, 'id' | 'sha256'>, wrapKey: Uint8Array, server: string, relay: string, device: LocalSigner, net: Net, now: number): Promise<void> {
  const deletion = finalizeEvent({ kind: 5, created_at: now, tags: [['e', p.id], ['k', '1059']], content: '' }, wrapKey) as NostrEvent;
  await net.publish(relay, deletion);
  if (p.sha256) await net.remove(server, p.sha256, device).catch(() => undefined);
}
