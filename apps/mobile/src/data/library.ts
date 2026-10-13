// The library as the screens read and change it (mobile spec 5.6): the two lists, archive and Back to Unread,
// delete, the next unread, and the reading position. Every change writes the row first and the network through
// held outbox rows, so Undo reverts the row and deletes them before anything leaves the phone (4.3, FD 7, FD 38).
import { ITEM_D_PREFIX, progressAt } from '@kefli/protocol';
import type { SqlDb } from './db';
import { enqueue, release, undo } from './outbox';
import { writeRelays } from './lists';

/** Reading speed for "N min" (FD 1). */
export const WPM = 230;

export type ListName = 'unread' | 'archived';

export type LibRow = {
  id: number; hash: string; url: string; title: string | null; site: string | null; words: number | null;
  position_word: number; state: ListName; text_state: string; fail_reason: string | null; origin: string; saved_at: number;
  byline: string | null; lang: string | null; text_sha256: string | null; text_servers: string | null; hero: string | null;
  x_state: string | null; origin_device: string | null;
};

export const LIB_COLS = 'id, hash, url, title, site, words, position_word, state, text_state, fail_reason, origin, saved_at, byline, lang, text_sha256, text_servers, hero, x_state, origin_device';

export function activeOwner(db: SqlDb): string | null {
  return db.get<{ pubkey: string }>("SELECT pubkey FROM identities WHERE role = 'active'")?.pubkey ?? null;
}

/** A list, newest first, without saves waiting on a delete's Undo. */
export function listRows(db: SqlDb, owner: string, list: ListName): LibRow[] {
  return db.all<LibRow>(`SELECT ${LIB_COLS} FROM items WHERE owner = ? AND state = ? AND pending_delete_at IS NULL ORDER BY saved_at DESC, id DESC`, owner, list);
}

export function counts(db: SqlDb, owner: string): { unread: number; archived: number } {
  const r = db.all<{ state: ListName; n: number }>('SELECT state, COUNT(*) AS n FROM items WHERE owner = ? AND pending_delete_at IS NULL GROUP BY state', owner);
  return { unread: r.find((x) => x.state === 'unread')?.n ?? 0, archived: r.find((x) => x.state === 'archived')?.n ?? 0 };
}

export function rowByHash(db: SqlDb, owner: string, hash: string): LibRow | undefined {
  return db.get<LibRow>(`SELECT ${LIB_COLS} FROM items WHERE owner = ? AND hash = ?`, owner, hash);
}

/** Minutes to read at WPM, at least one; null when the words aren't known. */
export function minutes(words: number | null): number | null {
  return words ? Math.max(1, Math.round(words / WPM)) : null;
}

/** Read to the last word counts as read through (position is a word index, so the last word is words − 1). */
export function progressOf(r: Pick<LibRow, 'words' | 'position_word'>): number {
  if (r.words && r.position_word >= r.words - 1) return 1;
  return progressAt(r.position_word, r.words);
}

/** "N min left" while part-read: the minutes still to go, at least one (the prototype's minsLeft). */
export function minutesLeft(r: Pick<LibRow, 'words' | 'position_word'>): number | null {
  const m = minutes(r.words);
  return m === null ? null : Math.max(1, Math.round(m * (1 - progressOf(r))));
}

export type RowStatus = 'ok' | 'waiting' | 'failed';

/** What a row shows: its text is here (or still to come with a title), it waits for its text, or it failed. */
export function rowStatus(r: Pick<LibRow, 'text_state'>): RowStatus {
  if (r.text_state === 'cached') return 'ok';
  if (r.text_state === 'failed') return 'failed';
  return 'waiting';
}

function publishHeld(db: SqlDb, now: number, owner: string, hash: string): number {
  return enqueue(db, now, { op: 'publish_item', signer: owner, subject: hash, targets: writeRelays(db, owner), held: true });
}

export type Change = { held: number[]; revert: () => void };

/**
 * Archive, or Back to Unread (FD 7, FD 37). Returns the held rows and how to revert: Undo reverts, the toast closing
 * without Undo releases. A repeat save's rule doesn't apply here; saved_at is left as it was.
 */
export function setArchived(db: SqlDb, now: number, owner: string, hash: string, archived: boolean): Change {
  return db.tx(() => {
    const before = db.get<{ state: ListName; modified_at: number | null; dirty: number }>('SELECT state, modified_at, dirty FROM items WHERE owner = ? AND hash = ?', owner, hash);
    if (!before) return { held: [], revert: () => {} };
    db.run('UPDATE items SET state = ?, modified_at = ?, dirty = 1 WHERE owner = ? AND hash = ?', archived ? 'archived' : 'unread', now, owner, hash);
    const held = [publishHeld(db, now, owner, hash)];
    return {
      held,
      revert: () => db.tx(() => {
        db.run('UPDATE items SET state = ?, modified_at = ?, dirty = ? WHERE owner = ? AND hash = ?', before.state, before.modified_at, before.dirty, owner, hash);
        undo(db, held);
      }),
    };
  });
}

/**
 * Delete (FD 34): the row is hidden at once and a kind 5 is held; Undo shows it again. Once the toast closes without
 * Undo, commitDelete removes the row, and the blob goes from its servers after the deletion is out (4.3).
 */
export function deleteItem(db: SqlDb, now: number, owner: string, hash: string): Change {
  return db.tx(() => {
    const row = db.get<{ text_sha256: string | null; text_servers: string | null; event_created_at: number | null }>(
      'SELECT text_sha256, text_servers, event_created_at FROM items WHERE owner = ? AND hash = ?', owner, hash);
    if (!row) return { held: [], revert: () => {} };
    db.run('UPDATE items SET pending_delete_at = ? WHERE owner = ? AND hash = ?', now, owner, hash);
    // after: the newest version's time, which the kind 5 must be dated past (F36); the row is gone by the time it's sent
    const del = enqueue(db, now, { op: 'delete_item', signer: owner, subject: hash, payload: { ds: [ITEM_D_PREFIX + hash], after: row.event_created_at ?? 0 }, targets: writeRelays(db, owner), held: true });
    const held = [del];
    const servers = row.text_servers ? (JSON.parse(row.text_servers) as string[]) : [];
    const mine = row.text_sha256 && db.get('SELECT 1 FROM blobs WHERE sha256 = ? AND owner = ?', row.text_sha256, owner);
    if (row.text_sha256 && servers.length && mine) {
      held.push(enqueue(db, now, { op: 'delete_blob', signer: owner, subject: row.text_sha256, payload: { sha256: row.text_sha256 }, targets: servers, dependsOn: del, lane: 'bulk', held: true }));
    }
    return {
      held,
      revert: () => db.tx(() => {
        db.run('UPDATE items SET pending_delete_at = NULL WHERE owner = ? AND hash = ?', owner, hash);
        undo(db, held);
      }),
    };
  });
}

/** The delete's toast closed without Undo: the row goes, with its search entry and any unsent publish. */
export function commitDelete(db: SqlDb, owner: string, hash: string, held: number[]): void {
  db.tx(() => {
    release(db, held);
    const row = db.get<{ id: number }>('SELECT id FROM items WHERE owner = ? AND hash = ? AND pending_delete_at IS NOT NULL', owner, hash);
    if (!row) return;
    db.run('DELETE FROM items_fts WHERE rowid = ?', row.id);
    db.run('DELETE FROM items WHERE id = ?', row.id);
    db.run("DELETE FROM outbox WHERE op = 'publish_item' AND signer = ? AND subject = ? AND state IN ('held', 'queued')", owner, hash);
  });
}

/** Deletes waiting on an Undo that a process death interrupted are carried out at the next start. */
export function commitOrphanDeletes(db: SqlDb, owner: string): string[] {
  const rows = db.all<{ hash: string }>('SELECT hash FROM items WHERE owner = ? AND pending_delete_at IS NOT NULL', owner);
  for (const r of rows) commitDelete(db, owner, r.hash, []);
  return rows.map((r) => r.hash);
}

/** Archive and next's next: the first Unread row in list order whose text is here, other than this one (5.6). */
export function nextUnread(db: SqlDb, owner: string, hash: string): LibRow | undefined {
  return listRows(db, owner, 'unread').find((r) => r.hash !== hash && r.text_state === 'cached');
}

/**
 * The reading position (FD 36): kept on every move, published when the Reader closes and at most once a minute
 * while reading (4.5). publish false only stores it.
 */
export function setPosition(db: SqlDb, now: number, owner: string, hash: string, word: number, publish: boolean): void {
  db.tx(() => {
    const r = db.get<{ words: number | null; position_word: number }>('SELECT words, position_word FROM items WHERE owner = ? AND hash = ?', owner, hash);
    if (!r) return;
    const w = Math.max(0, Math.min(word, Math.max(0, (r.words ?? 1) - 1)));
    if (w !== r.position_word) {
      db.run('UPDATE items SET position_word = ?, progress = ?, modified_at = ?, dirty = 1, last_opened_at = ? WHERE owner = ? AND hash = ?',
        w, progressAt(w, r.words), now, now, owner, hash);
    }
    const dirty = db.get<{ dirty: number }>('SELECT dirty FROM items WHERE owner = ? AND hash = ?', owner, hash)?.dirty;
    if (publish && dirty) enqueue(db, now, { op: 'publish_item', signer: owner, subject: hash, targets: writeRelays(db, owner) });
  });
}

/**
 * The words of an article derived again under a newer spoken projection (contract 4.2, 1.6: citation markers go
 * silent): words is the projection's count, so a changed count is stored with its progress, and the item goes out
 * with the next published position. The position is a word index and stays, kept inside the new length.
 */
export function reconcileWords(db: SqlDb, now: number, owner: string, hash: string, words: number): void {
  db.tx(() => {
    const r = db.get<{ words: number | null; position_word: number }>('SELECT words, position_word FROM items WHERE owner = ? AND hash = ?', owner, hash);
    if (!r || r.words === null || r.words === words) return;
    const w = Math.max(0, Math.min(r.position_word, Math.max(0, words - 1)));
    db.run('UPDATE items SET words = ?, position_word = ?, progress = ?, modified_at = ?, dirty = 1 WHERE owner = ? AND hash = ?',
      words, w, progressAt(w, words), now, owner, hash);
  });
}

/** Whether any row still holds a hash's files once a delete is done (files are per hash, 4.1). */
export function hashInUseAfterDelete(db: SqlDb, hash: string): boolean {
  return !!db.get('SELECT 1 FROM items WHERE hash = ?', hash);
}

/** A save marked cached whose file is gone (a share before files were written, or storage cleared) is fetched again. */
export function textLost(db: SqlDb, owner: string, hash: string): void {
  db.run("UPDATE items SET text_state = 'remote' WHERE owner = ? AND hash = ? AND text_state = 'cached' AND text_sha256 IS NOT NULL", owner, hash);
}
