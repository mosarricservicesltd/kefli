// Settings, jobs and the wipe the resolver needs (mobile spec 3.1, 4.1, 7.1).
import type { SqlDb } from './db';

export function getSetting(db: SqlDb, key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}

export function setSetting(db: SqlDb, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, value);
}

export const WELCOME_ANSWERED = 'welcome.answered';

export function queueRestore(db: SqlDb, now: number, owner: string): void {
  db.run("INSERT OR IGNORE INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES (?, 'restore', 'queued', 0, ?, ?, ?)",
    `restore:${owner}`, JSON.stringify({ owner }), now, now);
}

export function restoreRunning(db: SqlDb): boolean {
  return !!db.get("SELECT 1 FROM jobs WHERE kind = 'restore' AND state IN ('queued', 'running')");
}

/** Whether the database holds anything an identity put there. */
export function hasData(db: SqlDb): boolean {
  return !!db.get('SELECT 1 FROM identities') || !!db.get('SELECT 1 FROM items') || !!db.get('SELECT 1 FROM outbox');
}

const TABLES = ['outbox_targets', 'outbox', 'listen_history', 'items_future', 'blobs', 'images', 'cover_drawn', 'relays', 'servers', 'lists',
  'sync_cursors', 'inbox_seen', 'devices', 'job_items', 'jobs', 'settings', 'items', 'identities'];

/** A database with no readable key file is wiped (7.1): every row, the search index included. */
export function wipe(db: SqlDb): void {
  db.tx(() => {
    for (const t of TABLES) db.run(`DELETE FROM ${t}`);
    db.run("INSERT INTO items_fts(items_fts) VALUES ('delete-all')");
  });
}
