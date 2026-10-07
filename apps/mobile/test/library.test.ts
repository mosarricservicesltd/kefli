import { LocalSigner } from '@shelf/protocol';
import type { NostrEvent } from '@shelf/protocol';
import { nodeCrypto } from '@shelf/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { release } from '../src/data/outbox';
import {
  activeOwner, commitDelete, commitOrphanDeletes, counts, deleteItem, listRows, minutes, minutesLeft, nextUnread, progressOf,
  rowByHash, rowStatus, setArchived, setPosition,
} from '../src/data/library';
import { sendOne, type SendPorts } from '../src/services/send';
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

  test('the next unread skips this one and saves without their text', () => {
    const w = world();
    w.add(1);
    w.add(2, { text_state: 'remote' });
    w.add(3);
    expect(nextUnread(w.db, w.pk, h(3))!.hash).toBe(h(1));
    expect(nextUnread(w.db, w.pk, h(1))!.hash).toBe(h(3));
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

  test('a delete sends a kind 5 naming the save to every write relay', async () => {
    const w = world();
    w.add(1);
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
    expect(sent[0].event.tags).toContainEqual(['a', `30078:${w.pk}:shelf/item/${h(1)}`]);
    expect(w.db.get<{ state: string }>("SELECT state FROM outbox_targets WHERE target = 'ws://b'")).toEqual({ state: 'pending' });
  });
});
