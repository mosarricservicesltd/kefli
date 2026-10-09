// Second-phone pairing (contract 2, flow decisions 85 and 90): the source phone shows a QR {v:1, pubkey, secret,
// expires} with six digits under it, and posts the mnemonic encrypted under a key derived from both with
// HKDF-SHA256, so neither a photographed QR nor the digits alone open it. The target scans, takes the digits,
// fetches the offer by its lookup, and refuses a mnemonic whose key isn't the QR's pubkey.

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { base64 } from '@scure/base';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { isXOnlyPubkey, OFFER_SKEW } from './pairing';
import type { CryptoPort } from './ports';

export const PHONE_PAIR_SALT = 'kefli/phone-pair/v1';
export const PHONE_OFFER_LIFE = 300;

export interface PhoneQr {
  v: 1;
  pubkey: string;
  /** 32 random bytes, hex. */
  secret: string;
  /** Unix seconds. */
  expires: number;
}

/** A fresh secret and six digits, uniform over 000000–999999 (rejection sampling, no modulo bias). */
export function newPhonePair(crypto: CryptoPort, pubkey: string, now: number): { qr: PhoneQr; six: string } {
  const secret = bytesToHex(crypto.randomBytes(32));
  let n: number;
  do {
    const b = crypto.randomBytes(4);
    n = ((b[0] << 24) >>> 0) + (b[1] << 16) + (b[2] << 8) + b[3];
  } while (n >= 4_294_000_000); // the largest multiple of 1,000,000 under 2^32
  return { qr: { v: 1, pubkey, secret, expires: now + PHONE_OFFER_LIFE }, six: String(n % 1_000_000).padStart(6, '0') };
}

/** The six digits as typed, or null: spaces dropped, exactly six digits. */
export function readSix(typed: string): string | null {
  const d = typed.replace(/\s/g, '');
  return /^\d{6}$/.test(d) ? d : null;
}

/** HKDF-SHA256(ikm secret, salt kefli/phone-pair/v1, info the six digits) to 64 bytes: lookup (hex) and AES key. */
export function derivePhonePair(secretHex: string, six: string): { lookup: string; key: Uint8Array } {
  const out = hkdf(sha256, hexToBytes(secretHex), utf8ToBytes(PHONE_PAIR_SALT), utf8ToBytes(six), 64);
  return { lookup: bytesToHex(out.subarray(0, 32)), key: out.slice(32) };
}

export async function sealPhoneOffer(mnemonic: string, key: Uint8Array, crypto: CryptoPort): Promise<string> {
  const iv = crypto.randomBytes(12);
  const ct = await crypto.aesGcmEncrypt(key, iv, utf8ToBytes(JSON.stringify({ v: 1, mnemonic })));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return base64.encode(out);
}

/** The mnemonic, or null when the offer doesn't open or isn't version 1. */
export async function openPhoneOffer(sealed: string, key: Uint8Array, crypto: CryptoPort): Promise<string | null> {
  try {
    const bytes = base64.decode(sealed);
    const plain = await crypto.aesGcmDecrypt(key, bytes.subarray(0, 12), bytes.subarray(12));
    const o = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    return o?.v === 1 && typeof o.mnemonic === 'string' ? o.mnemonic : null;
  } catch {
    return null;
  }
}

/** A scanned QR's text: the QR, 'expired' (60 s of skew allowed), or 'invalid'. */
export function readPhoneQr(raw: string, now: number): PhoneQr | 'expired' | 'invalid' {
  let o: Partial<PhoneQr> | null;
  try {
    o = JSON.parse(raw);
  } catch {
    return 'invalid';
  }
  if (!o || o.v !== 1 || !isXOnlyPubkey(o.pubkey) || typeof o.secret !== 'string' || !/^[0-9a-f]{64}$/.test(o.secret) || typeof o.expires !== 'number') return 'invalid';
  if (o.expires + OFFER_SKEW < now) return 'expired';
  return o as PhoneQr;
}
