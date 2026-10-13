import { LocalSigner, buildRelayList, type NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { addRelay, recordList, relayAddress, relayEntries, relayRows, removeRelay, seedGeneratedLists, writeRelays } from '../src/data/lists';
import { begin, enqueue, finish } from '../src/data/outbox';
import { commitDelete, deleteItem } from '../src/data/library';
import { addTypedRelay, type AddRelayPorts } from '../src/services/addRelay';
import { drain, type SendPorts } from '../src/services/send';
import type { RelayAnswer } from '../src/net/pool';
import { memoryDb } from './sqlite';

const D = { operator: { relay: 'wss://op', blossom: 'https://blossom' }, relays: ['wss://a.example', 'wss://b.example'], indexer: ['wss://idx.example'], mirrors: ['https://m1'] };
const MINE = 'wss://relay.mine.example';

function world(provider: 'local' | 'nip55' = 'local') {
  const db = memoryDb();
  migrate(db);
  const s = new LocalSigner(nodeCrypto.randomBytes(32));
  ensureIdentityRow(db, 1, s.pubkey(), 'early_share', provider === 'local', provider);
  return { db, s, pk: s.pubkey() };
}

function item(db: ReturnType<typeof memoryDb>, owner: string, hash: string, published = true) {
  db.run(`INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, published, event_id)
    VALUES (?, ?, 'https://example.com', 1, 'unread', 'cached', 'share', ?, 'e')`, owner, hash, published ? 1 : 0);
}

const targets = (db: ReturnType<typeof memoryDb>, op: string, subject: string) =>
  db.all<{ target: string }>('SELECT t.target FROM outbox_targets t JOIN outbox o ON o.id = t.outbox_id WHERE o.op = ? AND o.subject = ? ORDER BY t.target', op, subject).map((r) => r.target);

describe('a typed relay address (FD 113)', () => {
  test.each([
    ['relay.mine.example', MINE],
    ['  WSS://Relay.Mine.Example/  ', MINE],
    ['wss://relay.mine.example:4443/nostr', 'wss://relay.mine.example:4443/nostr'],
    ['wss://localhost:7777', 'wss://localhost:7777'],
  ])('%s is %s', (typed, url) => expect(relayAddress(typed)).toBe(url));

  test.each(['', 'ws://relay.mine.example', 'https://relay.mine.example', 'wss://', 'relay', 'wss://user@relay.mine.example', 'wss://relay.mine.example/?x=1', 'wss://relay.mine.example/#x', 'two words.example'])(
    '%j is refused', (typed) => expect(relayAddress(typed)).toBeNull());
});

describe('adding a relay in Advanced (FD 113, C§3.1)', () => {
  test('it joins the 10002 for reading and writing, the lists go out again, and the library is copied, not re-signed', () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    recordList(w.db, w.pk, 10002, 'l', 1, '{}');
    item(w.db, w.pk, 'h1');
    item(w.db, w.pk, 'h2', false);
    expect(addRelay(w.db, 10, w.pk, MINE, D)).toBe(true);
    expect(relayEntries(w.db, w.pk).at(-1)).toEqual({ url: MINE, read: true, write: true });
    expect(targets(w.db, 'publish_lists', w.pk)).toEqual([...writeRelays(w.db, w.pk), ...D.indexer].sort());
    expect(targets(w.db, 'copy_relay', MINE)).toEqual([MINE]);
    expect(w.db.get<{ lane: string }>("SELECT lane FROM outbox WHERE op = 'copy_relay'")?.lane).toBe('bulk');
    // no save is published again from this phone's state (F16)
    expect(w.db.get("SELECT 1 FROM outbox WHERE op = 'publish_item'")).toBeUndefined();
  });

  test('changes waiting or sending keep their relays and gain the new one (F17)', () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    item(w.db, w.pk, 'h1');
    item(w.db, w.pk, 'h2');
    enqueue(w.db, 5, { op: 'publish_item', signer: w.pk, subject: 'h1', targets: writeRelays(w.db, w.pk) });
    const sending = enqueue(w.db, 5, { op: 'delete_item', signer: w.pk, subject: 'h2', targets: writeRelays(w.db, w.pk) });
    w.db.run("UPDATE outbox SET state = 'sending' WHERE id = ?", sending);
    addRelay(w.db, 10, w.pk, MINE, D);
    expect(targets(w.db, 'publish_item', 'h1')).toEqual([...D.relays, MINE, D.operator.relay].sort());
    expect(targets(w.db, 'delete_item', 'h2')).toContain(MINE);
  });

  test('a row it replaces comes back as it was when it is removed (F34)', () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    addRelay(w.db, 10, w.pk, D.indexer[0], D);
    expect(removeRelay(w.db, 20, w.pk, D.indexer[0])).toBe(true);
    expect(w.db.get('SELECT read, write, source, added_by_app, added_at, prior FROM relays WHERE url = ?', D.indexer[0]))
      .toEqual({ read: 0, write: 0, source: 'indexer', added_by_app: 1, added_at: null, prior: null });
  });

  test('before the first save, the default lists come first, so Kefli’s relays are still written to', () => {
    const w = world();
    addRelay(w.db, 10, w.pk, MINE, D);
    expect(writeRelays(w.db, w.pk)).toEqual([D.operator.relay, ...D.relays, MINE]);
    expect(targets(w.db, 'publish_lists', w.pk)).toEqual([]);
  });

  test('a relay already written to isn’t added twice; an indexer relay becomes a write relay', () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    expect(addRelay(w.db, 10, w.pk, D.relays[0], D)).toBe(false);
    expect(addRelay(w.db, 10, w.pk, D.indexer[0], D)).toBe(true);
    expect(writeRelays(w.db, w.pk)).toContain(D.indexer[0]);
  });
});

describe('removing a relay in Advanced (FD 113)', () => {
  test('only one the person added; the copy stops and the lists go out without it, to it too', () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    recordList(w.db, w.pk, 10002, 'l', 1, '{}');
    item(w.db, w.pk, 'h1');
    item(w.db, w.pk, 'h2');
    enqueue(w.db, 5, { op: 'publish_item', signer: w.pk, subject: 'h2', targets: [D.relays[0]] });
    addRelay(w.db, 10, w.pk, MINE, D);
    expect(relayRows(w.db, w.pk).map((r) => r.removable)).toEqual([false, false, false, true]);
    expect(removeRelay(w.db, 20, w.pk, D.relays[0])).toBe(false);
    expect(removeRelay(w.db, 20, w.pk, MINE)).toBe(true);
    expect(writeRelays(w.db, w.pk)).not.toContain(MINE);
    expect(targets(w.db, 'copy_relay', MINE)).toEqual([]);
    expect(targets(w.db, 'publish_item', 'h1')).toEqual([]);
    expect(targets(w.db, 'publish_item', 'h2')).toEqual([D.relays[0]]);
    expect(targets(w.db, 'publish_lists', w.pk)).toContain(MINE);
  });

  test('a nostr user’s own relays from their shared list aren’t removable here; one this phone added is', () => {
    const w = world('nip55');
    w.db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app) VALUES ('wss://theirs.example', ?, 1, 1, 'user', 0)", w.pk);
    w.db.run('UPDATE identities SET lists_settled = 1 WHERE pubkey = ?', w.pk);
    addRelay(w.db, 10, w.pk, MINE, D);
    expect(relayRows(w.db, w.pk)).toEqual([
      { url: 'wss://theirs.example', source: 'user', removable: false },
      { url: MINE, source: 'user', removable: true },
    ]);
  });
});

describe('sending what adding a relay queues (FD 113)', () => {
  type Q = { kinds: number[]; authors?: string[]; until?: number; since?: number; limit?: number };
  function ports(w: ReturnType<typeof world>, held: Record<string, NostrEvent[]>, down: string[] = []) {
    const sent: { url: string; event: NostrEvent }[] = [];
    let clock = 1000;
    const p: SendPorts = {
      db: w.db, now: () => clock, signer: async (pk) => (pk === w.pk ? w.s : null), fetch: (async () => new Response('{}')) as never,
      crypto: nodeCrypto, defaults: () => ({ v: 1, operator: { ...D.operator, api: 'https://api' }, relays: D.relays, indexer: D.indexer, mirrors: D.mirrors }),
      publish: async (url, event) => (sent.push({ url, event }), { ok: true }),
      readBlob: async () => null,
      query: async (url, filters) => {
        if (down.includes(url)) throw new Error('down');
        const f = filters[0] as Q;
        return (held[url] ?? []).filter((e) => f.kinds.includes(e.kind) && (!f.authors || f.authors.includes(e.pubkey)) && (f.until === undefined || e.created_at <= f.until))
          .sort((a, b) => b.created_at - a.created_at).slice(0, f.limit ?? Infinity);
      },
    };
    return { p, sent, setClock: (t: number) => (clock = t) };
  }
  const save = (w: ReturnType<typeof world>, hash: string, at: number, content: string) =>
    w.s.signEvent({ kind: 30078, created_at: at, tags: [['d', `kefli/item/${hash}`], ['t', 'kefli']], content });

  test('copies the newest signed copy of each save and every deletion, unchanged (F16, F35)', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    item(w.db, w.pk, 'h1');
    const old = await save(w, 'h1', 100, 'unread');
    const newer = await save(w, 'h1', 200, 'archived on another phone');
    const kind5 = await w.s.signEvent({ kind: 5, created_at: 150, tags: [['a', `30078:${w.pk}:kefli/item/h9`], ['k', '30078']], content: '' });
    const { p, sent } = ports(w, { [D.relays[0]]: [old, kind5], [D.relays[1]]: [newer] }, [D.operator.relay]);
    addRelay(w.db, 10, w.pk, MINE, D);
    await drain(p);
    expect(sent.filter((s) => s.url === MINE).map((s) => s.event.id).sort()).toEqual([newer.id, kind5.id].sort());
    expect(w.db.get("SELECT 1 FROM outbox WHERE op = 'copy_relay'")).toBeUndefined();
  });

  test('waits while no other relay answers', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    item(w.db, w.pk, 'h1');
    const { p, sent } = ports(w, {}, [D.operator.relay, ...D.relays]);
    addRelay(w.db, 10, w.pk, MINE, D);
    await drain(p);
    expect(sent).toEqual([]);
    expect(targets(w.db, 'copy_relay', MINE)).toEqual([MINE]);
  });

  test('lists are dated after those held, and an older copy never replaces a newer one (F36)', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    recordList(w.db, w.pk, 10002, 'newer', 5000, '{}');
    recordList(w.db, w.pk, 10002, 'older', 4000, '{}');
    expect(w.db.get('SELECT event_id FROM lists WHERE kind = 10002')).toEqual({ event_id: 'newer' });
    const { p, sent } = ports(w, {});
    addRelay(w.db, 10, w.pk, MINE, D);
    await drain(p);
    expect(sent.find((s) => s.event.kind === 10002)?.event.created_at).toBe(5001);
  });

  test('a deletion is dated after the newest version of the save it names (F36)', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    item(w.db, w.pk, 'h1');
    w.db.run("UPDATE items SET event_created_at = 2000 WHERE hash = 'h1'");
    const { p, sent } = ports(w, {});
    const { held } = deleteItem(w.db, 1000, w.pk, 'h1');
    commitDelete(w.db, w.pk, 'h1', held);
    await drain(p);
    expect(sent.find((s) => s.event.kind === 5)?.event.created_at).toBe(2001);
  });

  test('a change made while one was sending takes over the targets it hadn’t reached (F17)', () => {
    const w = world();
    const id = enqueue(w.db, 1, { op: 'publish_item', signer: w.pk, subject: 'h1', targets: ['wss://x.example', 'wss://y.example'] });
    begin(w.db, id);
    const next = enqueue(w.db, 2, { op: 'publish_item', signer: w.pk, subject: 'h1', targets: ['wss://x.example'] });
    finish(w.db, 3, id, [{ target: 'wss://x.example', kind: 'ok' }, { target: 'wss://y.example', kind: 'retry', error: 'timeout' }]);
    expect(w.db.get('SELECT 1 FROM outbox WHERE id = ?', id)).toBeUndefined();
    expect(targets(w.db, 'publish_item', 'h1')).toEqual(['wss://x.example', 'wss://y.example']);
    expect(next).not.toBe(id);
  });
});

describe('checking a typed relay (FD 113)', () => {
  function ports(w: ReturnType<typeof world>, o: { down?: boolean; answer?: RelayAnswer } = {}) {
    const sent: { url: string; event: NostrEvent }[] = [];
    const p: AddRelayPorts = {
      db: w.db, now: () => 10, defaults: async () => D,
      connect: async (url) => {
        if (o.down) throw new Error(`no answer from ${url}`);
      },
      publish: async (url, event) => (sent.push({ url, event }), o.answer ?? { ok: true }),
    };
    return { p, sent };
  }

  test('an address that isn’t one, or a relay already written to, is refused before anything is asked', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    const { p, sent } = ports(w);
    expect((await addTypedRelay(p, w.pk, 'https://x.example')).check).toBe('bad');
    expect((await addTypedRelay(p, w.pk, 'a.example')).check).toBe('listed');
    expect(sent).toEqual([]);
  });

  test('a relay that doesn’t answer, or won’t take the signed list, isn’t added', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    const list = await buildRelayList(w.s, relayEntries(w.db, w.pk), 5);
    recordList(w.db, w.pk, 10002, list.id, 5, JSON.stringify(list));
    expect((await addTypedRelay(ports(w, { down: true }).p, w.pk, MINE)).check).toBe('unreachable');
    const refusing = ports(w, { answer: { ok: false, reason: 'restricted: paid relay' } });
    expect((await addTypedRelay(refusing.p, w.pk, MINE)).check).toBe('refused');
    expect(refusing.sent[0].event.id).toBe(list.id);
    expect(writeRelays(w.db, w.pk)).not.toContain(MINE);
  });

  test('one that answers and takes the list is added', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    expect(await addTypedRelay(ports(w).p, w.pk, 'Relay.Mine.Example')).toEqual({ check: 'ok', url: MINE });
    expect(writeRelays(w.db, w.pk)).toContain(MINE);
  });
});
