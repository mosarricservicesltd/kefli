// Listen (mobile spec 5.7, FD 49, FD 111): its list is Unread in Saves' order, the saves with their text; with no
// session its card holds the most recently played article still there, else the top of the list. Every article
// started in the voice is kept in listen_history; deleting an article takes it off (FD 34, by cascade).
import type { SqlDb } from './db';
import { LIB_COLS, type LibRow } from './library';

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
 * What Listen's card holds with no session (FD 111): the most recently played article still in the list ("Last
 * played"), else the top of the list ("Up next"), else nothing. RULED: an archived article isn't held, so the card and
 * the list agree.
 */
export function readyRow(db: SqlDb, owner: string): Ready | null {
  const last = db.get<LibRow>(
    `SELECT ${LIB_COLS.split(', ').map((c) => `i.${c}`).join(', ')} FROM listen_history h JOIN items i ON i.id = h.item
     WHERE i.owner = ? AND i.state = 'unread' AND i.text_state = 'cached' AND i.pending_delete_at IS NULL
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
