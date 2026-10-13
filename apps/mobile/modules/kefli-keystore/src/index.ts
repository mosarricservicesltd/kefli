import { requireNativeModule } from 'expo-modules-core';

/**
 * One identity in the key file (mobile spec 3.2). sk and client are hex. read() returns none of the secrets (sk,
 * client, mnemonic): readSecret and readMnemonic return one identity's, and write() keeps those an identity is
 * written without.
 */
export type KeyIdentity = {
  pubkey: string; provider: 'local' | 'nip55' | 'nip46'; sk?: string; mnemonic?: string; origin?: string;
  /** NIP-55: the signer app's package. */
  package?: string;
  /** NIP-46: the bunker:// link signed in with, and the client key Kefli made for it (hex). */
  bunker?: string; client?: string;
};
export type KeyRecord = { v: 1; identities: KeyIdentity[] };

/** Block Store's entry against an identity's words: empty, the same, another key's; null where a check failed. */
export type BlockStoreCheck = { entry: 'empty' | 'same' | 'other' | null; e2ee: boolean | null };

const native = requireNativeModule<{
  read(): Promise<string | null>;
  readMnemonic(pubkey: string): Promise<string | null>;
  readSecret(pubkey: string): Promise<string | null>;
  write(json: string): Promise<void>;
  wipe(pubkey: string): Promise<void>;
  wipeAll(): Promise<void>;
  strongBox(): Promise<boolean>;
  blockStoreGet(): Promise<string | null>;
  blockStoreSet(mnemonic: string): Promise<{ cloud: boolean }>;
  blockStoreCheck(pubkey: string): Promise<BlockStoreCheck | null>;
  blockStoreSetFrom(pubkey: string): Promise<{ cloud: boolean }>;
  blockStoreRemove(): Promise<void>;
  isE2EEAvailable(): Promise<boolean>;
}>('KefliKeystore');

/**
 * mobile spec 8.3. read() resolves null only for no identity (no file, a lost key, a file that key can't open), and
 * rejects when the Keystore fails, which is never no identity (F21).
 */
export const KefliKeystore = {
  async read(): Promise<KeyRecord | null> {
    const raw = await native.read();
    return raw ? (JSON.parse(raw) as KeyRecord) : null;
  },
  readMnemonic: native.readMnemonic,
  /** A local identity's sk, or a NIP-46 identity's client key: for building its signer, and nothing else. */
  readSecret: native.readSecret,
  write: (r: KeyRecord) => native.write(JSON.stringify(r)),
  wipe: native.wipe,
  /** Delete my data and Sign out: the file goes without being opened. */
  wipeAll: native.wipeAll,
  strongBox: native.strongBox,
  blockStoreGet: native.blockStoreGet,
  blockStoreSet: native.blockStoreSet,
  /** null when the identity has no words (a nostr app's). */
  blockStoreCheck: native.blockStoreCheck,
  /** Writes the identity's words from the key file. */
  blockStoreSetFrom: native.blockStoreSetFrom,
  blockStoreRemove: native.blockStoreRemove,
  isE2EEAvailable: native.isE2EEAvailable,
};
