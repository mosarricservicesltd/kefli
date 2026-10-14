import { LocalSigner, savedD } from '@kefli/protocol';
import type { NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { release, releaseOrphans } from '../src/data/outbox';
import {
  activeOwner, commitDelete, commitOrphanDeletes, commitOrphans, counts, deleteItem, listRows, minutes, minutesLeft, nextUnread, progressOf,
  reconcileWords, rowByHash, rowStatus, setArchived, setPosition,
} from '../src/data/library';
import { drain, sendOne, type SendPorts } from '../src/services/send';
import { memoryDb } from './sqlite';

const D = { v: 1, operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' }, relays: ['ws://a', 'ws://b'], indexer: ['ws://idx'], mirrors: ['http://m1'] };
const h = (n: number) => n.toString(16).padStart(64, '0');

function world() {
  const db = memoryDb();
  migrate(db);
  const signer = new LocalSigner(nodeCrypto.randomBytes(32));
  const pk = signer.pubkey();
  ensureIdentityRow(db, 1, pk, 'new', true);
  seedGeneratedLists(db, pk, D);
  const add = (n: number, o: Record<string, string | number | null> = {}) => {
    const c = { state: 'unread', text_state: 'cached', words: 2300, saved_at: 1000 + n, position_word: 0, text_sha256: null, text_servers: null, ...o };
    db.run(
      `INSERT INTO items (owner, hash, url, title, saved_at, state, words, position_word, text_state, origin, text_sha256, text_servers)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'share', ?, ?)`,
      pk, h(n), `https://e.com/${n}`, `Title ${n}`, c.saved_at, c.state, c.words, c.position_word, c.text_state, c.text_sha256, c.text_servers,
    );
  };
  const outbox = () => db.all<{ op: string; subject: string; state: string; was_queued: number }>('SELECT op, subject, state, was_queued FROM outbox ORDER BY id');
  return { db, signer, pk, add, outbox };
}

describe('the library (mobile spec 5.6)', () => {
  test('the lists, newest first, and their counts', () => {
    const w = world();
    w.add(1);
    w.add(2);
    w.add(3, { state: 'archived' });
    expect(activeOwner(w.db)).toBe(w.pk);
    expect(listRows(w.db, w.pk, 'unread').map((r) => r.hash)).toEqual([h(2), h(1)]);
    expect(counts(w.db, w.pk)).toEqual({ unread: 2, archived: 1 });
  });

  test('minutes, minutes left and the row status', () => {
    expect(minutes(2300)).toBe(10);
    expect(minutes(50)).toBe(1);
    expect(minutes(null)).toBeNull();
    expect(minutesLeft({ words: 2300, position_word: 1150 })).toBe(5);
    expect(minutesLeft({ words: 2300, position_word: 2299 })).toBe(1);
    expect(progressOf({ words: 100, position_word: 34 })).toBe(0.34);
    expect(progressOf({ words: 100, position_word: 99 })).toBe(1);
    expect(['cached', 'failed', 'remote', 'queued'].map((s) => rowStatus({ text_state: s }))).toEqual(['ok', 'failed', 'waiting', 'waiting']);
  });

  test('archive is held until its toast closes, and Undo puts everything back', () => {
    const w = world();
    w.add(1);
    const c = setArchived(w.db, 2000, w.pk, h(1), true);
    expect(rowByHash(w.db, w.pk, h(1))!.state).toBe('archived');
    expect(w.outbox()).toEqual([{ op: 'publish_item', subject: h(1), state: 'held', was_queued: 0 }]);
    c.revert();
    expect(rowByHash(w.db, w.pk, h(1))!.state).toBe('unread');
    expect(w.outbox()).toEqual([]);
    const again = setArchived(w.db, 2001, w.pk, h(1), true);
    release(w.db, again.held);
    expect(w.outbox()[0].state).toBe('queued');
  });

  test('an archive merging into a queued publish keeps it on Undo', () => {
    const w = world();
    w.add(1);
    setPosition(w.db, 1500, w.pk, h(1), 100, true);
    const c = setArchived(w.db, 2000, w.pk, h(1), true);
    expect(w.outbox()).toEqual([{ op: 'publish_item', subject: h(1), state: 'held', was_queued: 1 }]);
    c.revert();
    expect(w.outbox()).toEqual([{ op: 'publish_item', subject: h(1), state: 'queued', was_queued: 0 }]);
    expect(setArchived(w.db, 1, w.pk, h(99), true).held).toEqual([]);
  });

  test('a count from a newer projection is stored with its progress and published with the next position', () => {
    const w = world();
    w.add(1, { words: 1289, position_word: 600 });
    w.add(2, { words: 1289, position_word: 1288 });
    reconcileWords(w.db, 1500, w.pk, h(1), 948);
    reconcileWords(w.db, 1500, w.pk, h(2), 948);
    const row = (n: number) => w.db.get<{ words: number; position_word: number; progress: number; dirty: number }>('SELECT words, position_word, progress, dirty FROM items WHERE hash = ?', h(n))!;
    expect(row(1)).toMatchObject({ words: 948, position_word: 600, dirty: 1 });
    expect(row(1).progress).toBeCloseTo(600 / 948);
    expect(row(2)).toMatchObject({ words: 948, position_word: 947 }); // read through stays read through
    expect(progressOf(rowByHash(w.db, w.pk, h(2))!)).toBe(1);
    expect(w.outbox()).toEqual([]);
    setPosition(w.db, 1600, w.pk, h(1), 600, true);
    expect(w.outbox()).toEqual([{ op: 'publish_item', subject: h(1), state: 'queued', was_queued: 0 }]);
  });

  test('a count that agrees, or a row without one, is left alone', () => {
    const w = world();
    w.add(1, { words: 948 });
    w.add(2, { words: null });
    reconcileWords(w.db, 1500, w.pk, h(1), 948);
    reconcileWords(w.db, 1500, w.pk, h(2), 948);
    reconcileWords(w.db, 1500, w.pk, h(9), 948);
    expect(w.db.all('SELECT words, dirty FROM items ORDER BY hash')).toEqual([{ words: 948, dirty: 0 }, { words: null, dirty: 0 }]);
  });

  test('delete hides the row at once, Undo shows it again, and the toast closing removes it', () => {
    const w = world();
    w.add(1, { text_sha256: 'ab'.repeat(32), text_servers: JSON.stringify(['http://blossom', 'http://m1']) });
    w.db.run("INSERT INTO blobs (sha256, hash, kind, owner, operator_at) VALUES (?, ?, 'text', ?, 1)", 'ab'.repeat(32), h(1), w.pk);
    const c = deleteItem(w.db, 2000, w.pk, h(1));
    expect(listRows(w.db, w.pk, 'unread')).toEqual([]);
    expect(w.outbox().map((o) => [o.op, o.state])).toEqual([['delete_item', 'held'], ['delete_blob', 'held']]);
    c.revert();
    expect(listRows(w.db, w.pk, 'unread')).toHaveLength(1);
    expect(w.outbox()).toEqual([]);
    const d = deleteItem(w.db, 2001, w.pk, h(1));
    commitDelete(w.db, w.pk, h(1), d.held);
    expect(rowByHash(w.db, w.pk, h(1))).toBeUndefined();
    expect(w.outbox().map((o) => [o.op, o.state])).toEqual([['delete_item', 'queued'], ['delete_blob', 'queued']]);
    expect(deleteItem(w.db, 1, w.pk, h(99)).held).toEqual([]);
  });

  test('a delete left waiting by a process death is carried out at the next start', () => {
    const w = world();
    w.add(1);
    deleteItem(w.db, 2000, w.pk, h(1));
    expect(commitOrphanDeletes(w.db, w.pk)).toEqual([h(1)]);
    expect(rowByHash(w.db, w.pk, h(1))).toBeUndefined();
  });

  test('at start, a delete cut short goes through, and a publish queued before it never brings the save back (F38)', async () => {
    const w = world();
    w.add(1);
    w.db.run("UPDATE items SET published = 1, event_id = 'e1', event_created_at = 1000, remote_d = 'kefli/item/' || hash WHERE hash = ?", h(1));
    w.add(2);
    // the Reader closed (a position publish queued), then the save was deleted and the process died during the toast
    setPosition(w.db, 1500, w.pk, h(1), 50, true);
    deleteItem(w.db, 1600, w.pk, h(1));
    releaseOrphans(w.db);
    expect(commitOrphans(w.db)).toEqual([h(1)]);
    expect(rowByHash(w.db, w.pk, h(1))).toBeUndefined();
    expect(w.outbox().map((o) => o.op)).toEqual(['delete_item']);
    let t = 2000;
    let failA = true;
    const sent: { relay: string; kind: number }[] = [];
    const ports: SendPorts = {
      db: w.db, now: () => t, signer: async () => w.signer, fetch: (async () => new Response('{}')) as never, crypto: nodeCrypto,
      defaults: () => D as never,
      publish: async (relay, event) => {
        if (relay === 'ws://a' && failA) {
          failA = false;
          throw new Error('timeout');
        }
        sent.push({ relay, kind: event.kind });
        return { ok: true };
      },
      readBlob: async () => null,
    };
    await drain(ports);
    t += 60;
    await drain(ports);
    expect(sent.filter((s) => s.kind === 30078)).toEqual([]);
    expect(sent.filter((s) => s.kind === 5).map((s) => s.relay).sort()).toEqual(['ws://a', 'ws://b', 'ws://op']);
    expect(commitOrphans(w.db)).toEqual([]);
  });

  test('a save waiting on its delete’s Undo is not published; Undo lets it go (F38)', async () => {
    const w = world();
    w.add(1);
    setPosition(w.db, 1500, w.pk, h(1), 50, true);
    const c = deleteItem(w.db, 1600, w.pk, h(1));
    const sent: NostrEvent[] = [];
    let t = 1601;
    const ports: SendPorts = {
      db: w.db, now: () => t, signer: async () => w.signer, fetch: (async () => new Response('{}')) as never, crypto: nodeCrypto,
      defaults: () => D as never, publish: async (_r, event) => (sent.push(event), { ok: true }), readBlob: async () => null,
    };
    expect(await sendOne(ports)).toBe(true);
    expect(sent).toEqual([]);
    c.revert();
    t += 15;
    await sendOne(ports);
    expect(sent.filter((e) => e.tags.some((x) => x[0] === 'd' && x[1].startsWith('kefli/item/')))).toHaveLength(3);
  });

  test('deleting a save that came by sync deletes its blob from every server it names (F33)', () => {
    const w = world();
    // no blobs row: another phone uploaded it
    w.add(1, { text_sha256: 'ab'.repeat(32), text_servers: JSON.stringify(['http://blossom', 'http://m2']) });
    const d = deleteItem(w.db, 2000, w.pk, h(1));
    commitDelete(w.db, w.pk, h(1), d.held);
    expect(w.outbox().map((o) => [o.op, o.state])).toEqual([['delete_item', 'queued'], ['delete_blob', 'queued']]);
    const targets = w.db.all<{ target: string }>("SELECT target FROM outbox_targets t JOIN outbox o ON o.id = t.outbox_id WHERE o.op = 'delete_blob' ORDER BY target");
    expect(targets.map((t) => t.target)).toEqual(['http://blossom', 'http://m2']);
  });

  test('a blob another save of the owner’s still names stays', () => {
    const w = world();
    w.add(1, { text_sha256: 'ab'.repeat(32), text_servers: JSON.stringify(['http://blossom']) });
    w.add(2, { text_sha256: 'ab'.repeat(32), text_servers: JSON.stringify(['http://blossom']) });
    deleteItem(w.db, 2000, w.pk, h(1));
    expect(w.outbox().map((o) => o.op)).toEqual(['delete_item']);
  });

  test('the next unread skips this one and saves without their text', () => {
    const w = world();
    w.add(1);
    w.add(2, { text_state: 'remote' });
    w.add(3);
    expect(nextUnread(w.db, w.pk, h(3))!.hash).toBe(h(1));
    expect(nextUnread(w.db, w.pk, h(1))!.hash).toBe(h(3));
  });

  test('the next unread reads one row, not the whole list, however large the library', () => {
    const w = world();
    w.db.tx(() => {
      for (let n = 1; n <= 20_000; n++) w.add(n, { text_state: n % 3 ? 'remote' : 'cached' });
    });
    let rows = 0;
    const counted = {
      ...w.db,
      all: <T,>(sql: string, ...p: never[]) => { const r = w.db.all<T>(sql, ...p); rows += r.length; return r; },
      get: <T,>(sql: string, ...p: never[]) => { const r = w.db.get<T>(sql, ...p); rows += r ? 1 : 0; return r; },
    };
    // the Reader asks on each render, and it renders as each batch of blocks comes and each word is reached
    expect(nextUnread(counted, w.pk, h(19_998))!.hash).toBe(h(19_995));
    expect(nextUnread(counted, w.pk, h(20_000))!.hash).toBe(h(19_998));
    expect(rows).toBeLessThanOrEqual(2);
  });

  test('a position that is not a number leaves the stored one as it was', () => {
    const w = world();
    w.add(1, { words: 100, position_word: 40 });
    for (const bad of [NaN, Infinity, -Infinity]) setPosition(w.db, 1500, w.pk, h(1), bad, true);
    expect(w.db.get('SELECT position_word, progress FROM items WHERE hash = ?', h(1))).toEqual({ position_word: 40, progress: 0 });
    expect(w.outbox()).toEqual([]);
  });

  test('the position is clamped, stored, and published only when asked', () => {
    const w = world();
    w.add(1, { words: 100 });
    setPosition(w.db, 1500, w.pk, h(1), 500, false);
    expect(rowByHash(w.db, w.pk, h(1))!.position_word).toBe(99);
    expect(w.outbox()).toEqual([]);
    setPosition(w.db, 1501, w.pk, h(1), 99, true);
    expect(w.outbox()).toEqual([{ op: 'publish_item', subject: h(1), state: 'queued', was_queued: 0 }]);
    setPosition(w.db, 1502, w.pk, h(99), 1, true);
  });

  test('a delete sends a kind 5 naming the save, at every address it was published at, to every write relay', async () => {
    const w = world();
    w.add(1);
    // published before v1.10, unkeyed; the library key has come since (F5)
    w.db.run("UPDATE items SET remote_d = 'kefli/item/' || hash WHERE hash = ?", h(1));
    const key = new Uint8Array(32).fill(7);
    w.db.run('UPDATE identities SET library_key = ? WHERE pubkey = ?', '07'.repeat(32), w.pk);
    const d = deleteItem(w.db, 2000, w.pk, h(1));
    commitDelete(w.db, w.pk, h(1), d.held);
    const sent: { relay: string; event: NostrEvent }[] = [];
    const ports: SendPorts = {
      db: w.db, now: () => 2100, signer: async () => w.signer, fetch: (async () => new Response('{}')) as never, crypto: nodeCrypto,
      defaults: () => D as never, publish: async (relay, event) => { sent.push({ relay, event }); return relay === 'ws://b' ? { ok: false, reason: 'rate-limited: slow' } : { ok: true }; },
      readBlob: async () => null,
    };
    expect(await sendOne(ports)).toBe(true);
    expect(sent.map((s) => s.relay).sort()).toEqual(['ws://a', 'ws://b', 'ws://op']);
    expect(sent[0].event.kind).toBe(5);
    expect(sent[0].event.tags).toContainEqual(['a', `30078:${w.pk}:kefli/item/${h(1)}`]);
    expect(sent[0].event.tags).toContainEqual(['a', `30078:${w.pk}:${savedD(key, h(1))}`]);
    expect(w.db.get<{ state: string }>("SELECT state FROM outbox_targets WHERE target = 'ws://b'")).toEqual({ state: 'pending' });
  });

  test('a save never published names nothing in public when deleted (F5, F33)', async () => {
    const w = world();
    w.add(1);
    const d = deleteItem(w.db, 2000, w.pk, h(1));
    commitDelete(w.db, w.pk, h(1), d.held);
    const sent: NostrEvent[] = [];
    const ports: SendPorts = {
      db: w.db, now: () => 2100, signer: async () => w.signer, fetch: (async () => new Response('{}')) as never, crypto: nodeCrypto,
      defaults: () => D as never, publish: async (_r, event) => (sent.push(event), { ok: true }), readBlob: async () => null,
    };
    await sendOne(ports);
    expect(sent).toEqual([]);
  });
});
