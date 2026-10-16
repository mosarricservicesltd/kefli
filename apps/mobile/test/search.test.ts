import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { INDEX_CHARS, indexText } from '../src/data/sync';
import { deleteItem } from '../src/data/library';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QUERY_MAX_CHARS, QUERY_WORDS, QUERY_WORD_CHARS, matchExpression, queryWords, search } from '../src/data/search';
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

  test('a query pasted whole, of thousands of words or one endless one, searches without throwing', () => {
    const w = world();
    w.add(1, 'Bookmarks are a graveyard', 'Most people never return to what they save.');
    w.add(2, 'Waiting for its text', null);
    // past 1,000 words the GLOB fallback's AND chain is deeper than SQLite parses, and FTS5's is deeper still
    const pasted = `most people ${'never return to what they save '.repeat(400)}`;
    expect(() => search(w.db, PK, pasted)).not.toThrow();
    expect(search(w.db, PK, pasted).map((r) => r.hash)).toEqual([h(1)]);
    expect(search(w.db, PK, `waiting ${'x'.repeat(200_000)}`)).toEqual([]);
    expect(queryWords(pasted).length).toBeLessThanOrEqual(QUERY_WORDS);
    expect(queryWords('x'.repeat(5_000))[0]).toHaveLength(QUERY_WORD_CHARS);
  });

  test("Search's field holds what a query is read for and no more: a page pasted in keeps its first 4 KB", () => {
    // sixteen words of 64 characters, with room for punctuation between them
    expect(QUERY_MAX_CHARS).toBe(QUERY_WORDS * (QUERY_WORD_CHARS + 1) * 4);
    const pasted = `${'word, '.repeat(QUERY_MAX_CHARS / 6)}latecomer`;
    expect(pasted.length).toBeGreaterThan(QUERY_MAX_CHARS);
    expect(queryWords(pasted.slice(0, QUERY_MAX_CHARS))).toEqual(queryWords(pasted));
    // the field itself: Android cuts what is typed or pasted at maxLength, before it reaches the query
    const src = readFileSync(join(__dirname, '..', 'src', 'screens', 'Search.tsx'), 'utf8');
    expect(src).toMatch(/<TextInput[^>]*\smaxLength=\{QUERY_MAX_CHARS\}/);
  });

  test("a book-length text is indexed up to INDEX_CHARS, its title and opening found, in a bounded time", () => {
    const w = world();
    const filler = 'saving reading later quiet stone heather river winter '.repeat(Math.ceil((INDEX_CHARS * 2.5) / 55));
    const t = Date.now();
    w.add(1, 'A very long book', `opening words ${filler} closingword`);
    // before, all five megabytes went into the index in one transaction on the JS thread (generous: suites run at once)
    expect(Date.now() - t).toBeLessThan(15_000);
    expect(search(w.db, PK, 'opening').map((r) => r.hash)).toEqual([h(1)]);
    expect(search(w.db, PK, 'book').map((r) => r.hash)).toEqual([h(1)]);
    expect(search(w.db, PK, 'closingword')).toEqual([]);
  });

  test('a save waiting on a delete is not found', () => {
    const w = world();
    w.add(5, 'Soon gone', 'Words.');
    deleteItem(w.db, 10, PK, h(5));
    expect(search(w.db, PK, 'soon')).toEqual([]);
  });
});
