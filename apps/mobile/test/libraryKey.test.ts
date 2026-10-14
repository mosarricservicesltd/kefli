import {
  ITEM_D_PREFIX, LIBRARY_KEY_D, LocalSigner, buildDeletions, buildItemEvent, buildLibraryKeyEvent, readItemEvent, readLibraryKeyEvent, savedD,
  type NostrEvent,
} from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { enqueue } from '../src/data/outbox';
import { applyDeletion } from '../src/data/sync';
import { libraryKey, makeLibraryKey } from '../src/data/libraryKey';
import { drain, type SendPorts } from '../src/services/send';
import { syncLibraryKey, type Filter, type SyncPorts } from '../src/services/sync';
import { memoryDb } from './sqlite';

const D = { v: 1 as const, operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' }, relays: ['ws://a', 'ws://b'], indexer: ['ws://idx'], mirrors: ['http://m1'] };
const h = (n: number) => n.toString(16).padStart(64, '0');
const dOf = (e: NostrEvent) => e.tags.find((t) => t[0] === 'd')?.[1];

function world(origin = 'new', down: string[] = [], same?: { s: LocalSigner; relays: Map<string, NostrEvent[]> }) {
  const db = memoryDb();
  migrate(db);
  const s = same?.s ?? new LocalSigner(nodeCrypto.randomBytes(32));
  const pk = s.pubkey();
  ensureIdentityRow(db, 1, pk, origin, true);
  seedGeneratedLists(db, pk, D);
  db.run('UPDATE identities SET registered_at = 1 WHERE pubkey = ?', pk);
  const relays = same?.relays ?? new Map<string, NostrEvent[]>();
  const log: NostrEvent[] = [];
  let clock = 1000;
  const publish = async (url: string, e: NostrEvent) => {
    if (down.includes(url)) throw new Error('down');
    const d = dOf(e);
    const kept = (relays.get(url) ?? []).filter((x) => !(e.kind === 30078 && x.kind === 30078 && dOf(x) === d));
    relays.set(url, [...kept, e]);
    log.push(e);
    return { ok: true as const };
  };
  const query = async (url: string, filters: Filter[]) => {
    if (down.includes(url)) throw new Error('down');
    const f = filters[0];
    return (relays.get(url) ?? []).filter((e) => f.kinds.includes(e.kind) && (!f['#d'] || f['#d'].includes(dOf(e) ?? '')));
  };
  const send: SendPorts = {
    db, now: () => clock, signer: async (k) => (k === pk ? s : null), fetch: (async () => new Response('{}')) as never, crypto: nodeCrypto,
    defaults: () => D, publish, readBlob: async () => null, query,
  };
  const sync = { db, now: () => clock, signer: async (k: string) => (k === pk ? s : null), query, crypto: nodeCrypto } as unknown as SyncPorts;
  const item = (n: number, remoteD: string | null = null) => {
    db.run(`INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, published, event_id, event_created_at, remote_d)
      VALUES (?, ?, ?, 1, 'unread', 'failed', 'share', ?, ?, 500, ?)`, pk, h(n), `https://e.com/${n}`, remoteD ? 1 : 0, remoteD ? 'e' : null, remoteD);
    enqueue(db, clock, { op: 'publish_item', signer: pk, subject: h(n), targets: ['ws://op', 'ws://a', 'ws://b'] });
  };
  return { db, s, pk, relays, log, send, sync, item, tick: (t: number) => (clock += t) };
}

describe('the library key (contract 4.3, F5)', () => {
  test('a keyed address depends on the key and says nothing of the URL’s hash', () => {
    const k1 = new Uint8Array(32).fill(1);
    const k2 = new Uint8Array(32).fill(2);
    expect(savedD(k1, h(1))).toMatch(/^kefli\/item\/[0-9a-f]{64}$/);
    expect(savedD(k1, h(1))).not.toBe(ITEM_D_PREFIX + h(1));
    expect(savedD(k1, h(1))).not.toBe(savedD(k2, h(1)));
    expect(savedD(k1, h(1))).toBe(savedD(k1, h(1)));
  });

  test('the record and a keyed save open as they were made; a save from before v1.10 reads its hash from its d', async () => {
    const s = new LocalSigner(nodeCrypto.randomBytes(32));
    const key = nodeCrypto.randomBytes(32);
    expect(await readLibraryKeyEvent(s, await buildLibraryKeyEvent(s, key, 5))).toEqual(key);
    const parsed = { item: { v: 1, url: 'https://e.com/1', canonical: null, title: 'T', site: null, byline: null, saved_at: 1, state: 'unread', progress: 0, words: null, lang: null, text: null, text_hash: null, hero: null, source_kind: 'web', audio_pref: null } as never, extra: {} };
    const keyed = (await buildItemEvent(s, h(9), parsed, 5, key)).event;
    expect(await readItemEvent(s, keyed)).toMatchObject({ hash: h(9), d: savedD(key, h(9)) });
    const legacy = (await buildItemEvent(s, h(8), parsed, 5)).event;
    expect(await readItemEvent(s, legacy)).toMatchObject({ hash: h(8), d: ITEM_D_PREFIX + h(8) });
  });

  test('an identity made here makes its key at its first publish, and the record reaches the relays first', async () => {
    const w = world('new');
    w.item(1);
    await drain(w.send);
    const key = libraryKey(w.db, w.pk)!;
    const firstKey = w.log.findIndex((e) => dOf(e) === LIBRARY_KEY_D);
    const firstSave = w.log.findIndex((e) => dOf(e)?.startsWith(ITEM_D_PREFIX));
    expect(firstKey).toBeGreaterThanOrEqual(0);
    expect(firstKey).toBeLessThan(firstSave);
    expect(dOf(w.log[firstSave])).toBe(savedD(key, h(1)));
    expect(w.log.some((e) => dOf(e) === ITEM_D_PREFIX + h(1))).toBe(false);
  });

  test('a restored phone takes the key on its relays, and makes none while a relay hasn’t answered', async () => {
    const other = world('new');
    other.item(1);
    await drain(other.send);
    // the same identity restored on a second phone, against the same relays, one of them down
    const w = world('recovery_code', ['ws://b'], { s: other.s, relays: other.relays });
    await syncLibraryKey(w.sync, w.pk);
    expect(libraryKey(w.db, w.pk)).toEqual(libraryKey(other.db, other.pk));
    // a restore that finds no record while a relay is down makes no key; once all answer, it makes one
    const fresh = world('recovery_code', ['ws://b']);
    await syncLibraryKey(fresh.sync, fresh.pk);
    expect(libraryKey(fresh.db, fresh.pk)).toBeNull();
    fresh.item(1);
    await drain(fresh.send);
    expect(fresh.log.filter((e) => dOf(e)?.startsWith(ITEM_D_PREFIX))).toEqual([]);
  });

  test('a key not yet published yields to the one on the relays; saves move to their new address and the old is retired', async () => {
    const w = world('recovery_code');
    const mine = makeLibraryKey(w.db, 900, w.pk, nodeCrypto.randomBytes);
    w.db.run("DELETE FROM outbox WHERE op = 'publish_library_key'");
    w.item(1, savedD(mine, h(1)));
    w.db.run("DELETE FROM outbox WHERE op = 'publish_item'");
    const theirs = nodeCrypto.randomBytes(32);
    await w.send.publish('ws://op', await buildLibraryKeyEvent(w.s, theirs, 800));
    await syncLibraryKey(w.sync, w.pk);
    expect(libraryKey(w.db, w.pk)).toEqual(theirs);
    w.tick(10);
    await drain(w.send);
    expect(w.log.some((e) => e.kind === 30078 && dOf(e) === savedD(theirs, h(1)))).toBe(true);
    const retired = w.log.find((e) => e.kind === 5);
    expect(retired?.tags).toContainEqual(['a', `30078:${w.pk}:${savedD(mine, h(1))}`]);
    expect(retired?.tags).not.toContainEqual(['a', `30078:${w.pk}:${savedD(theirs, h(1))}`]);
  });

  test('a save published before v1.10 moves to its keyed address, its unkeyed one retired', async () => {
    const w = world('new');
    w.item(1, ITEM_D_PREFIX + h(1));
    await drain(w.send);
    const key = libraryKey(w.db, w.pk)!;
    expect(w.db.get('SELECT remote_d FROM items WHERE hash = ?', h(1))).toEqual({ remote_d: savedD(key, h(1)) });
    expect(w.log.find((e) => e.kind === 5)?.tags).toContainEqual(['a', `30078:${w.pk}:${ITEM_D_PREFIX}${h(1)}`]);
  });

  test('a library from before v1.10 moves whole at the first sync that knows its key', async () => {
    const w = world('recovery_code');
    w.item(1, ITEM_D_PREFIX + h(1));
    w.item(2, ITEM_D_PREFIX + h(2));
    w.db.run("DELETE FROM outbox WHERE op = 'publish_item'");
    // no record anywhere and every relay answers: the key is made, and both saves are queued to move
    await syncLibraryKey(w.sync, w.pk);
    const key = libraryKey(w.db, w.pk)!;
    expect(w.db.all<{ subject: string }>("SELECT subject FROM outbox WHERE op = 'publish_item' ORDER BY subject").map((r) => r.subject)).toEqual([h(1), h(2)]);
    await drain(w.send);
    for (const n of [1, 2]) expect(w.db.get('SELECT remote_d FROM items WHERE hash = ?', h(n))).toEqual({ remote_d: savedD(key, h(n)) });
    // and nothing more to move at the next sync
    await syncLibraryKey(w.sync, w.pk);
    expect(w.db.get("SELECT 1 FROM outbox WHERE op = 'publish_item'")).toBeUndefined();
  });

  test('a newest record another client spoilt gives way to the one before it, so a restored phone still learns the key', async () => {
    const good = nodeCrypto.randomBytes(32);
    const record = async (w: ReturnType<typeof world>, json: string, at: number) =>
      w.s.signEvent({ kind: 30078, created_at: at, tags: [['d', LIBRARY_KEY_D], ['t', 'kefli']], content: await w.s.nip44Encrypt(w.pk, json) });
    for (const junk of ['{"v":1,"key":"zz"}', 'null', '[]', '{"key":"aa"}', 'not json']) {
      const w = world('recovery_code');
      await w.send.publish('ws://a', await buildLibraryKeyEvent(w.s, good, 800));
      await w.send.publish('ws://op', await record(w, junk, 900));
      await syncLibraryKey(w.sync, w.pk);
      expect(libraryKey(w.db, w.pk)).toEqual(good);
    }
    // a later version, which a newer Kefli wrote, stops it: nothing taken, nothing made over it
    const w = world('recovery_code');
    await w.send.publish('ws://a', await buildLibraryKeyEvent(w.s, good, 800));
    await w.send.publish('ws://op', await record(w, `{"v":2,"key":"${'a'.repeat(64)}"}`, 900));
    await syncLibraryKey(w.sync, w.pk);
    expect(libraryKey(w.db, w.pk)).toBeNull();
    expect(w.db.get("SELECT 1 FROM outbox WHERE op = 'publish_library_key'")).toBeUndefined();
  });

  test('a record dated decades ahead isn’t taken, and no key is made over it', async () => {
    const w = world('recovery_code');
    await w.send.publish('ws://op', await buildLibraryKeyEvent(w.s, nodeCrypto.randomBytes(32), 4_102_444_800));
    await syncLibraryKey(w.sync, w.pk);
    expect(libraryKey(w.db, w.pk)).toBeNull();
    expect(w.db.get("SELECT 1 FROM outbox WHERE op = 'publish_library_key'")).toBeUndefined();
  });

  test('a deletion finds a save by its keyed address, and one naming an address it has left takes nothing', async () => {
    const w = world('new');
    const key = makeLibraryKey(w.db, 900, w.pk, nodeCrypto.randomBytes);
    w.item(1, savedD(key, h(1)));
    w.item(2, savedD(key, h(2)));
    const [old] = await buildDeletions(w.s, [ITEM_D_PREFIX + h(1)], 600);
    expect(applyDeletion(w.db, w.pk, old)).toEqual([]);
    const [keyed] = await buildDeletions(w.s, [savedD(key, h(2))], 600);
    expect(applyDeletion(w.db, w.pk, keyed)).toEqual([h(2)]);
  });
});
