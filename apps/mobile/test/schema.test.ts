import { migrate, SCHEMA_VERSION } from '../src/data/schema';
import { memoryDb } from './sqlite';

describe('schema (mobile spec 4.1)', () => {
  test('migrates from empty to the current version, with every table', () => {
    const db = memoryDb();
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").map((t) => t.name);
    for (const t of ['identities', 'items', 'items_future', 'items_fts', 'outbox', 'outbox_targets', 'relays', 'servers', 'lists', 'sync_cursors', 'inbox_seen', 'devices', 'jobs', 'job_items', 'settings', 'blobs', 'images', 'cover_drawn', 'listen_history']) {
      expect(tables).toContain(t);
    }
    expect(db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys).toBe(1);
  });

  test('migrating again changes nothing', () => {
    const db = memoryDb();
    migrate(db);
    expect(migrate(db)).toBe(SCHEMA_VERSION);
  });

  test('refuses a database from a newer app', () => {
    const db = memoryDb();
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    expect(() => migrate(db)).toThrow('newer');
  });

  test('search ignores accents and matches prefixes', () => {
    const db = memoryDb();
    migrate(db);
    db.run('INSERT INTO items_fts (rowid, title, site, url, body) VALUES (1, ?, ?, ?, ?)', 'Café crème', 'example.com', 'https://example.com', 'body');
    expect(db.all("SELECT rowid FROM items_fts WHERE items_fts MATCH 'cafe*'")).toHaveLength(1);
  });
});
