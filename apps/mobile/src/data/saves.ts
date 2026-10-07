// Queues a save (mobile spec 4.3, 5.4): the item row, its staged blob, and the outbox rows, held until the
// share sheet closes without Undo. register runs first if this identity hasn't registered; the upload follows
// it, the mirror follows the upload, and the publish follows the upload (or register, with no text).
import type { SqlDb } from './db';
import { insertItem, type NewItem } from './items';
import { enqueue } from './outbox';
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

/** Returns the held outbox rows, for release when the sheet closes (or undo). */
export function queueSave(db: SqlDb, now: number, item: NewItem, blob: StagedBlob | null, t: SaveTargets): number[] {
  return db.tx(() => {
    const held: number[] = [];
    const registered = db.get<{ registered_at: number | null }>('SELECT registered_at FROM identities WHERE pubkey = ?', item.owner)?.registered_at;
    let register: number | null = null;
    if (!registered) {
      // register isn't Undo-able: it is queued at once and merges with any other pending registration.
      register = enqueue(db, now, { op: 'register', signer: item.owner, subject: item.owner, targets: [`${t.api}/register`] });
    }
    if (db.get('SELECT 1 FROM items WHERE owner = ? AND hash = ?', item.owner, item.hash)) return repeatSave(db, now, item, register);
    insertItem(db, now, item);
    let upload: number | null = null;
    if (blob) {
      db.run('INSERT OR REPLACE INTO blobs (sha256, hash, kind, staged_path, size, owner) VALUES (?, ?, ?, ?, ?, ?)',
        blob.sha256, item.hash, 'text', blob.path, blob.size, item.owner);
      upload = enqueue(db, now, { op: 'upload_blob', signer: item.owner, subject: blob.sha256, payload: { sha256: blob.sha256 }, targets: [t.blossom], dependsOn: register, held: true });
      held.push(upload);
      held.push(enqueue(db, now, { op: 'mirror_blob', signer: item.owner, subject: blob.sha256, payload: { sha256: blob.sha256 }, targets: [t.mirror], dependsOn: upload, held: true }));
    }
    // Every save goes to all the identity's write relays (C§3.1).
    const relays = writeRelays(db, item.owner);
    held.push(enqueue(db, now, { op: 'publish_item', signer: item.owner, subject: item.hash, targets: relays, dependsOn: upload ?? register, held: true }));
    // The lists go out on the first save (C§3.1): the 10002 to the write relays and the indexer, the 10063 to the
    // write relays. Not Undo-able: an identity keeps its lists whether or not this save stays.
    if (!hasList(db, item.owner, 10002)) {
      enqueue(db, now, { op: 'publish_lists', signer: item.owner, subject: item.owner, targets: [...new Set([...relays, ...indexerRelays(db, item.owner)])], dependsOn: register });
    }
    return held;
  });
}
