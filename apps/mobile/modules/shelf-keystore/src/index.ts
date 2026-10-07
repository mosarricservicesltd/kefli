import { requireNativeModule } from 'expo-modules-core';

/** One identity in the key file (mobile spec 3.2). sk is hex; read() never returns mnemonic. */
export type KeyIdentity = { pubkey: string; provider: 'local' | 'nip55' | 'nip46'; sk?: string; mnemonic?: string; origin?: string };
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
}>('ShelfKeystore');

/** mobile spec 8.3. */
export const ShelfKeystore = {
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
