// Search (mobile spec 4.9, 5.6, FD 50, FD 51): FTS5 over title, site, address and the spoken projection, each word a
// prefix, every word required, ranked by bm25 across Unread and Archive. A save whose text isn't here yet has no
// search entry, so its title, site and address are matched directly and ranked after the indexed ones.
import type { SqlDb } from './db';
import { type LibRow } from './library';

const COLS = 'i.id, i.hash, i.url, i.title, i.site, i.words, i.position_word, i.state, i.text_state, i.fail_reason, i.origin, i.saved_at, i.byline, i.lang, i.text_sha256, i.text_servers, i.hero, i.x_state';

/** The words of a query: letters and digits, as FTS5's unicode61 tokeniser splits them. */
export function queryWords(q: string): string[] {
  return q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** An FTS5 MATCH expression: each word quoted and taken as a prefix, all of them required. */
export function matchExpression(words: string[]): string {
  return words.map((w) => `"${w.replace(/"/g, '""')}"*`).join(' AND ');
}

export function search(db: SqlDb, owner: string, q: string, limit = 200): LibRow[] {
  const words = queryWords(q);
  if (!words.length) return [];
  const indexed = db.all<LibRow>(
    `SELECT ${COLS} FROM items_fts f JOIN items i ON i.id = f.rowid
     WHERE items_fts MATCH ? AND i.owner = ? AND i.pending_delete_at IS NULL ORDER BY bm25(items_fts), i.saved_at DESC LIMIT ?`,
    matchExpression(words), owner, limit,
  );
  // Saves without a search entry: every word must start a word of the title, site or address.
  const like = words.map(() => "(' ' || lower(coalesce(i.title, '') || ' ' || coalesce(i.site, '') || ' ' || i.url)) GLOB ?").join(' AND ');
  const plain = db.all<LibRow>(
    `SELECT ${COLS} FROM items i WHERE i.owner = ? AND i.pending_delete_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM items_fts f WHERE f.rowid = i.id) AND ${like} ORDER BY i.saved_at DESC LIMIT ?`,
    owner, ...words.map((w) => `*[^a-z0-9]${w.replace(/[*?[\]]/g, '')}*`), limit,
  );
  return [...indexed, ...plain].slice(0, limit);
}
