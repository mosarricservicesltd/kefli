import { requireNativeModule, type EventSubscription } from 'expo-modules-core';

export type SpoolEntry = { v: 1; id: string; text: string | null; subject: string | null; referrer: string | null; receivedAt: number };

type Events = {
  /** The sheet in front changed: its spool, or null when no sheet is in front. */
  top: (e: { spoolId: string | null }) => void;
  /** The sheet of spoolId stopped with no sheet in front of it: locked, another app on top, or recreated. */
  left: (e: { spoolId: string }) => void;
};

interface KefliShareModule {
  readSpool(id: string): string | null;
  deleteSpool(id: string): boolean;
  listSpools(): string[];
  /** Ends the share activity of spoolId: 'host' returns to the sender, 'read' also opens the Reader on hash. */
  finish(mode: 'host' | 'read', hash: string | null, spoolId: string | null): boolean;
  addListener<K extends keyof Events>(name: K, listener: Events[K]): EventSubscription;
}

const native = requireNativeModule<KefliShareModule>('KefliShare');

export const KefliShare = {
  ...native,
  addListener: <K extends keyof Events>(name: K, listener: Events[K]) => native.addListener(name, listener),
  read(id: string): SpoolEntry | null {
    const raw = native.readSpool(id);
    return raw ? (JSON.parse(raw) as SpoolEntry) : null;
  },
};
