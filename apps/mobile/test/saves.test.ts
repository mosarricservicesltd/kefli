import { migrate } from '../src/data/schema';
import { ensureIdentityRow, priorOf, queueSave, undoSave } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { commitDelete, deleteItem, undoShare } from '../src/data/library';
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

describe('a save shared again while its delete waits on Undo (FD 34)', () => {
  function deleting() {
    const w = world();
    queueSave(w.db, 100, w.item(100), w.blob, T);
    w.db.run("UPDATE items SET event_id = 'e1', event_created_at = 100, remote_d = 'kefli/item/x', dirty = 0");
    w.db.run('DELETE FROM outbox');
    const change = deleteItem(w.db, 150, PK, H);
    return { ...w, del: change.held, change };
  }

  test("the delete's own Undo afterwards leaves the share's publish alone", () => {
    const w = deleting();
    const held = queueSave(w.db, 200, w.item(200), null, T);
    w.change.revert();
    expect(held).toHaveLength(1);
    expect(w.db.all('SELECT op, state FROM outbox')).toEqual([{ op: 'publish_item', state: 'held' }]);
    expect(w.db.get('SELECT state, saved_at, pending_delete_at FROM items')).toEqual({ state: 'unread', saved_at: 200, pending_delete_at: null });
  });

  test('is kept: the delete is undone and the save comes back to the top of Unread', () => {
    const w = deleting();
    expect(priorOf(w.db, PK, H)).toBeNull();
    const held = queueSave(w.db, 200, w.item(200), null, T);
    expect(held).toHaveLength(1);
    expect(w.db.get('SELECT state, saved_at, pending_delete_at, dirty FROM items')).toEqual({ state: 'unread', saved_at: 200, pending_delete_at: null, dirty: 1 });
    // the Saves screen's toast closes afterwards without Undo: nothing is deleted, here or on the relays
    commitDelete(w.db, PK, H, w.del);
    expect(w.db.get('SELECT COUNT(*) AS n FROM items')).toEqual({ n: 1 });
    expect(w.db.all('SELECT op, state FROM outbox')).toEqual([{ op: 'publish_item', state: 'held' }]);
  });

  test("the share's Undo deletes it as Delete does, its kind 5 included", () => {
    const w = deleting();
    const held = queueSave(w.db, 200, w.item(200), null, T);
    expect(undoShare(w.db, 210, PK, H, held, null)).toEqual({ staged: [] });
    expect(w.db.all('SELECT * FROM items')).toEqual([]);
    expect(w.db.all("SELECT op, state FROM outbox WHERE op = 'delete_item'")).toEqual([{ op: 'delete_item', state: 'queued' }]);
    expect(w.db.all("SELECT op FROM outbox WHERE op = 'publish_item'")).toEqual([]);
  });

  test("a new save's Undo is undoSave's", () => {
    const w = world();
    const held = queueSave(w.db, 100, w.item(100), w.blob, T);
    expect(undoShare(w.db, 110, PK, H, held, null)).toEqual({ staged: ['/staging/ef.bin'] });
    expect(w.db.all('SELECT * FROM items')).toEqual([]);
    expect(w.db.all("SELECT op FROM outbox WHERE op != 'publish_lists'")).toEqual([]);
  });
});
