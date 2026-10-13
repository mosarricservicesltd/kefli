// Where the operator's defaults come from, set by the build (app.config.js): the local stack in server/dev for
// KEFLI_VARIANT=local, otherwise the operator's https URL. The build also bakes in a copy (contract 3.1, F1), and
// defaultsPick.ts chooses between the fresh, kept and baked copies.
import Constants from 'expo-constants';
import type { SqlDb } from '../data/db';
import { getSetting, setSetting } from '../data/settings';
import { freshState, pickDefaults, validDefaults, type Defaults } from './defaultsPick';

export type { Defaults } from './defaultsPick';

type BuildConfig = { variant: 'local' | 'release'; defaultsUrl: string; baked?: Defaults };
const build = (Constants.expoConfig?.extra?.kefli ?? { variant: 'release', defaultsUrl: '' }) as BuildConfig;

export const DEFAULTS_URL = build.defaultsUrl;
/** The local stack's ws:// relays and http:// servers are allowed only in the local build. */
export const LOCAL_STACK = build.variant === 'local';

/** The settings key holding the last copy that parsed. */
export const DEFAULTS_KEY = 'defaults.kept';

const state = freshState();
let db: (() => SqlDb) | null = null;

export async function loadDefaults(): Promise<Defaults> {
  // the store is required lazily: config is imported by modules the store's own imports reach
  db ??= (require('./store') as typeof import('./store')).store;
  return pickDefaults({
    url: DEFAULTS_URL, baked: validDefaults(build.baked) ? build.baked : null, fetch, now: Date.now,
    read: () => getSetting(db!(), DEFAULTS_KEY), write: (json) => setSetting(db!(), DEFAULTS_KEY, json),
  }, state);
}
