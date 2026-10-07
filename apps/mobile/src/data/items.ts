// Items: the saves on this phone (mobile spec 4.1, 4.2). The item JSON is rebuilt from the row at send time,
// unknown fields re-emitted from extra, so the outbox always publishes the latest state.
import type { Item, ItemText, ParsedItem } from '@shelf/protocol';
import type { SqlDb } from './db';

export type ItemRow = {
  id: number; owner: string; hash: string; v: number; url: string; canonical: string | null; title: string | null;
  site: string | null; byline: string | null; saved_at: number; state: 'unread' | 'archived'; progress: number;
  words: number | null; lang: string | null; text_sha256: string | null; text_key: string | null; text_nonce: string | null;
  text_servers: string | null; text_hash: string | null; hero: string | null; source_kind: string; source_ref: string | null;
  audio_pref: string | null; extra: string | null; event_id: string | null; event_created_at: number | null;
  published: number; text_state: string; origin: string;
};

export type NewItem = {
  owner: string; hash: string; url: string; canonical: string | null; title: string | null; site: string | null;
  byline: string | null; savedAt: number; words: number | null; lang: string | null; hero: string | null;
  text: Omit<ItemText, 'servers'> | null; textHash: string | null; textState: 'cached' | 'failed'; failReason?: string | null;
  sharedUrl?: string | null; origin: string;
};

export function insertItem(db: SqlDb, now: number, n: NewItem): number {
  return db.run(
    `INSERT INTO items (owner, hash, url, canonical, title, site, byline, saved_at, state, words, lang, hero,
      text_sha256, text_key, text_nonce, text_hash, text_state, fail_reason, shared_url, origin, modified_at, dirty)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    n.owner, n.hash, n.url, n.canonical, n.title, n.site, n.byline, n.savedAt, n.words, n.lang, n.hero,
    n.text?.sha256 ?? null, n.text?.key ?? null, n.text?.nonce ?? null, n.textHash, n.textState, n.failReason ?? null,
    n.sharedUrl ?? null, n.origin, now,
  ).lastInsertRowId;
}

export function getItem(db: SqlDb, owner: string, hash: string): ItemRow | undefined {
  return db.get<ItemRow>('SELECT * FROM items WHERE owner = ? AND hash = ?', owner, hash);
}

/** The item JSON for a row (contract 4.1), text.servers as given (the operator and the mirror that holds it). */
export function itemJson(row: ItemRow, servers: string[]): ParsedItem {
  const text: ItemText | null = row.text_sha256 && row.text_key && row.text_nonce
    ? { sha256: row.text_sha256, key: row.text_key, nonce: row.text_nonce, servers }
    : null;
  const item: Item = {
    v: 1, url: row.url, canonical: row.canonical, title: row.title, site: row.site, byline: row.byline,
    saved_at: row.saved_at, state: row.state, progress: row.progress, words: row.words, lang: row.lang,
    text, text_hash: text ? row.text_hash : null, hero: row.hero, source_kind: 'web',
    ...(row.source_ref ? { source_ref: row.source_ref } : {}),
    audio_pref: null,
  };
  return { item, extra: row.extra ? JSON.parse(row.extra) : {} };
}

export function markPublished(db: SqlDb, owner: string, hash: string, eventId: string, createdAt: number): void {
  db.run('UPDATE items SET event_id = ?, event_created_at = ?, published = 1, dirty = 0 WHERE owner = ? AND hash = ?', eventId, createdAt, owner, hash);
}
