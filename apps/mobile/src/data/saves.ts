// Queues a save (mobile spec 4.3, 5.4): the item row, its staged blob, and the outbox rows, held until the
// share sheet closes without Undo. register runs first if this identity hasn't registered; the upload follows
// it, the mirror follows the upload, and the publish follows the upload (or register, with no text).
import type { SqlDb } from './db';
import { insertItem, type NewItem } from './items';
import { enqueue, undo } from './outbox';
import { hasList, indexerRelays, writeRelays } from './lists';

export type SaveTargets = { api: string; blossom: string; mirror: string };
export type StagedBlob = { sha256: string; size: number; path: string };

export function ensureIdentityRow(db: SqlDb, now: number, pubkey: string, origin: string, hasRecovery: boolean): void {
  db.run(
    "INSERT OR IGNORE INTO identities (pubkey, provider, role, origin, has_recovery, created_at) VALUES (?, 'local', 'active', ?, ?, ?)",
    pubkey, origin, hasRecovery ? 1 : 0, now,
  );
}

/**
 * A repeat save (contract 4.1, flow decision 89): an archived save is un-archived with saved_at set to the new
 * save's time and republished; an unread one is left unchanged. The existing text is kept. Returns the held rows.
 */
function repeatSave(db: SqlDb, now: number, item: NewItem, register: number | null): number[] {
  const existing = db.get<{ state: string }>('SELECT state FROM items WHERE owner = ? AND hash = ?', item.owner, item.hash);
  if (existing?.state !== 'archived') return [];
  db.run("UPDATE items SET state = 'unread', saved_at = ?, modified_at = ?, dirty = 1 WHERE owner = ? AND hash = ?", item.savedAt, now, item.owner, item.hash);
  return [enqueue(db, now, { op: 'publish_item', signer: item.owner, subject: item.hash, targets: writeRelays(db, item.owner), dependsOn: register, held: true })];
}

function registerFirst(db: SqlDb, now: number, owner: string, t: SaveTargets): number | null {
  const registered = db.get<{ registered_at: number | null }>('SELECT registered_at FROM identities WHERE pubkey = ?', owner)?.registered_at;
  // register isn't Undo-able: it is queued at once and merges with any other pending registration.
  return registered ? null : enqueue(db, now, { op: 'register', signer: owner, subject: owner, targets: [`${t.api}/register`] });
}

/**
 * A save's sends (4.3): the blob's upload and mirror if it has text, then its publish to every write relay (C§3.1),
 * each after the one it needs. held: the share sheet's rows wait for it to close without Undo.
 */
export function queueSends(db: SqlDb, now: number, owner: string, hash: string, blob: StagedBlob | null, t: SaveTargets, held: boolean, register: number | null): number[] {
  const rows: number[] = [];
  let upload: number | null = null;
  if (blob) {
    db.run('INSERT OR REPLACE INTO blobs (sha256, hash, kind, staged_path, size, owner) VALUES (?, ?, ?, ?, ?, ?)', blob.sha256, hash, 'text', blob.path, blob.size, owner);
    upload = enqueue(db, now, { op: 'upload_blob', signer: owner, subject: blob.sha256, payload: { sha256: blob.sha256 }, targets: [t.blossom], dependsOn: register, held });
    rows.push(upload);
    rows.push(enqueue(db, now, { op: 'mirror_blob', signer: owner, subject: blob.sha256, payload: { sha256: blob.sha256 }, targets: [t.mirror], dependsOn: upload, held }));
  }
  rows.push(enqueue(db, now, { op: 'publish_item', signer: owner, subject: hash, targets: writeRelays(db, owner), dependsOn: upload ?? register, held }));
  return rows;
}

/**
 * Returns the held outbox rows, for release when the sheet closes (or undo). A save whose page couldn't be fetched
 * yet (offline, text_state queued) is kept on the phone only: its publish waits for the parse (4.3), so it can still
 * be re-keyed by its final address (FD 80).
 */
export function queueSave(db: SqlDb, now: number, item: NewItem, blob: StagedBlob | null, t: SaveTargets): number[] {
  return db.tx(() => {
    const register = registerFirst(db, now, item.owner, t);
    if (db.get('SELECT 1 FROM items WHERE owner = ? AND hash = ?', item.owner, item.hash)) return repeatSave(db, now, item, register);
    insertItem(db, now, item);
    const held = item.textState === 'queued' ? [] : queueSends(db, now, item.owner, item.hash, blob, t, true, register);
    // The lists go out on the first save (C§3.1): the 10002 to the write relays and the indexer, the 10063 to the
    // write relays. Not Undo-able: an identity keeps its lists whether or not this save stays.
    if (!hasList(db, item.owner, 10002)) {
      const relays = writeRelays(db, item.owner);
      enqueue(db, now, { op: 'publish_lists', signer: item.owner, subject: item.owner, targets: [...new Set([...relays, ...indexerRelays(db, item.owner)])], dependsOn: register });
    }
    return held;
  });
}

export { registerFirst };

/** What a share found before it saved: nothing (a new save), or the save already here and its state. */
export type Prior = { state: 'unread' | 'archived'; saved_at: number; dirty: number; modified_at: number | null } | null;

export function priorOf(db: SqlDb, owner: string, hash: string): Prior {
  return db.get<NonNullable<Prior>>('SELECT state, saved_at, dirty, modified_at FROM items WHERE owner = ? AND hash = ? AND pending_delete_at IS NULL', owner, hash) ?? null;
}

/**
 * Undo on the Saved sheet (mobile spec 5.4, 4.3): the held rows go. A new save goes with its search entry and staged
 * blob, whose paths are returned for the caller to delete with the save's files; an archived save the share brought
 * back is archived again as it was. An unread save shared again changed nothing, so there is nothing to undo.
 */
export function undoSave(db: SqlDb, owner: string, hash: string, held: number[], prior: Prior): { staged: string[] } {
  return db.tx(() => {
    undo(db, held);
    if (prior) {
      db.run('UPDATE items SET state = ?, saved_at = ?, dirty = ?, modified_at = ? WHERE owner = ? AND hash = ?', prior.state, prior.saved_at, prior.dirty, prior.modified_at, owner, hash);
      return { staged: [] };
    }
    const row = db.get<{ id: number; text_sha256: string | null }>('SELECT id, text_sha256 FROM items WHERE owner = ? AND hash = ?', owner, hash);
    if (!row) return { staged: [] };
    const staged = row.text_sha256
      ? db.all<{ staged_path: string | null }>('SELECT staged_path FROM blobs WHERE sha256 = ? AND owner = ?', row.text_sha256, owner).map((b) => b.staged_path).filter((p): p is string => !!p)
      : [];
    if (row.text_sha256) db.run('DELETE FROM blobs WHERE sha256 = ? AND owner = ?', row.text_sha256, owner);
    db.run('DELETE FROM items_fts WHERE rowid = ?', row.id);
    db.run('DELETE FROM cover_drawn WHERE hash = ?', hash);
    db.run('DELETE FROM items WHERE id = ?', row.id);
    return { staged };
  });
}
