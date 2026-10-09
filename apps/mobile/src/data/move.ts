// The move's local half (mobile spec 4.10, contract 4.8): its job, and copying one save from the source key S to the
// target T on this phone. A copy is a new row under T, every field kept, sent through the outbox under T: its blob
// uploaded and mirrored as T's, then the save published, signed by T. A save T already holds keeps T's copy, and is
// only brought back from Archive when S's copy is unread, as a repeated save is (C§4.1). Listen history follows.
import type { SqlDb } from './db';
import { enqueue } from './outbox';
import { queueSends, type SaveTargets, type StagedBlob } from './saves';
import { writeRelays, type DefaultsLike } from './lists';
import { ensureIdentityRow } from './saves';
import { KEEP_COPIES, setSetting } from './settings';
import { settleUserLists, type UserLists } from '../services/nostrSignIn';

export type MoveJob = { id: string; from: string; to: string; step: number; moved: string[] };

/** Queues a move from S to T; one per source. */
export function queueMove(db: SqlDb, now: number, from: string, to: string): void {
  db.run("INSERT OR REPLACE INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES (?, 'move', 'queued', 0, ?, ?, ?)",
    `move:${from}`, JSON.stringify({ from, to }), now, now);
}

/**
 * Switching to a nostr app (C§4.8): T beside S as the move's target, its lists settled under Keep backup copies, and
 * the move queued. S stays the phone's identity until the move's last step.
 */
export function queueSwitch(db: SqlDb, now: number, from: string, to: string, provider: 'nip55' | 'nip46', lists: UserLists, keep: boolean, d: DefaultsLike): void {
  ensureIdentityRow(db, now, to, 'nostr_signin', false, provider);
  db.run("UPDATE identities SET role = 'move_target' WHERE pubkey = ?", to);
  setSetting(db, KEEP_COPIES, keep ? '1' : '0');
  settleUserLists(db, now, to, d, lists, keep);
  queueMove(db, now, from, to);
}

export function moveJob(db: SqlDb): MoveJob | null {
  const r = db.get<{ id: string; step: number; data: string }>("SELECT id, step, data FROM jobs WHERE kind = 'move' AND state IN ('queued', 'running') ORDER BY started_at LIMIT 1");
  if (!r) return null;
  const d = JSON.parse(r.data) as { from: string; to: string; moved?: string[] };
  return { id: r.id, from: d.from, to: d.to, step: r.step, moved: d.moved ?? [] };
}

export function saveMove(db: SqlDb, now: number, job: MoveJob, state: 'running' | 'done' = 'running'): void {
  db.run('UPDATE jobs SET state = ?, step = ?, data = ?, updated_at = ? WHERE id = ?',
    state, job.step, JSON.stringify({ from: job.from, to: job.to, moved: job.moved }), now, job.id);
}

/** A save from a newer Kefli in either library stops the move before anything is copied (C§10, FD 91 (i)). */
export function newerInEither(db: SqlDb, from: string, to: string): boolean {
  return !!db.get('SELECT 1 FROM items_future WHERE owner IN (?, ?)', from, to);
}

/** S's saves still to copy, oldest first. */
export function sourceSaves(db: SqlDb, from: string, moved: string[]): string[] {
  const done = new Set(moved);
  return db.all<{ hash: string }>('SELECT hash FROM items WHERE owner = ? AND pending_delete_at IS NULL ORDER BY saved_at, id', from)
    .map((r) => r.hash).filter((h) => !done.has(h));
}

// Columns copied as they are; the row's identity, its events and its send state are T's own.
const OWN = new Set(['id', 'owner', 'event_id', 'event_created_at', 'published', 'dirty', 'backed_event', 'modified_at', 'text_servers']);

function columns(db: SqlDb): string[] {
  return db.all<{ name: string }>('PRAGMA table_info(items)').map((c) => c.name).filter((n) => !OWN.has(n));
}

export type Copied = 'copied' | 'kept' | 'unarchived';

/**
 * One save from S to T (C§4.8 step 3). blob is S's staged ciphertext, or null for a save without text (or one whose
 * blob T must fetch first, which the caller stages). Returns what happened.
 */
export function copySave(db: SqlDb, now: number, job: MoveJob, hash: string, blob: StagedBlob | null, t: SaveTargets): Copied {
  return db.tx(() => {
    const s = db.get<{ id: number; state: string }>('SELECT id, state FROM items WHERE owner = ? AND hash = ?', job.from, hash);
    const held = db.get<{ id: number; state: string }>('SELECT id, state FROM items WHERE owner = ? AND hash = ?', job.to, hash);
    if (!s) return 'kept';
    if (held) {
      if (s.state !== 'unread' || held.state !== 'archived') return 'kept';
      db.run("UPDATE items SET state = 'unread', modified_at = ?, dirty = 1 WHERE id = ?", now, held.id);
      enqueue(db, now, { op: 'publish_item', signer: job.to, subject: hash, targets: writeRelays(db, job.to) });
      return 'unarchived';
    }
    const cols = columns(db);
    const r = db.run(
      `INSERT INTO items (owner, ${cols.join(', ')}, modified_at, dirty, published) SELECT ?, ${cols.join(', ')}, ?, 1, 0 FROM items WHERE id = ?`,
      job.to, now, s.id,
    );
    db.run('INSERT OR IGNORE INTO listen_history (item, last_played_at) SELECT ?, last_played_at FROM listen_history WHERE item = ?', r.lastInsertRowId, s.id);
    queueSends(db, now, job.to, hash, blob, t, false, null);
    return 'copied';
  });
}

/** Step 5's last act on the phone: S's rows, lists and identity go; T's stay, and T is the phone's identity. */
export function retireLocal(db: SqlDb, from: string, to: string | null): void {
  db.tx(() => {
    for (const r of db.all<{ id: number }>('SELECT id FROM items WHERE owner = ?', from)) db.run('DELETE FROM items_fts WHERE rowid = ?', r.id);
    db.run('DELETE FROM items WHERE owner = ?', from);
    db.run('DELETE FROM items_future WHERE owner = ?', from);
    for (const t of ['relays', 'servers', 'lists', 'devices', 'sync_cursors', 'inbox_seen']) db.run(`DELETE FROM ${t} WHERE owner = ?`, from);
    db.run('DELETE FROM outbox WHERE signer = ?', from);
    db.run('DELETE FROM blobs WHERE owner = ?', from);
    db.run('DELETE FROM identities WHERE pubkey = ?', from);
    if (to) db.run("UPDATE identities SET role = 'active' WHERE pubkey = ?", to);
  });
}
