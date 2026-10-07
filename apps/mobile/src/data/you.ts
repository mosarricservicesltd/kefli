// You (mobile spec 5.8, FD 17, FD 25, FD 27, FD 68): the counts beside the quilt, the quilt's newest covers, the
// connected browsers, and the backup card. backup.state stays not_done until the words are shown (3.5); Later
// hides the card for ten more saves (backup.snooze_until holds the save count it returns at).
import type { SqlDb } from './db';
import { getSetting, setSetting } from './settings';

export const SNOOZE_SAVES = 10;
export const QUILT = 8;

export type YouStats = { saves: number; listened: number; quilt: { hash: string; failed: boolean }[]; browsers: number };

export function youStats(db: SqlDb, owner: string): YouStats {
  const saves = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM items WHERE owner = ? AND pending_delete_at IS NULL', owner)?.n ?? 0;
  const listened = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM listen_history h JOIN items i ON i.id = h.item WHERE i.owner = ?', owner)?.n ?? 0;
  const quilt = db.all<{ hash: string; text_state: string }>(
    'SELECT hash, text_state FROM items WHERE owner = ? AND pending_delete_at IS NULL ORDER BY saved_at DESC, id DESC LIMIT ?', owner, QUILT,
  ).map((r) => ({ hash: r.hash, failed: r.text_state === 'failed' }));
  const browsers = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM devices WHERE owner = ? AND revoked_at IS NULL', owner)?.n ?? 0;
  return { saves, listened, quilt, browsers };
}

export function backupDone(db: SqlDb): boolean {
  return getSetting(db, 'backup.state') === 'done';
}

/** The backup card shows for an identity with a recovery code, until it is written down, unless snoozed. */
export function showBackupCard(db: SqlDb, owner: string, saves: number): boolean {
  const recovery = db.get<{ has_recovery: number }>('SELECT has_recovery FROM identities WHERE pubkey = ?', owner)?.has_recovery;
  if (!recovery || backupDone(db)) return false;
  const until = Number(getSetting(db, 'backup.snooze_until'));
  return !until || saves >= until;
}

/** Later: the card comes back after ten more saves (FD 17). */
export function snoozeBackup(db: SqlDb, saves: number): void {
  setSetting(db, 'backup.snooze_until', String(saves + SNOOZE_SAVES));
}

/** The words were shown (FD 27): the card goes and the row reads "Written down". */
export function markBackupDone(db: SqlDb): void {
  setSetting(db, 'backup.state', 'done');
}
