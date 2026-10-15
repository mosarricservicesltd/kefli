// The 10002 and 10063 Kefli republishes for a nostr user (C§3.1, FD 76, FD 113): their lists as held, entry for entry,
// with Kefli's own changes; LIST_MAX bounds only what Kefli itself uses.
import { LIST_MAX, LocalSigner, readRelayList, readServerList, relayTags, type NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { addRelay, listEdits, listServers, recordList, relayEntries, relayListTags, removeRelay, serverListTags, writeRelays } from '../src/data/lists';
import { settleUserLists } from '../src/services/nostrSignIn';
import { takeNewerLists } from '../src/services/sync';
import { drain, type SendPorts } from '../src/services/send';
import { memoryDb } from './sqlite';

const D = { operator: { relay: 'wss://op.example', blossom: 'https://blossom.example' }, relays: ['wss://a.example', 'wss://b.example'], indexer: ['wss://idx.example'], mirrors: ['https://m1.example'] };
const MINE = 'wss://relay.mine.example';

/** Their 10002: 60 relays, some read or write only, one with a marker no one reads, and entries Kefli doesn't use. */
const THEIR_RELAYS: string[][] = [
  ...Array.from({ length: 60 }, (_, i) => (i % 7 === 3 ? ['r', `wss://r${i}.example`, 'read'] : i % 11 === 5 ? ['r', `wss://r${i}.example`, 'write'] : ['r', `wss://r${i}.example`])),
  ['r', 'wss://r61.example', 'outbox'],
  ['r', 'https://not-a-relay.example'],
  ['r', 'wss://r1.example/'],
  ['alt', 'relay list'],
];
const THEIR_SERVERS: string[][] = [...Array.from({ length: 55 }, (_, i) => ['server', `https://s${i}.example`]), ['server', 'ftp://old.example']];

async function world() {
  const db = memoryDb();
  migrate(db);
  const s = new LocalSigner(nodeCrypto.randomBytes(32));
  const pk = s.pubkey();
  ensureIdentityRow(db, 1, pk, 'nostr_signin', false, 'nip55');
  const relayList = await s.signEvent({ kind: 10002, created_at: 500, tags: THEIR_RELAYS, content: '' });
  const serverList = await s.signEvent({ kind: 10063, created_at: 500, tags: THEIR_SERVERS, content: '' });
  // on the relays, as their other apps left them
  const onRelays: NostrEvent[] = [relayList, serverList];
  let down: boolean | string[] = false;
  let clock = 1000;
  const sent: { relay: string; event: NostrEvent }[] = [];
  const p: SendPorts = {
    db, now: () => clock, signer: async (k) => (k === pk ? s : null), fetch: (async () => new Response('{}')) as never, crypto: nodeCrypto,
    defaults: () => ({ v: 1, operator: { ...D.operator, api: 'https://api.example' }, relays: D.relays, indexer: D.indexer, mirrors: D.mirrors }),
    publish: async (relay, event) => (sent.push({ relay, event }), { ok: true }),
    readBlob: async () => null,
    query: async (relay, filters) => {
      if (down === true || (Array.isArray(down) && down.includes(relay))) throw new Error('unreachable');
      return onRelays.filter((e) => filters.some((f) => f.kinds.includes(e.kind)));
    },
  };
  /** Sign-in with Keep backup copies on: their lists, as read, kept with Kefli's relay, backup, server and mirror. */
  const signIn = () => settleUserLists(db, 900, pk, D, { relays: readRelayList(relayList), servers: readServerList(serverList), known: true }, true);
  const newest = (kind: number) => sent.filter((x) => x.event.kind === kind).at(-1)?.event;
  return {
    db, s, pk, p, sent, newest, signIn, onRelays, relayList, serverList,
    setDown: (d: boolean | string[]) => (down = d), tick: (n: number) => (clock += n),
  };
}

describe('a nostr user’s lists as Kefli republishes them (C§3.1)', () => {
  test('a list of more than LIST_MAX relays, and entries Kefli doesn’t use, goes out whole, Kefli’s own after them', async () => {
    const w = await world();
    expect(w.signIn()).toBe(true);
    await drain(w.p);
    expect(w.newest(10002)!.tags).toEqual([...THEIR_RELAYS, ['r', D.operator.relay], ['r', D.relays[0]]]);
    expect(w.newest(10063)!.tags).toEqual([...THEIR_SERVERS, ['server', D.operator.blossom], ['server', D.mirrors[0]]]);
    // what Kefli itself uses stays bounded
    expect(writeRelays(w.db, w.pk).length).toBeLessThanOrEqual(LIST_MAX + 2);
    expect(listServers(w.db, w.pk).length).toBeLessThanOrEqual(LIST_MAX + 2);
    // and it goes out to every relay Kefli writes to, the indexer and nowhere else
    expect(new Set(w.sent.filter((x) => x.event.kind === 10002).map((x) => x.relay))).toEqual(new Set([...writeRelays(w.db, w.pk), ...D.indexer]));
  });

  test.each([true, false])('a 10002 and no 10063, as most nostr users have (Keep backup copies %s): their 10002 as held, the default 10063', async (keep) => {
    const w = await world();
    // their list names two of Kefli's default relays, one only to read from and one only to write to
    const theirs = [['r', 'wss://mine.example'], ['r', D.relays[1], 'read'], ['r', D.relays[0], 'write']];
    const list = await w.s.signEvent({ kind: 10002, created_at: 500, tags: theirs, content: '' });
    w.onRelays.splice(0, w.onRelays.length, list);
    expect(settleUserLists(w.db, 900, w.pk, D, { relays: readRelayList(list), servers: null, known: true }, keep)).toBe(true);
    await drain(w.p);
    // every entry of theirs in its place with its marker; Kefli's relay after them only with the switch on, and no
    // other default relay (C§3.1)
    expect(w.newest(10002)!.tags).toEqual(keep ? [...theirs, ['r', D.operator.relay]] : theirs);
    expect(w.newest(10063)!.tags).toEqual([['server', D.operator.blossom], ['server', D.mirrors[0]]]);
    // with the switch off Kefli writes only to their write relays
    expect(writeRelays(w.db, w.pk)).toEqual(keep ? ['wss://mine.example', D.relays[0], D.operator.relay] : ['wss://mine.example', D.relays[0]]);
  });

  test('their list not read since sign-in waits for a read: none is sent from the tables alone', async () => {
    const w = await world();
    w.signIn();
    w.setDown(true);
    await drain(w.p);
    expect(w.sent).toEqual([]);
    expect(w.db.get("SELECT o.state, t.last_error FROM outbox o JOIN outbox_targets t ON t.outbox_id = o.id WHERE o.op = 'publish_lists' LIMIT 1"))
      .toEqual({ state: 'queued', last_error: 'their lists not read yet' });
    // the relays answer later: the list goes whole
    w.setDown(false);
    w.tick(3600);
    await drain(w.p);
    expect(w.newest(10002)!.tags).toEqual([...THEIR_RELAYS, ['r', D.operator.relay], ['r', D.relays[0]]]);
  });

  test('their list gone from every relay since sign-in, confirmed absent, leaves the tables as the list; one relay down, it waits', async () => {
    const w = await world();
    w.signIn();
    w.onRelays.splice(0);
    // the indexer and only one default relay answer: not confirmed absent, so nothing goes
    w.setDown([D.relays[1]]);
    await drain(w.p);
    expect(w.newest(10002)).toBeUndefined();
    // the indexer and two default relays answer without it (C§3.1): the tables are all there is of their list
    w.setDown(false);
    w.tick(3600);
    await drain(w.p);
    expect(w.newest(10002)!.tags).toEqual(relayTags(relayEntries(w.db, w.pk)));
    expect(w.newest(10063)!.tags).toEqual(listServers(w.db, w.pk).map((u) => ['server', u]));
  });

  test('a relay added in Advanced and then removed goes from the list though it sat past LIST_MAX; theirs stay', async () => {
    const w = await world();
    w.signIn();
    await drain(w.p);
    addRelay(w.db, w.p.now(), w.pk, MINE, D);
    w.tick(10);
    await drain(w.p);
    expect(w.newest(10002)!.tags).toEqual([...THEIR_RELAYS, ['r', D.operator.relay], ['r', D.relays[0]], ['r', MINE]]);
    removeRelay(w.db, w.p.now(), w.pk, MINE);
    w.tick(10);
    await drain(w.p);
    expect(w.newest(10002)!.tags).toEqual([...THEIR_RELAYS, ['r', D.operator.relay], ['r', D.relays[0]]]);
    // the edit went out, so the list is all there is to it
    expect(listEdits(w.db, w.pk)).toEqual([]);
  });

  test('a read-only relay of theirs made a write relay in Advanced goes out so, and back as it was once removed', async () => {
    const w = await world();
    w.signIn();
    await drain(w.p);
    const theirs = 'wss://r3.example';
    addRelay(w.db, w.p.now(), w.pk, theirs, D);
    w.tick(10);
    await drain(w.p);
    expect(w.newest(10002)!.tags.filter((t) => t[1] === theirs)).toEqual([['r', theirs]]);
    removeRelay(w.db, w.p.now(), w.pk, theirs);
    w.tick(10);
    await drain(w.p);
    expect(w.newest(10002)!.tags).toEqual([...THEIR_RELAYS, ['r', D.operator.relay], ['r', D.relays[0]]]);
  });

  test('a relay removed here stays out though a newer list from elsewhere, made before it went, still names it', async () => {
    const w = await world();
    w.signIn();
    await drain(w.p);
    addRelay(w.db, w.p.now(), w.pk, MINE, D);
    w.tick(10);
    await drain(w.p);
    // another app's list, made from the one with MINE, adding its own relay
    const elsewhere = await w.s.signEvent({ kind: 10002, created_at: 1500, tags: [...w.newest(10002)!.tags, ['r', 'wss://theirs-new.example']], content: '' });
    w.onRelays.push(elsewhere);
    removeRelay(w.db, w.p.now(), w.pk, MINE);
    w.tick(1000);
    await drain(w.p);
    const urls = w.newest(10002)!.tags.map((t) => t[1]);
    expect(urls).toContain('wss://theirs-new.example');
    expect(urls).not.toContain(MINE);
  });

  test('a list on a relay dated a year ahead waits for its time: the list sent is the one held, dated by this phone', async () => {
    const w = await world();
    w.signIn();
    await drain(w.p);
    const ahead = await w.s.signEvent({ kind: 10002, created_at: w.p.now() + 365 * 86_400, tags: [['r', 'wss://ahead.example']], content: '' });
    w.onRelays.push(ahead);
    addRelay(w.db, w.p.now(), w.pk, MINE, D);
    w.tick(10);
    await drain(w.p);
    const sent = w.newest(10002)!;
    expect(sent.tags).toEqual([...THEIR_RELAYS, ['r', D.operator.relay], ['r', D.relays[0]], ['r', MINE]]);
    expect(sent.created_at).toBeLessThan(w.p.now() + 86_400);
  });

  test('a relay another app lists that Kefli holds only as an indexer stays in the list', async () => {
    const w = await world();
    w.signIn();
    await drain(w.p);
    const elsewhere = await w.s.signEvent({ kind: 10002, created_at: 1500, tags: [...w.newest(10002)!.tags, ['r', D.indexer[0]]], content: '' });
    takeNewerLists(w.db, w.pk, [elsewhere], [10002]);
    addRelay(w.db, w.p.now(), w.pk, MINE, D);
    w.tick(1000);
    await drain(w.p);
    expect(w.newest(10002)!.tags.slice(-2)).toEqual([['r', D.indexer[0]], ['r', MINE]]);
  });

  test('a list too long for one event is left as it is held; the 10063 still goes, and nothing waits', async () => {
    const w = await world();
    const huge = await w.s.signEvent({ kind: 10002, created_at: 600, tags: Array.from({ length: 1000 }, (_, i) => ['r', `wss://relay-number-${i}.example`]), content: '' });
    w.onRelays.splice(0, 1, huge);
    settleUserLists(w.db, 900, w.pk, D, { relays: readRelayList(huge), servers: readServerList(w.serverList), known: true }, true);
    await drain(w.p);
    expect(w.newest(10002)).toBeUndefined();
    expect(w.newest(10063)!.tags).toEqual([...THEIR_SERVERS, ['server', D.operator.blossom], ['server', D.mirrors[0]]]);
    expect(w.db.get("SELECT 1 AS n FROM outbox WHERE op = 'publish_lists'")).toBeUndefined();
    // Kefli still writes to its own relays, from its tables
    expect(writeRelays(w.db, w.pk)).toEqual(expect.arrayContaining([D.operator.relay, D.relays[0]]));
  });

  test('a list held that doesn’t read counts as unread: nothing goes until a read brings one', async () => {
    const w = await world();
    recordList(w.db, w.pk, 10002, 'x', 1, '{not json');
    w.signIn();
    w.setDown(true);
    await drain(w.p);
    expect(w.newest(10002)).toBeUndefined();
    w.setDown(false);
    w.tick(3600);
    await drain(w.p);
    expect(w.newest(10002)!.tags).toEqual([...THEIR_RELAYS, ['r', D.operator.relay], ['r', D.relays[0]]]);
  });

  test('a held list whose address ends in a long run of slashes is read in linear time, its tags as they were', () => {
    const w = { db: memoryDb(), pk: 'ef'.repeat(32) };
    migrate(w.db);
    ensureIdentityRow(w.db, 1, w.pk, 'nostr_signin', false, 'nip55');
    // a relay that keeps 64 KB events can hold one tag that is nearly all slashes; the regex /\/+$/ backtracks through
    // the run from every slash in it, 10 s on Node for 50,000, at every list sent
    const slashes = `wss://x.example/${'/'.repeat(60_000)}y`;
    recordList(w.db, w.pk, 10002, 'r', 1, JSON.stringify({ tags: [['r', slashes], ['r', 'wss://ok.example/']] }));
    recordList(w.db, w.pk, 10063, 's', 1, JSON.stringify({ tags: [['server', slashes.replace('wss', 'https')]] }));
    const started = Date.now();
    expect(relayListTags(w.db, w.pk)).toEqual([['r', slashes], ['r', 'wss://ok.example/']]);
    expect(serverListTags(w.db, w.pk)).toEqual([['server', slashes.replace('wss', 'https')]]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
