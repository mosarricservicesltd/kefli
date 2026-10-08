import { migrate } from '../src/data/schema';
import { ensureIdentityRow, priorOf, queueSave, undoSave } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { memoryDb } from './sqlite';

const PK = 'ab'.repeat(32);
const D = { operator: { relay: 'ws://op', blossom: 'http://b', api: 'http://api' }, relays: ['ws://a'], indexer: ['ws://a'], mirrors: ['http://m'] };
const T = { api: 'http://api', blossom: 'http://b', mirror: 'http://m' };
const H = 'cd'.repeat(32);

function world() {
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, 1, PK, 'new', true);
  seedGeneratedLists(db, PK, D);
  db.run('UPDATE identities SET registered_at = 1');
  const item = (savedAt: number) => ({
    owner: PK, hash: H, url: 'https://e.com/a', canonical: null, title: 'A', site: 'e.com', byline: null, savedAt, words: 10, lang: 'en', hero: null,
    text: { sha256: 'ef'.repeat(32), key: 'k', nonce: 'n' }, textHash: 'th', textState: 'cached' as const, origin: 'share',
  });
  const blob = { sha256: 'ef'.repeat(32), size: 10, path: '/staging/ef.bin' };
  return { db, item, blob };
}

describe('Undo on the Saved sheet (mobile spec 5.4, 4.3)', () => {
  test('a new save goes with its held rows, search entry and staged blob', () => {
    const w = world();
    expect(priorOf(w.db, PK, H)).toBeNull();
    const held = queueSave(w.db, 100, w.item(100), w.blob, T);
    expect(held.length).toBe(3);
    const id = w.db.get<{ id: number }>('SELECT id FROM items')!.id;
    w.db.run("INSERT INTO items_fts (rowid, title, site, url, body) VALUES (?, 'A', 'e.com', 'https://e.com/a', 'words')", id);
    expect(undoSave(w.db, PK, H, held, null)).toEqual({ staged: ['/staging/ef.bin'] });
    expect(w.db.all('SELECT * FROM items')).toEqual([]);
    expect(w.db.all('SELECT * FROM blobs')).toEqual([]);
    expect(w.db.all("SELECT op FROM outbox WHERE op != 'publish_lists'")).toEqual([]);
    expect(w.db.get('SELECT COUNT(*) AS n FROM items_fts WHERE rowid = ?', id)).toEqual({ n: 0 });
  });

  test('an archived save brought back by the share is archived again as it was', () => {
    const w = world();
    queueSave(w.db, 100, w.item(100), w.blob, T);
    w.db.run("UPDATE items SET state = 'archived', dirty = 0, modified_at = 150");
    w.db.run('DELETE FROM outbox');
    const prior = priorOf(w.db, PK, H);
    expect(prior).toEqual({ state: 'archived', saved_at: 100, dirty: 0, modified_at: 150 });
    const held = queueSave(w.db, 200, w.item(200), null, T);
    expect(w.db.get('SELECT state, saved_at FROM items')).toEqual({ state: 'unread', saved_at: 200 });
    expect(undoSave(w.db, PK, H, held, prior)).toEqual({ staged: [] });
    expect(w.db.get('SELECT state, saved_at, dirty, modified_at FROM items')).toEqual({ state: 'archived', saved_at: 100, dirty: 0, modified_at: 150 });
    expect(w.db.all('SELECT op FROM outbox')).toEqual([]);
  });

  test('an unread save shared again is unchanged, and a deleted one counts as absent', () => {
    const w = world();
    queueSave(w.db, 100, w.item(100), w.blob, T);
    expect(queueSave(w.db, 200, w.item(200), null, T)).toEqual([]);
    expect(w.db.get('SELECT saved_at FROM items')).toEqual({ saved_at: 100 });
    w.db.run('UPDATE items SET pending_delete_at = 5');
    expect(priorOf(w.db, PK, H)).toBeNull();
  });
});
