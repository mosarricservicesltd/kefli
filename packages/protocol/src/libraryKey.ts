// The library key (C§4.3, F5): 32 random bytes per identity, which key every save's address so that nobody can test
// whether a library saved a page by hashing its URL. Kept on the relays in one addressable kind 30078 with d
// kefli/library-key, self-encrypted like a save, so every device of the identity, and a restore, finds it.

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { KIND, T_TAG } from './constants';
import { EventTooLargeError, eventBytes, overCeiling, signWithinCeiling } from './events';
import type { NostrEvent, Signer } from './signer';

export { savedD } from './normalise';

export const LIBRARY_KEY_D = 'kefli/library-key';

const HEX64 = /^[0-9a-f]{64}$/;

/** The record holding the key, self-encrypted: content {v: 1, key: <64 hex>}. */
export async function buildLibraryKeyEvent(signer: Signer, key: Uint8Array, createdAt: number): Promise<NostrEvent> {
  if (key.length !== 32) throw new Error('a library key is 32 bytes');
  const content = await signer.nip44Encrypt(signer.pubkey(), JSON.stringify({ v: 1, key: bytesToHex(key) }));
  return signWithinCeiling(signer, { kind: KIND.appData, created_at: createdAt, tags: [['d', LIBRARY_KEY_D], ['t', T_TAG]], content });
}

/**
 * The key in this identity's record. Throws for anything else, or a version this client doesn't read; a record over
 * the 16 KB ceiling (C§3.3), which no Kefli client makes, is refused before it is decrypted.
 */
export async function readLibraryKeyEvent(signer: Signer, event: NostrEvent): Promise<Uint8Array> {
  if (event.kind !== KIND.appData || event.pubkey !== signer.pubkey()) throw new Error('not this identity’s record');
  if (event.tags.find((t) => t[0] === 'd')?.[1] !== LIBRARY_KEY_D) throw new Error('not the library key record');
  if (overCeiling(event)) throw new EventTooLargeError(eventBytes(event));
  const r = JSON.parse(await signer.nip44Decrypt(signer.pubkey(), event.content)) as { v?: unknown; key?: unknown };
  if (r?.v !== 1 || typeof r.key !== 'string' || !HEX64.test(r.key)) throw new Error('library key record not understood');
  return hexToBytes(r.key);
}
