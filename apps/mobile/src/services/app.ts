// What the app shows at the root (mobile spec 3.1, 5.1, 6.1): Welcome until it is answered, then the library. The
// resolver decides at launch; New here and the end of a restore move it on. Screens read it with useApp().
import { useSyncExternalStore } from 'react';
import { activeOwner } from '../data/library';
import { resolveFailedLaunch, type Origin } from '../data/resolver';
import { WELCOME_ANSWERED, getSetting } from '../data/settings';
import { launchPlan } from './launchState';
import { adoptRecovery, newHere } from './identity';
import { store } from './store';
import { onMoveDone, runSync } from './runner';
import { keepBackgroundSync } from './background';

export type AppState = { route: 'welcome' | 'welcome-early' | 'saves'; owner: string | null; restoreCard: boolean };

let state: AppState | null = null;
const listeners = new Set<() => void>();
const set = (s: AppState) => {
  state = s;
  listeners.forEach((l) => l());
  // the background worker (4.8) runs while the phone has a library and stops when it goes: Delete my data and Sign out
  // both end here, at Welcome
  keepBackgroundSync(s.owner !== null).catch((e) => console.log(`[kefli-background] ${JSON.stringify({ error: String((e as Error).message) })}`));
};

export function useApp(): AppState | null {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), () => state);
}

export function appState(): AppState | null {
  return state;
}

/**
 * Reads the resolver's plan once, at launch. A launch that failed (the Keystore not ready, F21) routes on the
 * database's identity row instead, so a library on the phone opens rather than Welcome offering to make a key over
 * it; with no row, Welcome.
 */
export async function boot(): Promise<void> {
  try {
    const p = await launchPlan();
    set({ route: p.route, owner: activeOwner(store()), restoreCard: p.restoreCard });
  } catch {
    let owner: string | null = null;
    let route: AppState['route'] = 'welcome';
    try {
      const db = store();
      const id = db.get<{ pubkey: string; origin: string | null }>("SELECT pubkey, origin FROM identities WHERE role = 'active'");
      route = resolveFailedLaunch({ identity: id ? { origin: (id.origin ?? 'new') as Origin } : null, welcomeAnswered: getSetting(db, WELCOME_ANSWERED) === '1' });
      owner = route === 'welcome' ? null : (id?.pubkey ?? null);
    } catch {
      // no database either: Welcome, as on a new phone
    }
    set({ route, owner, restoreCard: false });
  }
}

/** New here: the key (an early share's, or a new one), Welcome answered, and a root swap to Saves. */
export async function answerNewHere(): Promise<void> {
  const owner = await newHere();
  set({ route: 'saves', owner, restoreCard: false });
}

/** A recovery code that found a library, or another phone's:  the key stored, and a root swap to Saves with the restore card (5.3). */
export async function answerRecovered(mnemonic: string, origin: 'recovery_code' | 'phone_pair' = 'recovery_code'): Promise<void> {
  const owner = await adoptRecovery(mnemonic, origin);
  set({ route: 'saves', owner, restoreCard: true });
  // the restore is this sync (C§8); launch's sync ran before there was a key
  runSync().catch(() => undefined);
}

/** After Delete my data (FD 74): a root swap to Welcome, as if just installed. */
export function answerDeleted(): void {
  set({ route: 'welcome', owner: null, restoreCard: false });
}

/** Signed in with a nostr app (5.3): a root swap to Saves with the restore card, and the restore started. */
export function answerSignedIn(owner: string): void {
  set({ route: 'saves', owner, restoreCard: true });
  runSync().catch(() => undefined);
}

// a finished move (C§4.8) leaves T as the phone's identity: the library on screen follows, wherever the move ran
onMoveDone((owner) => {
  if (state && state.owner !== owner) set({ ...state, owner });
});
