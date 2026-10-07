// Queues a save (mobile spec 4.3, 5.4): the item row, its staged blob, and the outbox rows, held until the
// share sheet closes without Undo. register runs first if this identity hasn't registered; the upload follows
// it, the mirror follows the upload, and the publish follows the upload (or register, with no text).
import type { SqlDb } from './db';
import { insertItem, type NewItem } from './items';
import { enqueue } from './outbox';

export type SaveTargets = { api: string; blossom: string; mirror: string; relays: string[] };
export type StagedBlob = { sha256: string; size: number; path: string };

export function ensureIdentityRow(db: SqlDb, now: number, pubkey: string, origin: string, hasRecovery: boolean): void {
  db.run(
    "INSERT OR IGNORE INTO identities (pubkey, provider, role, origin, has_recovery, created_at) VALUES (?, 'local', 'active', ?, ?, ?)",
    pubkey, origin, hasRecovery ? 1 : 0, now,
  );
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
    insertItem(db, now, item);
    let upload: number | null = null;
    if (blob) {
      db.run('INSERT OR REPLACE INTO blobs (sha256, hash, kind, staged_path, size, owner) VALUES (?, ?, ?, ?, ?, ?)',
        blob.sha256, item.hash, 'text', blob.path, blob.size, item.owner);
      upload = enqueue(db, now, { op: 'upload_blob', signer: item.owner, subject: blob.sha256, payload: { sha256: blob.sha256 }, targets: [t.blossom], dependsOn: register, held: true });
      held.push(upload);
      held.push(enqueue(db, now, { op: 'mirror_blob', signer: item.owner, subject: blob.sha256, payload: { sha256: blob.sha256 }, targets: [t.mirror], dependsOn: upload, held: true }));
    }
    held.push(enqueue(db, now, { op: 'publish_item', signer: item.owner, subject: item.hash, targets: t.relays, dependsOn: upload ?? register, held: true }));
    return held;
  });
}
