// Backed up (mobile spec 4.3, C§3.1, FD 93): a save counts as backed up once a relay the operator doesn't run has
// accepted its newest event and, for a save with text this phone uploaded, a mirror holds the blob. A change still
// queued, retrying or dead leaves it not backed up. Advanced counts the rest.
import type { SqlDb } from './db';

/** A relay off the operator accepted this event: if it is still the save's newest, the save is backed up. */
export function markBacked(db: SqlDb, eventId: string): void {
  db.run('UPDATE items SET backed_event = ? WHERE event_id = ?', eventId, eventId);
}

export function notBackedUp(db: SqlDb, owner: string): number {
  return db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM items i WHERE i.owner = ? AND i.pending_delete_at IS NULL AND (
       i.event_id IS NULL OR i.dirty = 1 OR i.backed_event IS NULL OR i.backed_event != i.event_id
       OR EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = i.text_sha256 AND b.owner = i.owner AND b.mirror_at IS NULL))`,
    owner,
  )?.n ?? 0;
}
