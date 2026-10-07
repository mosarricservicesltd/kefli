// The secp256k1 work behind signing, verifying and NIP-44 (mobile spec 2.6 and 8). The default runs noble
// in JavaScript, as the extension and the tests use it; the phone passes shelf-secp (libsecp256k1 through
// JNI), since noble on Hermes misses the week-0 Schnorr gate (docs/specs/08-week0-gates.md).

import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import { getEventHash } from 'nostr-tools/pure';
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';

export interface SecpPort {
  /** x-only public key, hex. */
  publicKey(secretKey: Uint8Array): string;
  /** BIP-340 signature of a 32-byte hash (hex), with fresh auxiliary randomness unless aux (hex) is given. */
  sign(hash: string, secretKey: Uint8Array, aux?: string): string;
  /** False for a bad or malformed signature. */
  verify(signature: string, hash: string, publicKey: string): boolean;
  /** The x coordinate of secretKey times the even-y point with the peer's x: NIP-44's shared secret. */
  sharedX(secretKey: Uint8Array, publicKey: string): Uint8Array;
}

export const nobleSecp: SecpPort = {
  publicKey: (sk) => bytesToHex(schnorr.getPublicKey(sk)),
  sign: (hash, sk, aux) => bytesToHex(schnorr.sign(hexToBytes(hash), sk, aux ? hexToBytes(aux) : globalThis.crypto.getRandomValues(new Uint8Array(32)))),
  verify(signature, hash, publicKey) {
    try {
      return schnorr.verify(hexToBytes(signature), hexToBytes(hash), hexToBytes(publicKey));
    } catch {
      return false;
    }
  },
  sharedX: (sk, publicKey) => secp256k1.getSharedSecret(sk, hexToBytes(`02${publicKey}`)).subarray(1, 33),
};

const NIP44_SALT = utf8ToBytes('nip44-v2');

/** NIP-44 v2's conversation key, as nostr-tools derives it, through the given secp. */
export function conversationKey(secp: SecpPort, secretKey: Uint8Array, publicKey: string): Uint8Array {
  return extract(sha256, secp.sharedX(secretKey, publicKey), NIP44_SALT);
}

/** Sign a template: the same event nostr-tools' finalizeEvent makes, through the given secp. */
export function signEventWith(secp: SecpPort, template: EventTemplate, secretKey: Uint8Array): NostrEvent {
  const event = { ...template, tags: template.tags, pubkey: secp.publicKey(secretKey) };
  const id = getEventHash(event);
  return { ...event, id, sig: secp.sign(id, secretKey) };
}

/** Check an event's id and signature. Never trusts a cached verified flag, unlike nostr-tools. */
export function verifyEventWith(secp: SecpPort, event: NostrEvent): boolean {
  if (typeof event?.id !== 'string' || typeof event.sig !== 'string' || typeof event.pubkey !== 'string') return false;
  if (!/^[0-9a-f]{64}$/.test(event.pubkey)) return false;
  return getEventHash(event) === event.id && secp.verify(event.sig, event.id, event.pubkey);
}

export interface Bip340Vector {
  index: number;
  secretKey: string;
  publicKey: string;
  aux: string;
  message: string;
  signature: string;
  valid: boolean;
}

/** Rows of BIP-340's test-vectors.csv with a 32-byte message, lower-cased. */
export function parseBip340(csv: string): Bip340Vector[] {
  return csv
    .trim()
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.split(','))
    .filter((c) => c[4].length === 64)
    .map((c) => ({
      index: Number(c[0]), secretKey: c[1].toLowerCase(), publicKey: c[2].toLowerCase(), aux: c[3].toLowerCase(),
      message: c[4].toLowerCase(), signature: c[5].toLowerCase(), valid: c[6] === 'TRUE',
    }));
}

/** Run a secp port against BIP-340's vectors and a NIP-44 shared-secret check; returns the failures. */
export function checkSecp(secp: SecpPort, vectors: Bip340Vector[]): string[] {
  const bad: string[] = [];
  for (const v of vectors) {
    if (v.secretKey) {
      const sk = hexToBytes(v.secretKey);
      if (secp.publicKey(sk) !== v.publicKey) bad.push(`${v.index} public key`);
      if (secp.sign(v.message, sk, v.aux) !== v.signature) bad.push(`${v.index} signature`);
    }
    if (secp.verify(v.signature, v.message, v.publicKey) !== v.valid) bad.push(`${v.index} verify`);
  }
  // ECDH is symmetric: a·B and b·A share their x.
  const a = hexToBytes('11'.repeat(32));
  const b = hexToBytes('22'.repeat(32));
  if (bytesToHex(secp.sharedX(a, secp.publicKey(b))) !== bytesToHex(secp.sharedX(b, secp.publicKey(a)))) bad.push('sharedX symmetry');
  return bad;
}
