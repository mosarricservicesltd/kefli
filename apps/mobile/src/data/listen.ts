// Listen's Played list (mobile spec 5.7, FD 3, FD 49): every article started in the voice, most recent first, kept in
// listen_history; deleting an article takes it off the list (FD 34, by cascade).
import type { SqlDb } from './db';
import { LIB_COLS, type LibRow } from './library';

export function recordPlayed(db: SqlDb, owner: string, hash: string, now: number): void {
  db.run(
    `INSERT INTO listen_history (item, last_played_at) SELECT id, ? FROM items WHERE owner = ? AND hash = ?
     ON CONFLICT (item) DO UPDATE SET last_played_at = excluded.last_played_at`,
    now, owner, hash,
  );
}

export function playedRows(db: SqlDb, owner: string): LibRow[] {
  return db.all<LibRow>(
    `SELECT ${LIB_COLS.split(', ').map((c) => `i.${c}`).join(', ')} FROM listen_history h JOIN items i ON i.id = h.item
     WHERE i.owner = ? AND i.pending_delete_at IS NULL ORDER BY h.last_played_at DESC, i.id DESC`,
    owner,
  );
}

/** Where an article plays from (5.7): its stored position, or the top once it was heard or read through. */
export function playFrom(r: Pick<LibRow, 'words' | 'position_word'>): number {
  return r.words && r.position_word >= r.words - 1 ? 0 : r.position_word;
}
