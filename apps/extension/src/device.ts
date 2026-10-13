// The extension's own device key (contract 4.4): made at install, kept in storage.local, never the user's key.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { LocalSigner } from '../../../packages/protocol/src/signer';
import type { CryptoPort } from '../../../packages/protocol/src/ports';
import { exclusive } from './lock';
import { KEYS, type Store } from './store';

/**
 * The key, made under a lock the options page and the background share, and looked for again once the lock is held, so
 * two pages opening at first install end with one key rather than pairing with one and sealing saves with another (F52).
 */
export async function deviceSigner(store: Store, crypto: CryptoPort): Promise<LocalSigner> {
  const hex = (await store.get<string>(KEYS.device)) ?? (await exclusive('device', async () => {
    const made = await store.get<string>(KEYS.device);
    if (made) return made;
    const fresh = bytesToHex(crypto.randomBytes(32));
    await store.set(KEYS.device, fresh);
    return fresh;
  }));
  return new LocalSigner(hexToBytes(hex));
}
