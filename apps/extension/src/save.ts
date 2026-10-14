// A browser save (contract 4.4): the captured HTML encrypted into an inbox blob for the operator Blossom server, then a
// save request wrapped to the user, rumor and seal by the device key, the wrap by a fresh key kept for Undo. Delivery
// uploads the blob, then publishes the wrap to the operator relay only; an upload the operator refuses for good sends the
// request again without its HTML (v1.12). Network calls come through Net, so the tests can play the relay and the server.
import { base64 } from '@scure/base';
import { bytesToHex } from '@noble/hashes/utils.js';
import { finalizeEvent } from 'nostr-tools/pure';
import { uploadBlob, deleteBlob, type BlossomOutcome } from '../../../packages/protocol/src/blossom';
import { EventTooLargeError } from '../../../packages/protocol/src/events';
import { itemHash } from '../../../packages/protocol/src/normalise';
import { wrapSaveRequest, type SaveRequest } from '../../../packages/protocol/src/pairing';
import type { CryptoPort } from '../../../packages/protocol/src/ports';
import type { LocalSigner, NostrEvent } from '../../../packages/protocol/src/signer';
import { encryptText } from '../../../packages/protocol/src/text';
import type { Captured } from './captured';
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

/** fetch with a time limit: past it, the request is aborted and the call rejects. */
export function timed(ms: number, get: typeof fetch = fetch): typeof fetch {
  return (input, init) => get(input, { ...init, signal: AbortSignal.timeout(ms) });
}

export const fetchNet = (publish: Net['publish'], get: typeof fetch = fetch): Net => ({
  upload: (server, blob, sha, signer) => uploadBlob(server, blob, sha, signer, timed(uploadTimeoutMs(blob.length), get)),
  remove: (server, sha, signer) => deleteBlob(server, sha, signer, get),
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
}

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

/**
 * The request and its wrap, the HTML encrypted with a fresh key; nothing is sent yet. A wrap has to stay under 8 KB, so a
 * page with a long address or hero loses what it can spare until it fits; one that still doesn't is AddressTooLongError.
 */
export async function prepare(c: Captured, ctx: SaveContext): Promise<Prepared> {
  const enc = c.html === null ? null : await encryptText(c.html, ctx.crypto);
  let request: SaveRequest = {
    v: 1, url: c.url, canonical: c.canonical, title: c.title, site: c.site, byline: c.byline, lang: c.lang, hero: c.hero,
    captured_at: ctx.now, token: ctx.pairing.token,
    html: enc ? { ...enc.text, server: ctx.defaults.operator.blossom } : null,
  };
  const uuid = bytesToHex(ctx.crypto.randomBytes(16));
  for (let spared = 0; ; spared++) {
    try {
      const { wrap, wrapKey } = await wrapSaveRequest(ctx.device, ctx.pairing.user_pubkey, uuid, request, ctx.now);
      const sealed = await ctx.device.nip44Encrypt(ctx.device.pubkey(), JSON.stringify({ uuid, request }));
      const text = request.html && enc;
      const pending: Pending = {
        id: wrap.id, wrap, sealed, blob: text ? base64.encode(enc.blob) : null, sha256: text ? enc.text.sha256 : null,
        hash: itemHash(request.url, request.canonical), title: request.title ?? hostOf(request.url), host: hostOf(request.url), created_at: ctx.now, attempts: 0,
      };
      return { pending, wrapKey };
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

/**
 * The request with `html` null (contract 4.4, v1.12), signed again and wrapped for the recipient of the wrap it replaces.
 * Null when that can't be done; the old wrap then goes as it was, and the phone, finding no blob, fetches the page.
 */
export async function withoutText(p: Pick<Pending, 'wrap' | 'sealed'>, device: LocalSigner, now: number): Promise<Again | null> {
  try {
    const to = p.wrap.tags.find((t) => t[0] === 'p')?.[1];
    return to ? await wrapAgain(p.sealed, device, to, (r) => ({ ...r, html: null }), now) : null;
  } catch {
    return null;
  }
}

export type Delivery = 'sent' | 'unreachable' | 'blocked';

/** What delivery reads of a save, and may change: its blob goes once uploaded, and a refusal can put another wrap in place. */
export type Delivered = Pick<Pending, 'id' | 'wrap' | 'sealed' | 'blob' | 'sha256'>;

/** What a refused upload leaves to its caller: the save's request put in the wrap's place without its HTML. */
export type Refused = (p: Delivered) => Promise<void>;

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

/** The wrap published; 'blocked' is a relay that answered and refused, which the options page names. */
async function publishWrap(p: Delivered, relay: string, device: LocalSigner, net: Net): Promise<Delivery> {
  try {
    await net.publish(relay, p.wrap, device);
    return 'sent';
  } catch (e) {
    return String(e).includes('blocked') || String(e).includes('restricted') ? 'blocked' : 'unreachable';
  }
}

/**
 * Uploads the blob if it is still here, then publishes the wrap. The blob going first means the phone finds the HTML
 * when the request arrives. When the operator refuses the upload for good, a 413 for room or size among the reasons,
 * the extension doesn't wait (contract 4.4 and 5, v1.12): `refused` puts the request without its HTML in the wrap's
 * place, and that wrap goes, so the phone fetches the page itself.
 */
export async function deliver(p: Delivered, server: string, relay: string, device: LocalSigner, net: Net, refused: Refused): Promise<Delivery> {
  const up = await uploadInbox(p, server, device, net);
  if (up === 'unreachable') return up;
  if (up === 'refused') await refused(p);
  return publishWrap(p, relay, device, net);
}

/** Undo after the wrap reached the relay: a kind 5 signed by the wrap's key, and the inbox blob removed (contract 4.4). */
export async function retract(p: Pick<Pending, 'id' | 'sha256'>, wrapKey: Uint8Array, server: string, relay: string, device: LocalSigner, net: Net, now: number): Promise<void> {
  const deletion = finalizeEvent({ kind: 5, created_at: now, tags: [['e', p.id], ['k', '1059']], content: '' }, wrapKey) as NostrEvent;
  await net.publish(relay, deletion);
  if (p.sha256) await net.remove(server, p.sha256, device).catch(() => undefined);
}
