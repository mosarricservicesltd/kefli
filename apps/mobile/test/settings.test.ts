import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrate } from '../src/data/schema';
import {
  WELCOME_ANSWERED, blockStoreWritten, getSetting, hasData, queueRestore, restoreRunning, setBlockStoreWritten, setSetting, wipe,
} from '../src/data/settings';
import { ensureIdentityRow } from '../src/data/saves';
import { memoryDb } from './sqlite';

test('settings, the restore job, and the wipe (mobile spec 3.1, 7.1)', () => {
  const db = memoryDb();
  migrate(db);
  expect(hasData(db)).toBe(false);
  expect(getSetting(db, WELCOME_ANSWERED)).toBeNull();
  setSetting(db, WELCOME_ANSWERED, '1');
  expect(getSetting(db, WELCOME_ANSWERED)).toBe('1');
  ensureIdentityRow(db, 1, 'p', 'block_store', true);
  queueRestore(db, 1, 'p');
  queueRestore(db, 2, 'p');
  expect(db.all('SELECT id FROM jobs')).toHaveLength(1);
  expect(restoreRunning(db)).toBe(true);
  db.run('INSERT INTO items_fts (rowid, title, site, url, body) VALUES (1, ?, ?, ?, ?)', 't', 's', 'u', 'b');
  expect(hasData(db)).toBe(true);
  wipe(db);
  expect(hasData(db)).toBe(false);
  expect(getSetting(db, WELCOME_ANSWERED)).toBeNull();
  expect(restoreRunning(db)).toBe(false);
  expect(db.all("SELECT rowid FROM items_fts WHERE items_fts MATCH 't'")).toHaveLength(0);
});

test('the wipe leaves nothing of the library in the database file or its log (mobile spec 7.2, F28)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kefli-wipe-'));
  const path = join(dir, 'kefli.db');
  const db = memoryDb(path);
  db.get('PRAGMA journal_mode = WAL');
  migrate(db);
  const marks = ['how-to-leave-quietly', 'https://example.org/private-matter', 'a body only this save has'];
  for (let i = 0; i < 200; i++) {
    setSetting(db, `probe.${i}`, `${marks[0]} ${i}`);
    db.run('INSERT INTO items_fts (rowid, title, site, url, body) VALUES (?, ?, ?, ?, ?)', i + 1, marks[0], 'example.org', marks[1], marks[2]);
  }
  db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  setSetting(db, 'probe.wal', `${marks[0]} in the log`);
  wipe(db);
  const held = ['', '-wal'].map((s) => (existsSync(path + s) ? readFileSync(path + s).toString('latin1') : '')).join('');
  for (const m of marks) expect(held.includes(m)).toBe(false);
  expect(hasData(db)).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

describe('the record of Block Store writes (mobile spec 3.3, F22)', () => {
  test('kept per identity, cleared on removal, and gone with the wipe', () => {
    const db = memoryDb();
    migrate(db);
    expect(blockStoreWritten(db, 'p')).toBeNull();
    setBlockStoreWritten(db, 'p', true);
    expect(blockStoreWritten(db, 'p')).toBe(true);
    expect(blockStoreWritten(db, 'q')).toBeNull();
    setBlockStoreWritten(db, 'p', false);
    expect(blockStoreWritten(db, 'p')).toBe(false);
    setBlockStoreWritten(db, null);
    expect(blockStoreWritten(db, 'p')).toBeNull();
    setBlockStoreWritten(db, 'p', true);
    wipe(db);
    expect(blockStoreWritten(db, 'p')).toBeNull();
  });
});
