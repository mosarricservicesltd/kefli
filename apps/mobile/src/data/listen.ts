// Listen (mobile spec 5.7, FD 49, FD 111): its list is Unread in Saves' order, the saves with their text; with no
// session its card holds the article a row's body put there (FD 115), else the most recently played article still
// there, else the top of the list. Every article started in the voice is kept in listen_history; deleting an article
// takes it off (FD 34, by cascade).
import type { SqlDb } from './db';
import { LIB_COLS, type LibRow } from './library';
import { getSetting, setSetting } from './settings';

/** The article a Listen row's body put in the card (FD 115), until anything plays; on this phone only, like history. */
export const LISTEN_CUED = 'listen.cued';

export function setCued(db: SqlDb, hash: string): void {
  setSetting(db, LISTEN_CUED, hash);
}

export function clearCued(db: SqlDb): void {
  if (getSetting(db, LISTEN_CUED) !== null) db.run('DELETE FROM settings WHERE key = ?', LISTEN_CUED);
}

const LISTENABLE = "i.state = 'unread' AND i.text_state = 'cached' AND i.pending_delete_at IS NULL";
const I_COLS = LIB_COLS.split(', ').map((c) => `i.${c}`).join(', ');

export function recordPlayed(db: SqlDb, owner: string, hash: string, now: number): void {
  db.run(
    `INSERT INTO listen_history (item, last_played_at) SELECT id, ? FROM items WHERE owner = ? AND hash = ?
     ON CONFLICT (item) DO UPDATE SET last_played_at = excluded.last_played_at`,
    now, owner, hash,
  );
}

/** Listen's list (FD 111): Unread, newest first as on Saves, only the saves whose text is on the phone. */
export function listenRows(db: SqlDb, owner: string): LibRow[] {
  return db.all<LibRow>(
    `SELECT ${LIB_COLS} FROM items WHERE owner = ? AND state = 'unread' AND text_state = 'cached' AND pending_delete_at IS NULL
     ORDER BY saved_at DESC, id DESC`,
    owner,
  );
}

export type Ready = { row: LibRow; last: boolean };

/**
 * What Listen's card holds with no session: the article a row's body put there while it can still play ("Up next",
 * FD 115), else the most recently played article still in the list ("Last played"), else the top of the list ("Up
 * next"), else nothing (FD 111). RULED: an archived article isn't held, so the card and the list agree.
 */
export function readyRow(db: SqlDb, owner: string): Ready | null {
  const cued = getSetting(db, LISTEN_CUED);
  const chosen = cued ? db.get<LibRow>(`SELECT ${I_COLS} FROM items i WHERE i.owner = ? AND i.hash = ? AND ${LISTENABLE}`, owner, cued) : undefined;
  if (chosen) return { row: chosen, last: false };
  const last = db.get<LibRow>(
    `SELECT ${I_COLS} FROM listen_history h JOIN items i ON i.id = h.item
     WHERE i.owner = ? AND ${LISTENABLE}
     ORDER BY h.last_played_at DESC, i.id DESC LIMIT 1`,
    owner,
  );
  if (last) return { row: last, last: true };
  const top = listenRows(db, owner)[0];
  return top ? { row: top, last: false } : null;
}

/** Where an article plays from (5.7): its stored position, or the top once it was heard or read through. */
export function playFrom(r: Pick<LibRow, 'words' | 'position_word'>): number {
  return r.words && r.position_word >= r.words - 1 ? 0 : r.position_word;
}
