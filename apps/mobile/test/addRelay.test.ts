import { LocalSigner, buildRelayList, buildServerList, readRelayList, readServerList, type NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { addRelay, listServers, recordList, relayAddress, relayEntries, relayRows, removeRelay, seedGeneratedLists, writeRelays } from '../src/data/lists';
import { begin, enqueue, finish } from '../src/data/outbox';
import { commitDelete, deleteItem } from '../src/data/library';
import { addTypedRelay, type AddRelayPorts } from '../src/services/addRelay';
import { drain, relayResult, type SendPorts } from '../src/services/send';
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
  db.run(`INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, published, event_id, remote_d)
    VALUES (?, ?, 'https://example.com', 1, 'unread', 'cached', 'share', ?, 'e', ?)`, owner, hash, published ? 1 : 0, published ? `kefli/item/${hash}` : null);
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

  test('a save dated ahead of the added relay’s clock keeps no other from it: the rest go now, it once its time comes', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    item(w.db, w.pk, 'h1');
    // signed on a phone running 20 minutes fast, and on one a year ahead
    const ahead = await save(w, 'h1', 1000 + 1200, 'archived while fast');
    const far = await save(w, 'h2', 1000 + 365 * 86_400, 'a clock a year ahead');
    const rest = await Promise.all(['h3', 'h4'].map((h, i) => save(w, h, 500 + i, 'unread')));
    const { p, sent, setClock } = ports(w, { [D.relays[0]]: [far, ahead, ...rest] });
    // the added relay is strfry, which takes an event dated no more than 15 minutes past its own clock
    let relayClock = 1000;
    p.publish = async (url, event) => {
      if (url === MINE && event.created_at > relayClock + 900) return { ok: false, reason: 'invalid: created_at too late' };
      sent.push({ url, event });
      return { ok: true };
    };
    addRelay(w.db, 10, w.pk, MINE, D);
    await drain(p);
    const copied = () => sent.filter((s) => s.url === MINE && s.event.kind === 30078).map((s) => s.event.id);
    expect(copied().sort()).toEqual(rest.map((e) => e.id).sort());
    expect(w.db.get("SELECT t.next_at FROM outbox o JOIN outbox_targets t ON t.outbox_id = o.id WHERE o.op = 'copy_relay'")).toEqual({ next_at: 1000 + 1200 });
    // its time comes: it goes too, and the copy is done; the one a year ahead is passed over
    setClock(1000 + 1200);
    relayClock = 1000 + 1200;
    await drain(p);
    expect(copied()).toContain(ahead.id);
    expect(copied()).not.toContain(far.id);
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

  // the relays' words for an event dated past their clock, as send.ts relayResult reads them: strfry's, khatru's and
  // nostr-rs-relay's, which it sends only for a date ahead
  const AHEAD = [
    'invalid: created_at too late', 'blocked: event too much in the future',
    'invalid: The event created_at field is out of the acceptable range (+900sec) for this relay.',
  ];

  test('a relay that turns the list away only as dated ahead of its clock answered: it is added, and the list goes to it once the clock allows', async () => {
    for (const reason of AHEAD) {
      const w = world();
      seedGeneratedLists(w.db, w.pk, D);
      // the newest list held, dated by a clock running fast, or after a list another device dated so
      const list = await buildRelayList(w.s, relayEntries(w.db, w.pk), 10 + 3_600);
      recordList(w.db, w.pk, 10002, list.id, list.created_at, JSON.stringify(list));
      const r = ports(w, { answer: { ok: false, reason } });
      expect([reason, await addTypedRelay(r.p, w.pk, MINE)]).toEqual([reason, { check: 'ok', url: MINE }]);
      expect(writeRelays(w.db, w.pk)).toContain(MINE);
      expect(targets(w.db, 'publish_lists', w.pk)).toContain(MINE);
      // the send reads the same words as the clock's, and tries the list again with the backoff (send.ts relayResult)
      expect(relayResult(MINE, { ok: false, reason }, list.id).kind).toBe('retry');
    }
  });

  test('a relay that already holds the list took it before; one that finds it too old, or refuses it otherwise, isn’t added', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    const list = await buildRelayList(w.s, relayEntries(w.db, w.pk), 5);
    recordList(w.db, w.pk, 10002, list.id, 5, JSON.stringify(list));
    const duplicate = { ok: false as const, reason: 'duplicate: have this event' };
    expect(await addTypedRelay(ports(w, { answer: duplicate }).p, w.pk, MINE)).toEqual({ check: 'ok', url: MINE });
    expect(relayResult(MINE, duplicate, list.id).kind).toBe('ok');
    for (const reason of ['invalid: created_at too early', 'restricted: not on the allow list', 'pow: difficulty 28 is required', 'blocked: you are banned']) {
      const v = world();
      seedGeneratedLists(v.db, v.pk, D);
      recordList(v.db, v.pk, 10002, list.id, 5, JSON.stringify(list));
      expect([reason, (await addTypedRelay(ports(v, { answer: { ok: false, reason } }).p, v.pk, MINE)).check]).toEqual([reason, 'refused']);
      expect(writeRelays(v.db, v.pk)).not.toContain(MINE);
      expect(relayResult(MINE, { ok: false, reason }, list.id).kind).toBe('rejected');
    }
  });
});

describe('the lists sent after another app published its own (F37)', () => {
  const THEIRS = 'wss://theirs.example';
  const THEIR_SERVER = 'https://their.server.example';

  /** The phone's lists as published at 100, and another app's at 200 built on them with what it adds. */
  async function lists(w: ReturnType<typeof world>, add: { relay?: string; server?: string }) {
    const ours = await buildRelayList(w.s, relayEntries(w.db, w.pk), 100);
    recordList(w.db, w.pk, 10002, ours.id, 100, JSON.stringify(ours));
    const ourServers = await buildServerList(w.s, listServers(w.db, w.pk), 100);
    recordList(w.db, w.pk, 10063, ourServers.id, 100, JSON.stringify(ourServers));
    const theirs = await buildRelayList(w.s, [...readRelayList(ours), ...(add.relay ? [{ url: add.relay, read: true, write: true }] : [])], 200);
    const theirServers = await buildServerList(w.s, [...readServerList(ourServers), ...(add.server ? [add.server] : [])], 200);
    return [theirs, theirServers];
  }

  function send(w: ReturnType<typeof world>, onRelays: NostrEvent[] | 'down') {
    const sent: { relay: string; event: NostrEvent }[] = [];
    const p: SendPorts = {
      db: w.db, now: () => 300, signer: async () => w.s, fetch: (async () => new Response(null, { status: 500 })) as never, crypto: nodeCrypto, defaults: () => D as never,
      publish: async (relay, event): Promise<RelayAnswer> => (sent.push({ relay, event }), { ok: true }),
      readBlob: async () => null,
      query: async (_relay, filters) => {
        if (onRelays === 'down') throw new Error('unreachable');
        return onRelays.filter((e) => filters.some((f) => f.kinds?.includes(e.kind)));
      },
    };
    const newest = (kind: number) => sent.filter((s) => s.event.kind === kind).at(-1)?.event;
    return { p, sent, newest };
  }

  test('a relay and a server another app added since the last sync are kept in the lists sent from here', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    const elsewhere = await lists(w, { relay: THEIRS, server: THEIR_SERVER });
    addRelay(w.db, 250, w.pk, MINE, D);
    const s = send(w, elsewhere);
    await drain(s.p);
    const relays = readRelayList(s.newest(10002)!).map((e) => e.url);
    expect(relays).toEqual(expect.arrayContaining([THEIRS, MINE]));
    expect(readServerList(s.newest(10063)!)).toContain(THEIR_SERVER);
    expect(s.newest(10002)!.created_at).toBeGreaterThan(200);
  });

  test('a relay removed here stays removed, though the newer list from elsewhere still names it', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    addRelay(w.db, 50, w.pk, MINE, D);
    w.db.run('DELETE FROM outbox');
    const elsewhere = await lists(w, { relay: THEIRS });
    expect(readRelayList(elsewhere[0]).map((e) => e.url)).toContain(MINE);
    removeRelay(w.db, 250, w.pk, MINE);
    const s = send(w, elsewhere);
    await drain(s.p);
    const relays = readRelayList(s.newest(10002)!).map((e) => e.url);
    expect(relays).toContain(THEIRS);
    expect(relays).not.toContain(MINE);
  });

  test('relays that don’t answer the read leave the lists as the tables hold them', async () => {
    const w = world();
    seedGeneratedLists(w.db, w.pk, D);
    await lists(w, {});
    addRelay(w.db, 250, w.pk, MINE, D);
    const s = send(w, 'down');
    await drain(s.p);
    expect(readRelayList(s.newest(10002)!).map((e) => e.url)).toEqual(relayEntries(w.db, w.pk).map((e) => e.url));
  });
});
