// One size and palette for every article (FD 16, FD 89): reader.size (15–24, default 18) and reader.palette,
// absent until one is picked, so the Reader follows the phone's theme until then.
import { useSyncExternalStore } from 'react';
import { reader } from '@kefli/tokens';
import { getSetting, setSetting } from '../data/settings';
import { store } from '../services/store';
import { readPrefs, type PaletteId } from './palette';

type Prefs = { size: number; palette: PaletteId | null };
let prefs: Prefs | null = null;
const listeners = new Set<() => void>();

function load(): Prefs {
  prefs ??= readPrefs(getSetting(store(), 'reader.size'), getSetting(store(), 'reader.palette'));
  return prefs;
}

export function useReaderPrefs(): Prefs {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), load);
}

export function setReaderSize(size: number): void {
  const s = Math.max(reader.sizeRange[0], Math.min(reader.sizeRange[1], size));
  setSetting(store(), 'reader.size', String(s));
  prefs = { ...load(), size: s };
  listeners.forEach((l) => l());
}

export function setReaderPalette(id: PaletteId): void {
  setSetting(store(), 'reader.palette', id);
  prefs = { ...load(), palette: id };
  listeners.forEach((l) => l());
}
