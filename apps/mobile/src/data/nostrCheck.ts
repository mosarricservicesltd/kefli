// Saving without asking (FD 104): whether the person's nostr app signs everything saving does out of sight without
// asking, as last checked. A sign-in records it; earlier sign-ins are checked again at most once a day.
import type { SqlDb } from './db';
import { getSetting, setSetting } from './settings';

/** '1' while the nostr app asks before saves, '0' once it doesn't; absent until checked. */
export const NOSTR_ASKS = 'nostr.asks';
const CHECKED_AT = 'nostr.checked_at';
const DAY = 24 * 60 * 60;

export function recordCheck(db: SqlDb, now: number, missing: readonly unknown[]): void {
  setSetting(db, NOSTR_ASKS, missing.length ? '1' : '0');
  setSetting(db, CHECKED_AT, String(now));
}

/** The You row's stamp, and Your nostr app's Saving row. */
export function asksBeforeSaving(db: SqlDb): boolean {
  return getSetting(db, NOSTR_ASKS) === '1';
}

/** A check is due on the first launch after a sign-in made before FD 104, then a day after the last. */
export function checkDue(db: SqlDb, now: number): boolean {
  const last = getSetting(db, CHECKED_AT);
  return last === null || now - Number(last) >= DAY;
}
