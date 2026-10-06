// Reading a test identity's secret for the Node tools (npm run decrypt, npm run unwrap).

import { decode } from 'nostr-tools/nip19';
import { hexToBytes } from '@noble/hashes/utils.js';
import { secretKeyFromMnemonic } from './keys';
import type { CryptoPort } from './ports';

/** 64 hex characters or an nsec; with crypto given, also the twelve words. Throws otherwise. */
export async function parseSecret(raw: string | undefined, crypto?: CryptoPort): Promise<Uint8Array> {
  const s = (raw ?? '').trim();
  if (/^[0-9a-f]{64}$/i.test(s)) return hexToBytes(s.toLowerCase());
  if (s.startsWith('nsec1')) return nsec(s);
  if (crypto && s.includes(' ')) return secretKeyFromMnemonic(s, crypto);
  throw new Error(`set SHELF_SECRET to a test key: 64 hex characters or an nsec${crypto ? ', or the twelve words' : ''}`);
}

function nsec(s: string): Uint8Array {
  const d = decode(s);
  if (d.type !== 'nsec') throw new Error('not an nsec');
  return d.data;
}
