import { requireNativeModule } from 'expo-modules-core';

export type SpoolEntry = { v: 1; id: string; text: string | null; subject: string | null; referrer: string | null; receivedAt: number };

interface ShelfShareModule {
  readSpool(id: string): string | null;
  deleteSpool(id: string): boolean;
  listSpools(): string[];
  /** Ends the share activity: 'host' returns to the sender, 'read' also opens the Reader on hash. */
  finish(mode: 'host' | 'read', hash?: string | null): boolean;
}

const native = requireNativeModule<ShelfShareModule>('ShelfShare');

export const ShelfShare = {
  ...native,
  read(id: string): SpoolEntry | null {
    const raw = native.readSpool(id);
    return raw ? (JSON.parse(raw) as SpoolEntry) : null;
  },
};
