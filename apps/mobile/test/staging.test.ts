// Staged ciphertext (mobile spec 4.2; contract 4.1, v1.12): kept while a save names the text, and swept with its row
// once none does. expo-file-system is a map in memory here.
import type { Param, SqlDb } from '../src/data/db';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, orphanBlobs } from '../src/data/saves';
import { memoryDb } from './sqlite';

const mockFiles = new Map<string, Uint8Array>();
const mockFailing = new Set<string>();

jest.mock('expo-file-system', () => {
  class Entry {
    readonly uri: string;
    constructor(parent: Entry | string, ...names: string[]) {
      this.uri = [typeof parent === 'string' ? parent : parent.uri, ...names].join('/');
    }
    get exists() {
      return [...mockFiles.keys()].some((k) => k === this.uri || k.startsWith(`${this.uri}/`));
    }
    create() {}
    write(bytes: Uint8Array) {
      mockFiles.set(this.uri, bytes);
    }
    async bytes() {
      return mockFiles.get(this.uri)!;
    }
    delete() {
      if (mockFailing.has(this.uri)) throw new Error('busy');
      mockFiles.delete(this.uri);
    }
  }
  return { Directory: Entry, File: Entry, Paths: { document: 'file:///doc' } };
}, { virtual: true });

// required after the mock, as the module reads it at load
const { readStaged, stageBlob, sweepStaged } = require('../src/services/staging') as typeof import('../src/services/staging');

const PK = 'ab'.repeat(32);
const sha = (n: number) => n.toString(16).padStart(64, '0');

function world() {
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, 1, PK, 'new', true);
  const staged = (n: number, named: boolean) => {
    const path = stageBlob(sha(n), new Uint8Array([n]));
    db.run('INSERT INTO blobs (sha256, hash, kind, staged_path, size, owner) VALUES (?, ?, ?, ?, 1, ?)', sha(n), sha(n), 'text', path, PK);
    if (named) db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, text_sha256) VALUES (?, ?, 'https://e.com', 1, 'unread', 'cached', 'share', ?)", PK, sha(n), sha(n));
    return path;
  };
  return { db, staged };
}

beforeEach(() => {
  mockFiles.clear();
  mockFailing.clear();
});

describe('staged texts (4.2, C§4.1)', () => {
  test('a text stays staged while a save names it, and goes with its row once none does', async () => {
    const w = world();
    const kept = w.staged(1, true);
    const gone = w.staged(2, false);
    expect(await readStaged(sha(1))).toEqual(new Uint8Array([1]));
    expect(sweepStaged(w.db)).toBe(1);
    expect([...mockFiles.keys()]).toEqual([kept]);
    expect(await readStaged(sha(2))).toBeNull();
    expect(w.db.all('SELECT sha256 FROM blobs')).toEqual([{ sha256: sha(1) }]);
    expect(gone).toContain('/kefli/staging/');
  });

  test("a file that can't be removed is left, its row gone, and the sweep carries on", () => {
    const w = world();
    const stuck = w.staged(1, false);
    w.staged(2, false);
    mockFailing.add(stuck);
    expect(sweepStaged(w.db)).toBe(1);
    expect([...mockFiles.keys()]).toEqual([stuck]);
    expect(w.db.all('SELECT sha256 FROM blobs')).toEqual([]);
  });

  test('the sweep reads the saves once, not once for each text: 4,000 texts take a moment, on every outbox run', () => {
    // counted, not timed, so a busy machine can't fail it: the statements the sweep sends, and how SQLite plans each.
    // A subquery run again for each text (CORRELATED) read every save for each of thousands of texts; the saves' texts
    // are listed once (LIST SUBQUERY), and the statements are as many for 4,000 texts as for one
    const w = world();
    for (let n = 0; 4000 > n; n++) {
      w.db.run("INSERT INTO blobs (sha256, hash, kind, owner) VALUES (?, ?, 'text', ?)", sha(n), sha(n), PK);
      w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, text_sha256) VALUES (?, ?, 'https://e.com', 1, 'unread', 'cached', 'share', ?)", PK, sha(n), n % 2 ? sha(n) : null);
    }
    const sent: [string, Param[]][] = [];
    const counted: SqlDb = {
      ...w.db,
      run: (sql: string, ...params: Param[]) => (sent.push([sql, params]), w.db.run(sql, ...params)),
      get: <T,>(sql: string, ...params: Param[]) => (sent.push([sql, params]), w.db.get<T>(sql, ...params)),
      all: <T,>(sql: string, ...params: Param[]) => (sent.push([sql, params]), w.db.all<T>(sql, ...params)),
    };
    expect(orphanBlobs(counted)).toEqual([]);
    expect(w.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blobs')?.n).toBe(2000);
    expect(sent.length).toBeLessThanOrEqual(2);
    for (const [sql, params] of sent) {
      const plan = w.db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((r) => r.detail);
      expect([sql, plan.filter((d) => d.includes('CORRELATED'))]).toEqual([sql, []]);
    }
  });

  test("a blob row with no staged file, or another phone's inbox blob, is no business of the sweep's files", () => {
    const w = world();
    w.db.run("INSERT INTO blobs (sha256, hash, kind, owner) VALUES (?, ?, 'text', ?)", sha(3), sha(3), PK);
    w.db.run("INSERT INTO blobs (sha256, hash, kind, owner) VALUES (?, ?, 'inbox', ?)", sha(4), sha(4), PK);
    expect(orphanBlobs(w.db)).toEqual([]);
    expect(w.db.all('SELECT sha256 FROM blobs')).toEqual([{ sha256: sha(4) }]);
  });
});
