// Pairing a browser (C§4.4): the QR offer, the typed code, the pair-ack, and the save request.

import { base64 } from '@scure/base';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { getEventHash } from 'nostr-tools/pure';
import { KIND } from './constants';
import type { CryptoPort } from './ports';
import { nobleSecp } from './secp';
import { connectedEntry } from './devices';
import type { DeviceEntry, DevicesRecord } from './devices';
import { normalise, ownCanonical } from './normalise';
import { giftWrap } from './wrap';
import type { Rumor, WrapOptions } from './wrap';
import type { EventTemplate, NostrEvent, Signer } from './signer';

/**
 * A signed statement carried without the parts its reader already knows: the time and the BIP-340 signature of the
 * event that deviceProofTemplate or releaseTemplate builds, by the key that template names (C§4.4, 4.8, 6).
 */
export interface Statement {
  created_at: number;
  sig: string;
}

export interface PairOffer {
  v: 1;
  device_pubkey: string;
  relay: string;
  nonce: string;
  /** Unix seconds. */
  expires: number;
  label: string;
  /** The device key's proof that it is offering itself for this pairing (C§4.4), forwarded in POST /devices. */
  proof: Statement;
}

export type OfferProblem = 'version' | 'expired' | 'device_pubkey' | 'label' | 'relay' | 'nonce' | 'proof';

/** The operator API path whose call a device proof and a release are for (C§6). */
export const DEVICES_PATH = '/devices';

/**
 * What a device signs for its offer (C§4.4): a kind 27235 naming POST <api>/devices and the offer's nonce, made when
 * the offer is. It has no payload tag, so it can never pass as a request's own NIP-98, and only the device key can make
 * it, so a POST /devices that carries it shows the browser itself asked to be connected.
 */
export function deviceProofTemplate(api: string, nonce: string, createdAt: number): EventTemplate {
  return { kind: KIND.httpAuth, created_at: createdAt, tags: [['u', api + DEVICES_PATH], ['method', 'POST'], ['nonce', nonce]], content: '' };
}

/**
 * What the library a browser is connected to signs to hand it to another (C§4.8 step 4): a kind 27235 naming POST
 * <api>/devices, the device and the library it goes to. The move's source key S signs it at the moment T asks.
 */
export function releaseTemplate(api: string, device: string, to: string, createdAt: number): EventTemplate {
  return { kind: KIND.httpAuth, created_at: createdAt, tags: [['u', api + DEVICES_PATH], ['method', 'POST'], ['device', device], ['to', to]], content: '' };
}

/** Signs a statement and keeps its time and signature; the reader rebuilds the rest from what it knows. */
export async function signStatement(signer: Signer, template: EventTemplate): Promise<Statement> {
  const e = await signer.signEvent(template);
  return { created_at: e.created_at, sig: e.sig };
}

const HEX64 = /^[0-9a-f]{64}$/;

/** Whether sig is pubkey's signature over the template's event. */
export function statementHolds(pubkey: unknown, template: EventTemplate, sig: unknown, verify = nobleSecp.verify): boolean {
  if (typeof pubkey !== 'string' || !HEX64.test(pubkey) || typeof sig !== 'string' || !/^[0-9a-f]{128}$/.test(sig)) return false;
  return verify(sig, getEventHash({ ...template, pubkey }), pubkey);
}

/** An offer's proof holds: signed by its device_pubkey over its nonce, for this API, and made before it expires. */
export function proofHolds(o: Partial<PairOffer>, api: string, verify = nobleSecp.verify): boolean {
  const p = o.proof;
  if (typeof p?.created_at !== 'number' || !Number.isSafeInteger(p.created_at) || typeof o.nonce !== 'string') return false;
  if (typeof o.expires !== 'number' || p.created_at > o.expires) return false;
  return statementHolds(o.device_pubkey, deviceProofTemplate(api, o.nonce, p.created_at), p.sig, verify);
}

export const OFFER_SKEW = 60;

export function isXOnlyPubkey(hex: unknown): boolean {
  if (typeof hex !== 'string' || !/^[0-9a-f]{64}$/.test(hex)) return false;
  try {
    schnorr.utils.lift_x(BigInt(`0x${hex}`));
    return true;
  } catch {
    return false;
  }
}

/**
 * Check an offer from a QR or a decrypted typed code against the operator in defaults.json. Returns the first problem,
 * or null when it can be shown. verify is the platform's BIP-340 check (the phone passes its native one).
 */
export function checkOffer(
  o: Partial<PairOffer> | null, operator: { relay: string; api: string }, now: number, verify = nobleSecp.verify,
): OfferProblem | null {
  if (!o || o.v !== 1) return 'version';
  if (typeof o.expires !== 'number' || o.expires + OFFER_SKEW < now) return 'expired';
  if (!isXOnlyPubkey(o.device_pubkey)) return 'device_pubkey';
  // Plain text: no control characters and under 64 characters (code points).
  if (typeof o.label !== 'string' || o.label.trim() === '' || [...o.label].length >= 64 || /[\u0000-\u001f\u007f-\u009f]/.test(o.label)) return 'label';
  if (o.relay !== operator.relay) return 'relay';
  if (typeof o.nonce !== 'string' || o.nonce === '') return 'nonce';
  if (!proofHolds(o, operator.api, verify)) return 'proof';
  return null;
}

// Crockford's base32 without I, L, O and U.
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
export const PAIR_CODE_SALT = 'kefli/pair-code/v1';

/** Read a typed code leniently: upper case, hyphens and spaces dropped, O as 0, I and L as 1. Null unless eight valid characters. */
export function readPairCode(typed: string): string | null {
  const c = typed.toUpperCase().replace(/[-\s]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return CODE.test(c) ? c : null;
}

/** Eight random characters for a new offer, as the extension shows them (without the hyphen). */
export function newPairCode(crypto: CryptoPort): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  // 40 bits: five bytes, eight 5-bit groups.
  const b = crypto.randomBytes(5);
  let bits = 0n;
  for (const x of b) bits = (bits << 8n) | BigInt(x);
  let out = '';
  for (let i = 7; i >= 0; i--) out += alphabet[Number((bits >> BigInt(i * 5)) & 31n)];
  return out;
}

/** scrypt(code, kefli/pair-code/v1, N 16384, r 8, p 1) to 64 bytes: the lookup (hex) and the offer's AES key. */
export async function derivePairCode(code: string, crypto: CryptoPort): Promise<{ lookup: string; key: Uint8Array }> {
  if (!CODE.test(code)) throw new Error('not a pair code');
  const out = await crypto.scrypt(utf8ToBytes(code), utf8ToBytes(PAIR_CODE_SALT), { N: 16384, r: 8, p: 1 }, 64);
  return { lookup: bytesToHex(out.subarray(0, 32)), key: out.slice(32) };
}

/** The extension's side: base64(IV ‖ ciphertext ‖ tag) of the offer's JSON. */
export async function sealOffer(offer: PairOffer, key: Uint8Array, crypto: CryptoPort): Promise<string> {
  const iv = crypto.randomBytes(12);
  const ct = await crypto.aesGcmEncrypt(key, iv, utf8ToBytes(JSON.stringify(offer)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return base64.encode(out);
}

/** The phone's side: null when it doesn't decrypt, so the field shows its one error (C§4.4). */
export async function openOffer(sealed: string, key: Uint8Array, crypto: CryptoPort): Promise<Partial<PairOffer> | null> {
  try {
    const bytes = base64.decode(sealed);
    const plain = await crypto.aesGcmDecrypt(key, bytes.subarray(0, 12), bytes.subarray(12));
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    return null;
  }
}

export const PAIR_ACK_D = 'kefli/pair-ack';
export const SAVE_REQUEST_D_PREFIX = 'kefli/save-request/';

export interface PairAck {
  v: 1;
  user_pubkey: string;
  write_relays: string[];
  blossom_servers: string[];
  /** 32 random bytes, hex. */
  token: string;
  /** The offer's nonce, or, for a move, moved_from in its place (C§4.8). */
  nonce?: string;
  moved_from?: string;
}

/** The pair-ack wrap the phone sends the device, sealed by the user's key. */
export function wrapPairAck(user: Signer, devicePubkey: string, ack: PairAck, createdAt: number, opts?: WrapOptions) {
  return giftWrap(user, devicePubkey, { kind: KIND.appData, created_at: createdAt, tags: [['d', PAIR_ACK_D]], content: JSON.stringify(ack) }, opts);
}

export interface SaveRequest {
  v: 1;
  url: string;
  canonical: string | null;
  title: string | null;
  site: string | null;
  byline: string | null;
  lang: string | null;
  hero: string | null;
  captured_at: number;
  token: string;
  html: { sha256: string; key: string; nonce: string; server: string } | null;
}

export const SAVE_REQUEST_MAX_BYTES = 8_192;

/** The extension's side: a save request wrapped to the user, rumor and seal by the device key. */
export function wrapSaveRequest(device: Signer, userPubkey: string, uuid: string, request: SaveRequest, createdAt: number, opts?: WrapOptions) {
  return giftWrap(
    device,
    userPubkey,
    { kind: KIND.appData, created_at: createdAt, tags: [['d', SAVE_REQUEST_D_PREFIX + uuid]], content: JSON.stringify(request) },
    { maxBytes: SAVE_REQUEST_MAX_BYTES, ...opts },
  );
}

/**
 * Why a rumor isn't acted on. 'other' is someone else's message sharing the p tag: left alone, not an error.
 * 'malformed' is a connected browser's request whose address isn't a link, which no save can be made from.
 */
export type SaveRequestVerdict =
  | { ok: true; request: SaveRequest; device: DeviceEntry }
  | { ok: false; reason: 'other' | 'version' | 'malformed' | 'token' | 'device' | 'server' };

const textOr = (v: unknown) => (typeof v === 'string' ? v : null);
const timeOr = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/**
 * The longest canonical a request keeps, in UTF-16 code units: the phone's own parse leaves out a page's canonical past
 * this, unread (its page.ts FIELD_MAX.url), and a browser's must go the same way, or an AMP page with a longer one was
 * one save shared and another saved in a browser.
 */
export const CANONICAL_MAX = 2_048;

/**
 * The request's canonical as the phone's own parse keeps a page's (C§4.3): none past CANONICAL_MAX, and otherwise one
 * on the page's own site only, without a user name and password (ownCanonical, rulings 8 and 11). Kept as sent, as it
 * was, a browser's canonical on another site sent its save to that site's address.
 */
function canonicalOf(url: string, v: unknown): string | null {
  const canonical = textOr(v);
  return canonical !== null && canonical.length <= CANONICAL_MAX ? ownCanonical(url, canonical) : null;
}

/** html, when it names a blob by its sha256 with a key and nonce to open it; anything else is no HTML. */
function htmlOf(h: unknown): SaveRequest['html'] {
  const o = (h && typeof h === 'object' ? h : {}) as Record<string, unknown>;
  const [sha256, key, nonce, server] = [o.sha256, o.key, o.nonce, o.server];
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) || typeof server !== 'string') return null;
  return typeof key === 'string' && key !== '' && typeof nonce === 'string' && nonce !== '' ? { sha256, key, nonce, server } : null;
}

/**
 * The request as the phone acts on it, every field of the type the contract gives it (C§4.4): a field of another type
 * is null, so a save from a connected browser is never lost to it, and nothing the database can't hold reaches it.
 * captured_at is when the browser sent the request at the latest, the rumor's own time (the extension dates both
 * from one clock), so a time years ahead can't keep the inbox blob alive for ever; absent or not a time, it is the
 * rumor's. hero is kept only as an http(s) address, since the phone fetches it, and canonical only as the phone's own
 * parse keeps a page's (canonicalOf).
 */
function cleanRequest(r: SaveRequest, sentAt: number | null): SaveRequest | null {
  const captured = timeOr(r.captured_at);
  const at = captured === null ? sentAt : sentAt === null ? captured : Math.min(captured, sentAt);
  if (at === null) return null;
  const hero = textOr(r.hero);
  return {
    v: 1, url: r.url, canonical: canonicalOf(r.url, r.canonical), title: textOr(r.title), site: textOr(r.site), byline: textOr(r.byline),
    lang: textOr(r.lang), hero: hero && /^https?:\/\//i.test(hero) ? hero : null, captured_at: at, token: r.token,
    html: r.html === null ? null : htmlOf(r.html),
  };
}

/** A rumor's content as a request this client reads: JSON, v 1, a url that is a string; otherwise null. */
function requestOf(content: string): SaveRequest | null {
  try {
    const r = JSON.parse(content) as SaveRequest | null;
    return r?.v === 1 && typeof r.url === 'string' ? r : null;
  } catch {
    return null;
  }
}

function isLink(url: string): boolean {
  try {
    normalise(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * The phone's acceptance rules for an unwrapped rumor (C§4.4). unwrap has already matched the rumor's
 * author to the seal. html.server must be the operator Blossom server; the X rule, the download and the
 * sha256 check come after, in the app. An accepted request comes back cleaned (cleanRequest).
 */
export function acceptSaveRequest(rumor: Rumor, seal: NostrEvent, devices: DevicesRecord, operatorBlossom: string): SaveRequestVerdict {
  const d = rumor.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  if (rumor.kind !== KIND.appData || !d.startsWith(SAVE_REQUEST_D_PREFIX)) return { ok: false, reason: 'other' };
  const parsed = requestOf(rumor.content);
  if (!parsed) return { ok: false, reason: 'version' };
  const device = connectedEntry(devices, parsed.token);
  if (!device) return { ok: false, reason: 'token' };
  if (seal.pubkey !== device.device_pubkey) return { ok: false, reason: 'device' };
  const request = isLink(parsed.url) ? cleanRequest(parsed, timeOr(rumor.created_at)) : null;
  if (!request) return { ok: false, reason: 'malformed' };
  if (request.html !== null && request.html.server !== operatorBlossom) return { ok: false, reason: 'server' };
  return { ok: true, request, device };
}

function isPairAckShape(ack: PairAck | null): boolean {
  if (ack?.v !== 1 || !isXOnlyPubkey(ack.user_pubkey)) return false;
  return /^[0-9a-f]{64}$/.test(String(ack.token)) && Array.isArray(ack.write_relays) && Array.isArray(ack.blossom_servers);
}

export type PairAckVerdict =
  | { ok: true; ack: PairAck; move: boolean }
  | { ok: false; reason: 'other' | 'version' | 'nonce' | 'signer' | 'ignored' };

/**
 * The extension's acceptance rules for an unwrapped pair-ack (C§4.4, C§4.8). Unpaired, with an offer out:
 * the ack must carry that offer's nonce and be sealed by the user_pubkey it names. Paired: only a move is
 * taken, whose moved_from is the current user and whose seal that same key signed; anything else is ignored.
 */
export function acceptPairAck(rumor: Rumor, seal: NostrEvent, state: { offerNonce: string | null; pairedUser: string | null }): PairAckVerdict {
  const d = rumor.tags.find((t) => t[0] === 'd')?.[1];
  if (rumor.kind !== KIND.appData || d !== PAIR_ACK_D) return { ok: false, reason: 'other' };
  let ack: PairAck;
  try {
    ack = JSON.parse(rumor.content);
  } catch {
    return { ok: false, reason: 'version' };
  }
  if (!isPairAckShape(ack)) return { ok: false, reason: 'version' };
  if (state.pairedUser !== null) {
    if (ack.moved_from !== state.pairedUser) return { ok: false, reason: 'ignored' };
    if (seal.pubkey !== state.pairedUser) return { ok: false, reason: 'signer' };
    return { ok: true, ack, move: true };
  }
  if (state.offerNonce === null || ack.nonce !== state.offerNonce) return { ok: false, reason: 'nonce' };
  if (seal.pubkey !== ack.user_pubkey) return { ok: false, reason: 'signer' };
  return { ok: true, ack, move: false };
}

/** saved_at for a browser save: captured_at, or now if captured_at is later (C§4.1). */
export function browserSavedAt(capturedAt: number, now: number): number {
  return Number.isFinite(capturedAt) ? Math.min(capturedAt, now) : now;
}
