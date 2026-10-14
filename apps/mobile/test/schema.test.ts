import { MIGRATIONS, migrate, SCHEMA_VERSION } from '../src/data/schema';
import { memoryDb } from './sqlite';

describe('schema (mobile spec 4.1)', () => {
  test('migrates from empty to the current version, with every table', () => {
    const db = memoryDb();
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").map((t) => t.name);
    for (const t of ['identities', 'items', 'items_future', 'items_fts', 'outbox', 'outbox_targets', 'relays', 'servers', 'lists', 'sync_cursors', 'inbox_seen', 'devices', 'jobs', 'job_items', 'settings', 'blobs', 'images', 'cover_drawn', 'listen_history', 'account_figures']) {
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

  test('v8 (FD 117): a library from v7 keeps its blobs, which have no refusal time yet, and gains its figures table', () => {
    const db = memoryDb();
    db.exec('PRAGMA foreign_keys = ON');
    for (const step of MIGRATIONS.slice(0, 7)) step(db);
    db.exec('PRAGMA user_version = 7');
    db.run("INSERT INTO blobs (sha256, kind, size, owner, last_error) VALUES ('s1', 'text', 10, 'o', NULL)");
    expect(migrate(db)).toBe(SCHEMA_VERSION);
    expect(db.get('SELECT sha256, refused_at FROM blobs')).toEqual({ sha256: 's1', refused_at: null });
    expect(db.all('SELECT * FROM account_figures')).toEqual([]);
  });

  test('v8: a refusal’s reason, however it is written, stamps when it came, and a cleared one leaves the time', () => {
    const db = memoryDb();
    migrate(db);
    const before = Math.floor(Date.now() / 1000);
    db.run("INSERT INTO blobs (sha256, kind, size, owner) VALUES ('s1', 'text', 10, 'o')");
    expect(db.get<{ refused_at: number | null }>("SELECT refused_at FROM blobs WHERE sha256 = 's1'")?.refused_at).toBeNull();
    db.run("UPDATE blobs SET last_error = 'daily' WHERE sha256 = 's1'");
    const at = db.get<{ refused_at: number }>("SELECT refused_at FROM blobs WHERE sha256 = 's1'")!.refused_at;
    expect(at).toBeGreaterThanOrEqual(before);
    expect(at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
    db.run("UPDATE blobs SET refused_at = 5 WHERE sha256 = 's1'");
    // the same reason written again is a new refusal
    db.run("UPDATE blobs SET last_error = 'daily' WHERE sha256 = 's1'");
    expect(db.get<{ refused_at: number }>("SELECT refused_at FROM blobs WHERE sha256 = 's1'")!.refused_at).toBeGreaterThanOrEqual(before);
    db.run("UPDATE blobs SET refused_at = 5 WHERE sha256 = 's1'");
    db.run("UPDATE blobs SET operator_at = 9, last_error = NULL WHERE sha256 = 's1'");
    db.run("UPDATE blobs SET mirror_at = 9 WHERE sha256 = 's1'");
    expect(db.get("SELECT refused_at, last_error FROM blobs WHERE sha256 = 's1'")).toEqual({ refused_at: 5, last_error: null });
    // a row written whole with its reason, as INSERT OR REPLACE does
    db.run("INSERT OR REPLACE INTO blobs (sha256, kind, size, owner, last_error) VALUES ('s2', 'text', 10, 'o', 'quota')");
    expect(db.get<{ refused_at: number }>("SELECT refused_at FROM blobs WHERE sha256 = 's2'")!.refused_at).toBeGreaterThanOrEqual(before);
  });

  test('search ignores accents and matches prefixes', () => {
    const db = memoryDb();
    migrate(db);
    db.run('INSERT INTO items_fts (rowid, title, site, url, body) VALUES (1, ?, ?, ?, ?)', 'Café crème', 'example.com', 'https://example.com', 'body');
    expect(db.all("SELECT rowid FROM items_fts WHERE items_fts MATCH 'cafe*'")).toHaveLength(1);
  });
});
