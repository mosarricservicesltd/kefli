// Items: the saves on this phone (mobile spec 4.1, 4.2). The item JSON is rebuilt from the row at send time,
// unknown fields re-emitted from extra, so the outbox always publishes the latest state.
import { sameUrl, type Item, type ItemText, type ParsedItem } from '@kefli/protocol';
import type { SqlDb } from './db';

export type ItemRow = {
  id: number; owner: string; hash: string; v: number; url: string; canonical: string | null; title: string | null;
  site: string | null; byline: string | null; saved_at: number; state: 'unread' | 'archived'; progress: number;
  words: number | null; lang: string | null; text_sha256: string | null; text_key: string | null; text_nonce: string | null;
  text_servers: string | null; text_hash: string | null; hero: string | null; source_kind: string; source_ref: string | null;
  audio_pref: string | null; extra: string | null; event_id: string | null; event_created_at: number | null;
  published: number; text_state: string; origin: string;
  /** The address the save was last published or seen at (F5). */
  remote_d: string | null;
  /** Set while a delete's Undo can still bring the save back (F38). */
  pending_delete_at: number | null;
};

export type NewItem = {
  owner: string; hash: string; url: string; canonical: string | null; title: string | null; site: string | null;
  byline: string | null; savedAt: number; words: number | null; lang: string | null; hero: string | null;
  text: Omit<ItemText, 'servers'> | null; textHash: string | null; textState: 'cached' | 'failed' | 'queued'; failReason?: string | null;
  sharedUrl?: string | null; origin: string;
  /** A shared X post waiting for its check (5.4): 'pending'. */
  xState?: string | null;
};

export function insertItem(db: SqlDb, now: number, n: NewItem): number {
  return db.run(
    `INSERT INTO items (owner, hash, url, canonical, title, site, byline, saved_at, state, words, lang, hero,
      text_sha256, text_key, text_nonce, text_hash, text_state, fail_reason, shared_url, origin, modified_at, dirty, x_state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    n.owner, n.hash, n.url, n.canonical, n.title, n.site, n.byline, n.savedAt, n.words, n.lang, n.hero,
    n.text?.sha256 ?? null, n.text?.key ?? null, n.text?.nonce ?? null, n.textHash, n.textState, n.failReason ?? null,
    n.sharedUrl ?? null, n.origin, now, n.xState ?? null,
  ).lastInsertRowId;
}

export function getItem(db: SqlDb, owner: string, hash: string): ItemRow | undefined {
  return db.get<ItemRow>('SELECT * FROM items WHERE owner = ? AND hash = ?', owner, hash);
}

/**
 * The item JSON for a row (contract 4.1), text.servers as given (the operator and the mirror that holds it). servers
 * null: no server holds the text yet, as while the operator hasn't taken this phone's upload of it (C§4.2, v1.12), so
 * the save goes out with text and text_hash null and the text stays on the phone.
 */
export function itemJson(row: ItemRow, servers: string[] | null): ParsedItem {
  const text: ItemText | null = servers && row.text_sha256 && row.text_key && row.text_nonce
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

/** The servers a row's text_servers lists, as the newest event it took named them; none for a list that won't read. */
function listed(textServers: string | null): string[] {
  try {
    const v: unknown = textServers ? JSON.parse(textServers) : [];
    return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The servers a save's next event names for its text (contract 4.2): the operator and the mirror that holds the blob,
 * or the one being tried. While this phone holds the text and the operator hasn't taken its upload (its blob's
 * operator_at is null: waiting, or refused, C§4.2, v1.12), the event names only a mirror already holding the blob, as a
 * move's copy of a text backed up under the old identity (C§4.8), and with none, null: the save goes out without text.
 * A text another phone uploaded keeps the servers its newest event named, so a save sent again from here still names
 * the mirror that holds it (F18), unless they name no mirror, which text.servers never leaves out.
 */
export function textServers(db: SqlDb, row: Pick<ItemRow, 'owner' | 'text_sha256' | 'text_servers'>, operator: string, mirror: string): string[] | null {
  const blob = row.text_sha256
    ? db.get<{ operator_at: number | null; mirror_at: number | null; mirror_url: string | null }>(
      'SELECT operator_at, mirror_at, mirror_url FROM blobs WHERE sha256 = ? AND owner = ?', row.text_sha256, row.owner)
    : undefined;
  if (!blob) {
    const theirs = listed(row.text_servers);
    return theirs.some((s) => !sameUrl(s, operator)) ? theirs : [operator, mirror];
  }
  if (blob.operator_at !== null) return [operator, blob.mirror_url ?? mirror];
  return blob.mirror_at !== null && blob.mirror_url ? [blob.mirror_url] : null;
}

export function markPublished(db: SqlDb, owner: string, hash: string, eventId: string, createdAt: number): void {
  db.run('UPDATE items SET event_id = ?, event_created_at = ?, published = 1, dirty = 0 WHERE owner = ? AND hash = ?', eventId, createdAt, owner, hash);
}
