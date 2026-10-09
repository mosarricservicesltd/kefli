import { requireNativeModule } from 'expo-modules-core';

export type SpoolEntry = { v: 1; id: string; text: string | null; subject: string | null; referrer: string | null; receivedAt: number };

interface KefliShareModule {
  readSpool(id: string): string | null;
  deleteSpool(id: string): boolean;
  listSpools(): string[];
  /** Ends the share activity of spoolId: 'host' returns to the sender, 'read' also opens the Reader on hash. */
  finish(mode: 'host' | 'read', hash: string | null, spoolId: string | null): boolean;
}

const native = requireNativeModule<KefliShareModule>('KefliShare');

export const KefliShare = {
  ...native,
  read(id: string): SpoolEntry | null {
    const raw = native.readSpool(id);
    return raw ? (JSON.parse(raw) as SpoolEntry) : null;
  },
};
