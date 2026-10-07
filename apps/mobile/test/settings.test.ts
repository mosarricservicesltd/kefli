import { migrate } from '../src/data/schema';
import { WELCOME_ANSWERED, getSetting, hasData, queueRestore, restoreRunning, setSetting, wipe } from '../src/data/settings';
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
