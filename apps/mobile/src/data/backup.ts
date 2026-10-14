// Backed up (mobile spec 4.3, C§3.1, FD 93): a save counts as backed up once a relay the operator doesn't run has
// accepted its newest event and, for a save with text this phone uploaded, a mirror holds the blob and that event
// names it (C§4.2, F18). A change still queued, retrying or dead leaves it not backed up, and so does a text the
// operator hasn't taken (C§1, v1.12): its blob has no mirror. Advanced counts the rest.
//
// The backup space (C§5, FD 117): the room the library's last known figures leave, for the texts waiting on it.
import type { AccountFigures } from '@kefli/protocol';
import type { SqlDb } from './db';
import { getSetting, setSetting } from './settings';

/** A relay off the operator accepted this event: if it is still the save's newest, the save is backed up. */
export function markBacked(db: SqlDb, eventId: string): void {
  db.run('UPDATE items SET backed_event = ? WHERE event_id = ?', eventId, eventId);
}

/**
 * Saves that signing out would lose (FD 105): never sent to a relay, with changes not yet sent, or with text no server
 * holds yet. A save waiting only for its mirror isn't counted: Kefli's server has it.
 */
export function unsentSaves(db: SqlDb, owner: string): number {
  return db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM items i WHERE i.owner = ? AND i.pending_delete_at IS NULL AND (
       i.event_id IS NULL OR i.dirty = 1
       OR EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = i.text_sha256 AND b.owner = i.owner AND b.operator_at IS NULL AND b.mirror_at IS NULL))`,
    owner,
  )?.n ?? 0;
}

export function notBackedUp(db: SqlDb, owner: string): number {
  return db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM items i WHERE i.owner = ? AND i.pending_delete_at IS NULL AND (
       i.event_id IS NULL OR i.dirty = 1 OR i.backed_event IS NULL OR i.backed_event != i.event_id
       OR EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = i.text_sha256 AND b.owner = i.owner AND (b.mirror_at IS NULL
         -- RULED: a save published before text_servers was kept names nothing known here, and counts as before
         OR (i.text_servers IS NOT NULL AND NOT EXISTS (SELECT 1 FROM json_each(i.text_servers) WHERE value = b.mirror_url)))))`,
    owner,
  )?.n ?? 0;
}

/** The library's last known figures (data/account.ts: GET /account, or a 413's) and when they were had, Unix seconds. */
export type KnownFigures = AccountFigures & { at: number };

/** A deletion the operator confirmed: when, how many bytes, and when the operator had taken the blob, if known. */
export type Freed = { at: number; size: number; up: number | null };

const FREED_KEPT = 200;
const freedKey = (owner: string) => `space.freed.${owner}`;
const isFreed = (e: unknown): e is Freed => !!e && typeof (e as Freed).at === 'number' && typeof (e as Freed).size === 'number';

function freedLog(db: SqlDb, owner: string): Freed[] {
  try {
    const v: unknown = JSON.parse(getSetting(db, freedKey(owner)) ?? '[]');
    return Array.isArray(v) ? v.filter(isFreed) : [];
  } catch {
    return [];
  }
}

/** The operator confirmed deleting a blob of this library's (C§5): kept, the newest 200, for the room reckoned below. */
export function noteFreed(db: SqlDb, owner: string, e: Freed): void {
  setSetting(db, freedKey(owner), JSON.stringify([...freedLog(db, owner), e].slice(-FREED_KEPT)));
}

/** A library that leaves the phone, as a move's source does, takes its deletions with it. */
export function forgetFreed(db: SqlDb, owner: string): void {
  db.run('DELETE FROM settings WHERE key = ?', freedKey(owner));
}

/** Whether a deletion gave back room the figures counted: made after them, of a blob the operator had before them. */
const counted = (f: KnownFigures) => (e: Freed) => e.at > f.at && !(typeof e.up === 'number' && e.up > f.at);

/**
 * The room the last known figures leave (C§5): their quota less their use, less what this phone has had the operator
 * take since and plus what it has had deleted since of what they counted. Another device's uploads and deletions
 * aren't known here, so the reckoning can be out either way; a text it lets through that doesn't fit is refused, and
 * the refusal brings the next figures.
 */
export function roomLeft(db: SqlDb, owner: string, f: KnownFigures): number {
  const taken = db.get<{ n: number | null }>('SELECT SUM(size) AS n FROM blobs WHERE owner = ? AND operator_at > ?', owner, f.at)?.n ?? 0;
  const freed = freedLog(db, owner).filter(counted(f)).reduce((n, e) => n + e.size, 0);
  return f.quota - f.used - taken + freed;
}

/** The oldest text waiting for room (refused with 413 quota, C§5) whose blob fits in room: its upload's row, or null. */
export function nextForRoom(db: SqlDb, owner: string, room: number): number | null {
  return db.get<{ id: number }>(
    `SELECT o.id FROM outbox o JOIN blobs b ON b.sha256 = o.subject AND b.owner = o.signer
     WHERE o.op = 'upload_blob' AND o.signer = ? AND o.state = 'queued' AND b.last_error = 'quota' AND b.operator_at IS NULL
       AND COALESCE(b.size, 0) <= ?
     ORDER BY o.created_at, o.id LIMIT 1`, owner, room,
  )?.id ?? null;
}
