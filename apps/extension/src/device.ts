// The extension's own device key (contract 4.4): made at install, kept in storage.local, never the user's key.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { LocalSigner } from '../../../packages/protocol/src/signer';
import type { CryptoPort } from '../../../packages/protocol/src/ports';
import { KEYS, type Store } from './store';

export async function deviceSigner(store: Store, crypto: CryptoPort): Promise<LocalSigner> {
  let hex = await store.get<string>(KEYS.device);
  if (!hex) {
    hex = bytesToHex(crypto.randomBytes(32));
    await store.set(KEYS.device, hex);
  }
  return new LocalSigner(hexToBytes(hex));
}
