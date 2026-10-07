// What the app shows at the root (mobile spec 3.1, 5.1, 6.1): Welcome until it is answered, then the shelf. The
// resolver decides at launch; New here and the end of a restore move it on. Screens read it with useApp().
import { useSyncExternalStore } from 'react';
import { activeOwner } from '../data/library';
import { launchPlan } from './launchState';
import { newHere } from './identity';
import { store } from './store';

export type AppState = { route: 'welcome' | 'welcome-early' | 'saves'; owner: string | null; restoreCard: boolean };

let state: AppState | null = null;
const listeners = new Set<() => void>();
const set = (s: AppState) => {
  state = s;
  listeners.forEach((l) => l());
};

export function useApp(): AppState | null {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state);
}

export function appState(): AppState | null {
  return state;
}

/** Reads the resolver's plan once, at launch. A failed resolver opens Welcome, which can make a key. */
export async function boot(): Promise<void> {
  try {
    const p = await launchPlan();
    set({ route: p.route, owner: activeOwner(store()), restoreCard: p.restoreCard });
  } catch {
    set({ route: 'welcome', owner: null, restoreCard: false });
  }
}

/** New here: the key (an early share's, or a new one), Welcome answered, and a root swap to Saves. */
export async function answerNewHere(): Promise<void> {
  const owner = await newHere();
  set({ route: 'saves', owner, restoreCard: false });
}
