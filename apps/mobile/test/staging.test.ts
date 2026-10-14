// Staged ciphertext (mobile spec 4.2; contract 4.1, v1.12): kept while a save names the text, and swept with its row
// once none does. expo-file-system is a map in memory here.
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

  test("a blob row with no staged file, or another phone's inbox blob, is no business of the sweep's files", () => {
    const w = world();
    w.db.run("INSERT INTO blobs (sha256, hash, kind, owner) VALUES (?, ?, 'text', ?)", sha(3), sha(3), PK);
    w.db.run("INSERT INTO blobs (sha256, hash, kind, owner) VALUES (?, ?, 'inbox', ?)", sha(4), sha(4), PK);
    expect(orphanBlobs(w.db)).toEqual([]);
    expect(w.db.all('SELECT sha256 FROM blobs')).toEqual([{ sha256: sha(4) }]);
  });
});
