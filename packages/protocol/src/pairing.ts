// Pairing a browser (C§4.4): the QR offer, the typed code, the pair-ack, and the save request.

import { base64 } from '@scure/base';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { KIND } from './constants';
import type { CryptoPort } from './ports';
import { connectedEntry } from './devices';
import type { DeviceEntry, DevicesRecord } from './devices';
import { giftWrap } from './wrap';
import type { Rumor, WrapOptions } from './wrap';
import type { NostrEvent, Signer } from './signer';

export interface PairOffer {
  v: 1;
  device_pubkey: string;
  relay: string;
  nonce: string;
  /** Unix seconds. */
  expires: number;
  label: string;
}

export type OfferProblem = 'version' | 'expired' | 'device_pubkey' | 'label' | 'relay' | 'nonce';

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

/** Check an offer from a QR or a decrypted typed code. Returns the first problem, or null when it can be shown. */
export function checkOffer(o: Partial<PairOffer> | null, operatorRelay: string, now: number): OfferProblem | null {
  if (!o || o.v !== 1) return 'version';
  if (typeof o.expires !== 'number' || o.expires + OFFER_SKEW < now) return 'expired';
  if (!isXOnlyPubkey(o.device_pubkey)) return 'device_pubkey';
  // Plain text: no control characters and under 64 characters (code points).
  if (typeof o.label !== 'string' || o.label.trim() === '' || [...o.label].length >= 64 || /[\u0000-\u001f\u007f-\u009f]/.test(o.label)) return 'label';
  if (o.relay !== operatorRelay) return 'relay';
  if (typeof o.nonce !== 'string' || o.nonce === '') return 'nonce';
  return null;
}

// Crockford's base32 without I, L, O and U.
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
export const PAIR_CODE_SALT = 'shelf/pair-code/v1';

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

/** scrypt(code, shelf/pair-code/v1, N 16384, r 8, p 1) to 64 bytes: the lookup (hex) and the offer's AES key. */
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

export const PAIR_ACK_D = 'shelf/pair-ack';
export const SAVE_REQUEST_D_PREFIX = 'shelf/save-request/';

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

/** Why a rumor isn't acted on. 'other' is someone else's message sharing the p tag: left alone, not an error. */
export type SaveRequestVerdict =
  | { ok: true; request: SaveRequest; device: DeviceEntry }
  | { ok: false; reason: 'other' | 'version' | 'token' | 'device' | 'server' };

/**
 * The phone's acceptance rules for an unwrapped rumor (C§4.4). unwrap has already matched the rumor's
 * author to the seal. html.server must be the operator Blossom server; the X rule, the download and the
 * sha256 check come after, in the app.
 */
export function acceptSaveRequest(rumor: Rumor, seal: NostrEvent, devices: DevicesRecord, operatorBlossom: string): SaveRequestVerdict {
  const d = rumor.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  if (rumor.kind !== KIND.appData || !d.startsWith(SAVE_REQUEST_D_PREFIX)) return { ok: false, reason: 'other' };
  let request: SaveRequest;
  try {
    request = JSON.parse(rumor.content);
  } catch {
    return { ok: false, reason: 'version' };
  }
  if (request?.v !== 1 || typeof request.url !== 'string') return { ok: false, reason: 'version' };
  const device = connectedEntry(devices, request.token);
  if (!device) return { ok: false, reason: 'token' };
  if (seal.pubkey !== device.device_pubkey) return { ok: false, reason: 'device' };
  if (request.html !== null && request.html?.server !== operatorBlossom) return { ok: false, reason: 'server' };
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
