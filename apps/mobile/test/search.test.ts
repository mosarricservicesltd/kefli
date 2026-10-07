import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { indexText } from '../src/data/sync';
import { deleteItem } from '../src/data/library';
import { matchExpression, queryWords, search } from '../src/data/search';
import { memoryDb } from './sqlite';

const PK = 'ab'.repeat(32);
const h = (n: number) => n.toString(16).padStart(64, '0');

function world() {
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, 1, PK, 'new', true);
  const add = (n: number, title: string, body: string | null, state = 'unread', site = 'example.com') => {
    const id = db.run("INSERT INTO items (owner, hash, url, title, site, saved_at, state, text_state, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'share')",
      PK, h(n), `https://${site}/${n}`, title, site, n, state, body === null ? 'remote' : 'cached').lastInsertRowId;
    if (body !== null) indexText(db, { id, title, site, url: `https://${site}/${n}` }, body);
  };
  return { db, add };
}

describe('search (mobile spec 4.9, 5.6)', () => {
  test('a query becomes prefix words, all required', () => {
    expect(queryWords('  Café, "read-later"! ')).toEqual(['café', 'read', 'later']);
    expect(matchExpression(['read', 'lat'])).toBe('"read"* AND "lat"*');
    expect(queryWords('—')).toEqual([]);
  });

  test('full text, prefixes and diacritics, across Unread and Archive, best match first', () => {
    const w = world();
    w.add(1, 'Bookmarks are a graveyard', 'Most people never return to what they save.');
    w.add(2, 'The quiet return of reading', 'Reading later returns, and reading offline too. Reading.', 'archived');
    w.add(3, 'Café culture', 'Nothing about saving here.');
    expect(search(w.db, PK, 'retur').map((r) => r.hash)).toEqual([h(2), h(1)]);
    expect(search(w.db, PK, 'cafe').map((r) => r.hash)).toEqual([h(3)]);
    expect(search(w.db, PK, 'reading offline').map((r) => [r.hash, r.state])).toEqual([[h(2), 'archived']]);
    expect(search(w.db, PK, 'reading graveyard')).toEqual([]);
    expect(search(w.db, PK, '')).toEqual([]);
  });

  test("a save whose text isn't here yet is found by its title, site or address", () => {
    const w = world();
    w.add(4, 'Waiting for its text', null, 'unread', 'news.example');
    expect(search(w.db, PK, 'waiti').map((r) => r.hash)).toEqual([h(4)]);
    expect(search(w.db, PK, 'news').map((r) => r.hash)).toEqual([h(4)]);
    expect(search(w.db, PK, 'aiting')).toEqual([]);
  });

  test('a save waiting on a delete is not found', () => {
    const w = world();
    w.add(5, 'Soon gone', 'Words.');
    deleteItem(w.db, 10, PK, h(5));
    expect(search(w.db, PK, 'soon')).toEqual([]);
  });
});
