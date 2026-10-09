import { requireNativeModule } from 'expo-modules-core';

/** One identity in the key file (mobile spec 3.2). sk is hex; read() never returns mnemonic. */
export type KeyIdentity = {
  pubkey: string; provider: 'local' | 'nip55' | 'nip46'; sk?: string; mnemonic?: string; origin?: string;
  /** NIP-55: the signer app's package. */
  package?: string;
  /** NIP-46: the bunker:// link signed in with, and the client key Shelf made for it (hex). */
  bunker?: string; client?: string;
};
export type KeyRecord = { v: 1; identities: KeyIdentity[] };

const native = requireNativeModule<{
  read(): Promise<string | null>;
  readMnemonic(pubkey: string): Promise<string | null>;
  write(json: string): Promise<void>;
  wipe(pubkey: string): Promise<void>;
  strongBox(): Promise<boolean>;
  blockStoreGet(): Promise<string | null>;
  blockStoreSet(mnemonic: string): Promise<{ cloud: boolean }>;
  blockStoreRemove(): Promise<void>;
  isE2EEAvailable(): Promise<boolean>;
}>('KefliKeystore');

/** mobile spec 8.3. */
export const KefliKeystore = {
  async read(): Promise<KeyRecord | null> {
    const raw = await native.read();
    return raw ? (JSON.parse(raw) as KeyRecord) : null;
  },
  readMnemonic: native.readMnemonic,
  write: (r: KeyRecord) => native.write(JSON.stringify(r)),
  wipe: native.wipe,
  strongBox: native.strongBox,
  blockStoreGet: native.blockStoreGet,
  blockStoreSet: native.blockStoreSet,
  blockStoreRemove: native.blockStoreRemove,
  isE2EEAvailable: native.isE2EEAvailable,
};
