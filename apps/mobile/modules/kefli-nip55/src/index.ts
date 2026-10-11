import { requireNativeModule } from 'expo-modules-core';
import { nip19 } from 'nostr-tools';
import { nip55Permissions, type Nip55Port } from '@kefli/protocol';

/** mobile spec 8.4. Errors carry code 'rejected', 'not_installed', 'timeout' or 'unavailable'. */
const native = requireNativeModule<{
  listSigners(): Promise<{ package: string; label: string }[]>;
  getPublicKey(pkg: string | null, permissions: string): Promise<{ pubkey: string; package: string }>;
  signEvent(pkg: string, eventJson: string, hex: string, npub: string): Promise<string>;
  nip44Encrypt(pkg: string, plaintext: string, peer: string, hex: string, npub: string): Promise<string>;
  nip44Decrypt(pkg: string, ciphertext: string, peer: string, hex: string, npub: string): Promise<string>;
  canActInBackground(pkg: string, peer: string, hex: string): Promise<boolean>;
  signInBackground(pkg: string, eventJson: string, hex: string): Promise<boolean>;
}>('KefliNip55');

const npub = (hex: string) => nip19.npubEncode(hex);
/** A signer may answer get_public_key with an npub or hex. */
const hexOf = (pk: string) => (pk.startsWith('npub') ? (nip19.decode(pk).data as string) : pk.toLowerCase());

export const KefliNip55 = {
  listSigners: native.listSigners,
  async getPublicKey(pkg: string | null): Promise<{ pubkey: string; package: string }> {
    const r = await native.getPublicKey(pkg, JSON.stringify(nip55Permissions()));
    return { pubkey: hexOf(r.pubkey), package: r.package };
  },
};

/** The port Nip55Signer calls (packages/protocol). */
export const nip55Port: Nip55Port = {
  signEvent: (pkg, json, pk) => native.signEvent(pkg, json, pk, npub(pk)),
  nip44Encrypt: (pkg, text, peer, pk) => native.nip44Encrypt(pkg, text, peer, pk, npub(pk)),
  nip44Decrypt: (pkg, text, peer, pk) => native.nip44Decrypt(pkg, text, peer, pk, npub(pk)),
  canActInBackground: (pkg, pk) => native.canActInBackground(pkg, pk, pk),
  signInBackground: (pkg, json, pk) => native.signInBackground(pkg, json, pk),
};
