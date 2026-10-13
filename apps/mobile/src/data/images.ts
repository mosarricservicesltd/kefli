// Article images kept on the phone (mobile spec 4.1, 4.5 phase 6): the images table, what to fetch next and what to
// evict. Images live in app storage, since an image cache can evict and C§4.2 needs them offline. On unmetered
// networks the newest 50 unread articles' images are kept, at most 5 MB each and 200 MB in all, archived ones
// evicted first; on metered networks an article's images are fetched when it opens.
import type { SqlDb } from './db';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
export const ARTICLES = 50;
/** A failed fetch is tried again after a day. */
export const RETRY_SEC = 86_400;

export type ImageRow = {
  url: string; hash: string | null; path: string | null; bytes: number | null; w: number | null; h: number | null;
  fetched_at: number | null; last_used_at: number | null;
};

export function getImage(db: SqlDb, url: string): ImageRow | undefined {
  return db.get<ImageRow>('SELECT * FROM images WHERE url = ?', url);
}

/** Whether an image needs fetching: never tried, or a failure more than a day old. */
export function needsFetch(row: ImageRow | undefined, now: number): boolean {
  if (!row) return true;
  if (row.path) return false;
  return now - (row.fetched_at ?? 0) >= RETRY_SEC;
}

export function recordImage(db: SqlDb, url: string, hash: string, path: string, bytes: number, w: number | null, h: number | null, now: number): void {
  db.run(
    'INSERT OR REPLACE INTO images (url, hash, path, bytes, w, h, fetched_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    url, hash, path, bytes, w, h, now, now,
  );
}

/** A fetch that failed (too large, not an image, an HTTP error): kept so it isn't tried again for a day. */
export function recordFailed(db: SqlDb, url: string, hash: string, now: number): void {
  db.run('INSERT OR REPLACE INTO images (url, hash, path, bytes, w, h, fetched_at, last_used_at) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, NULL)', url, hash, now);
}

export function markUsed(db: SqlDb, url: string, now: number): void {
  db.run('UPDATE images SET last_used_at = ? WHERE url = ?', now, url);
}

/**
 * The newest unread articles whose text is on the phone and that have been opened, newest first: the ones whose
 * images are kept. An article opened is one the Reader has asked images for, or read in. Images go to their sites only
 * when an article is read (privacy page, mobile spec 7.3, F26), so the sync only fetches again what reading asked for.
 */
export function keptArticles(db: SqlDb, owner: string, n = ARTICLES): string[] {
  return db.all<{ hash: string }>(
    `SELECT hash FROM items i WHERE owner = ? AND state = 'unread' AND text_state = 'cached' AND pending_delete_at IS NULL
       AND (last_opened_at IS NOT NULL OR EXISTS (SELECT 1 FROM images m WHERE m.hash = i.hash))
     ORDER BY saved_at DESC, id DESC LIMIT ?`,
    owner, n,
  ).map((r) => r.hash);
}

/** The images still to fetch for these articles, in order, given each article's image addresses. */
export function wanted(db: SqlDb, hashes: string[], urlsOf: (hash: string) => string[], now: number): { url: string; hash: string }[] {
  const out: { url: string; hash: string }[] = [];
  const seen = new Set<string>();
  for (const hash of hashes) {
    for (const url of urlsOf(hash)) {
      if (seen.has(url)) continue;
      seen.add(url);
      if (needsFetch(getImage(db, url), now)) out.push({ url, hash });
    }
  }
  return out;
}

/**
 * What to evict to bring the store within budget after adding `incoming` bytes: archived articles' images first,
 * then images of articles outside the kept set, then the least recently used; never those of `protect` (the open
 * article). Returns the rows whose files go.
 */
export function evictions(db: SqlDb, owner: string, incoming: number, protect: string | null, budget = MAX_TOTAL_BYTES): ImageRow[] {
  const total = db.get<{ n: number | null }>('SELECT SUM(bytes) AS n FROM images WHERE path IS NOT NULL')?.n ?? 0;
  let over = total + incoming - budget;
  if (over <= 0) return [];
  const kept = new Set(keptArticles(db, owner));
  const rows = db.all<ImageRow & { state: string | null }>(
    `SELECT images.*, items.state AS state FROM images LEFT JOIN items ON items.hash = images.hash AND items.owner = ?
     WHERE images.path IS NOT NULL ORDER BY COALESCE(images.last_used_at, 0)`,
    owner,
  );
  const rank = (r: { state: string | null; hash: string | null }) => (r.state === 'archived' || r.state === null ? 0 : kept.has(r.hash ?? '') ? 2 : 1);
  const order = rows.filter((r) => r.hash !== protect).sort((a, b) => rank(a) - rank(b));
  const out: ImageRow[] = [];
  for (const r of order) {
    if (over <= 0) break;
    out.push(r);
    over -= r.bytes ?? 0;
  }
  return out;
}

export function forget(db: SqlDb, urls: string[]): void {
  db.tx(() => {
    for (const u of urls) db.run('DELETE FROM images WHERE url = ?', u);
  });
}

/** An article's images, whose files go with it (4.5: a deletion removes its images). */
export function imagesOf(db: SqlDb, hash: string): ImageRow[] {
  return db.all<ImageRow>('SELECT * FROM images WHERE hash = ?', hash);
}
