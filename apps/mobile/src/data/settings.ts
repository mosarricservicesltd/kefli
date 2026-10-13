// Settings, jobs and the wipe the resolver needs (mobile spec 3.1, 4.1, 7.1).
import type { SqlDb } from './db';

export function getSetting(db: SqlDb, key: string): string | null {
  return db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}

export function setSetting(db: SqlDb, key: string, value: string): void {
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', key, value);
}

export const WELCOME_ANSWERED = 'welcome.answered';
/** Keep backup copies (4.6, FD 76): '0' when switched off at sign-in. */
export const KEEP_COPIES = 'lists.keep_copies';
/** The last Block Store write this phone made (3.3, F22): '<pubkey> 1' marked for the cloud, '<pubkey> 0' not. */
export const BLOCK_STORE_WRITTEN = 'blockstore.written';

/** The cloud flag of the last Block Store write of pubkey's words, or null with no record of one. */
export function blockStoreWritten(db: SqlDb, pubkey: string): boolean | null {
  const [who, cloud] = (getSetting(db, BLOCK_STORE_WRITTEN) ?? '').split(' ');
  return who === pubkey && (cloud === '1' || cloud === '0') ? cloud === '1' : null;
}

/** Records a Block Store write of pubkey's words, or, with null, that the entry was removed. */
export function setBlockStoreWritten(db: SqlDb, pubkey: string | null, cloud = false): void {
  if (pubkey === null) db.run('DELETE FROM settings WHERE key = ?', BLOCK_STORE_WRITTEN);
  else setSetting(db, BLOCK_STORE_WRITTEN, `${pubkey} ${cloud ? '1' : '0'}`);
}

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

/** Settings that belong to the phone, not the library: the reader's and the voice's. Sign out keeps them (FD 105). */
const DEVICE_PREFS = /^(reader|voice)\./;

export function devicePrefs(db: SqlDb): [string, string][] {
  return db.all<{ key: string; value: string }>('SELECT key, value FROM settings').filter((r) => DEVICE_PREFS.test(r.key)).map((r) => [r.key, r.value]);
}

export function restorePrefs(db: SqlDb, prefs: [string, string][]): void {
  for (const [k, v] of prefs) setSetting(db, k, v);
}

/**
 * A database with no readable key file is wiped (7.1), as is the library at Delete my data and Sign out (7.2): every
 * row, the search index included. Deleted rows would stay in the file's free pages and the write-ahead log, so no
 * title, link or text is left behind (F28): secure_delete overwrites them with zeros as they go, VACUUM gives the
 * space back, and the log is emptied.
 */
export function wipe(db: SqlDb): void {
  db.get('PRAGMA secure_delete = ON');
  db.tx(() => {
    for (const t of TABLES) db.run(`DELETE FROM ${t}`);
    db.run("INSERT INTO items_fts(items_fts) VALUES ('delete-all')");
  });
  try {
    db.exec('VACUUM');
  } catch {
    // a statement still open on the connection; the rows are zeroed already
  }
  db.get('PRAGMA wal_checkpoint(TRUNCATE)');
}
