import { LocalSigner, buildRelayList, buildServerList, itemHash, type NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, queueImported } from '../src/data/saves';
import { relayEntries, listServers, listsUnread, nextListTime } from '../src/data/lists';
import { checkSignIn, queueImport, readUserLists, settleUserLists, takeImport, type SignInPorts } from '../src/services/nostrSignIn';
import { drain } from '../src/services/send';
import { memoryDb } from './sqlite';

const D = { operator: { relay: 'ws://op', blossom: 'http://blossom' }, relays: ['ws://a', 'ws://b'], indexer: ['ws://idx'], mirrors: ['http://m1'] };
const T = { api: 'http://api', blossom: 'http://blossom', mirror: 'http://m1' };

async function world(held: Record<string, (s: LocalSigner) => Promise<NostrEvent[]>> = {}, down: string[] = []) {
  const s = new LocalSigner(nodeCrypto.randomBytes(32));
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, 1, s.pubkey(), 'nostr_signin', false, 'nip55');
  const events: Record<string, NostrEvent[]> = {};
  for (const [r, f] of Object.entries(held)) events[r] = await f(s);
  const p: SignInPorts = {
    db, now: () => 100, defaults: D,
    query: async (relay, filters) => {
      if (down.includes(relay)) throw new Error('down');
      return (events[relay] ?? []).filter((e) => filters[0].kinds.includes(e.kind));
    },
  };
  return { s, db, p };
}

describe('signing in with a nostr app (mobile spec 4.6, 5.3)', () => {
  test('their lists are kept, and Keep backup copies adds Kefli’s, so they are published', async () => {
    const w = await world({
      'ws://idx': async (s) => [await buildRelayList(s, [{ url: 'wss://mine', read: true, write: false }], 5), await buildServerList(s, ['https://my.blossom'], 5)],
    });
    const lists = await readUserLists(w.p, w.s.pubkey());
    expect(lists).toMatchObject({ known: true, relays: [{ url: 'wss://mine', read: true, write: false }], servers: ['https://my.blossom'] });
    expect(settleUserLists(w.db, 100, w.s.pubkey(), D, lists, true)).toBe(true);
    expect(relayEntries(w.db, w.s.pubkey())).toEqual([
      { url: 'wss://mine', read: true, write: false }, { url: 'ws://op', read: true, write: true }, { url: 'ws://a', read: true, write: true },
    ]);
    expect(listServers(w.db, w.s.pubkey())).toEqual(['https://my.blossom', 'http://blossom', 'http://m1']);
    expect(w.db.all("SELECT op FROM outbox")).toEqual([{ op: 'publish_lists' }]);
  });

  test('their lists as read are kept whole, so the first lists sent need no second read and lose no entry', async () => {
    // more relays and servers than Kefli uses, a marker no one reads and a tag that isn't an entry, as another app writes them
    const relays = [...Array.from({ length: 60 }, (_, i) => ['r', `wss://r${i}.example`]), ['r', 'wss://r60.example', 'outbox'], ['alt', 'relay list']];
    const servers = Array.from({ length: 55 }, (_, i) => ['server', `https://s${i}.example`]);
    const read: NostrEvent[] = [];
    const w = await world({
      'ws://idx': async (s) => {
        read.push(await s.signEvent({ kind: 10002, created_at: 5, tags: relays, content: '' }), await s.signEvent({ kind: 10063, created_at: 5, tags: servers, content: '' }));
        return read;
      },
    });
    const pk = w.s.pubkey();
    const c = await checkSignIn(w.p, w.s);
    if (!c.ok) throw new Error('the probe failed');
    expect(settleUserLists(w.db, 100, pk, D, c.lists, true)).toBe(true);
    expect(w.db.all('SELECT kind, event_id, created_at FROM lists WHERE owner = ? ORDER BY kind', pk))
      .toEqual(read.map((e) => ({ kind: e.kind, event_id: e.id, created_at: 5 })));
    expect(listsUnread(w.db, pk)).toBe(false);
    // the first publish, every relay down: their lists go whole, Kefli's own after them, dated after theirs
    const sent: NostrEvent[] = [];
    await drain({
      db: w.db, now: () => 200, signer: async () => w.s, fetch: (async () => new Response('{}')) as never, crypto: nodeCrypto,
      defaults: () => ({ v: 1, operator: { ...D.operator, api: 'http://api' }, relays: D.relays, indexer: D.indexer, mirrors: D.mirrors }),
      publish: async (_relay, e) => (sent.push(e), { ok: true }), readBlob: async () => null,
      query: async () => {
        throw new Error('down');
      },
    });
    const last = (kind: number) => sent.filter((e) => e.kind === kind).at(-1)!;
    expect(last(10002).tags).toEqual([...relays, ['r', D.operator.relay], ['r', D.relays[0]]]);
    expect(last(10063).tags).toEqual([...servers, ['server', D.operator.blossom], ['server', D.mirrors[0]]]);
    expect(last(10002).created_at).toBe(200);
  });

  test('a list of theirs dated more than a day ahead is read for its entries, never kept as the list held', async () => {
    // a device of theirs whose clock said 2100 once published it, and a relay that checks no dates kept it
    const AHEAD = 4_102_444_800;
    const w = await world({
      'ws://idx': async (s) => [await buildRelayList(s, [{ url: 'wss://mine', read: true, write: true }], AHEAD), await buildServerList(s, ['https://my.blossom'], AHEAD)],
    });
    const pk = w.s.pubkey();
    const lists = await readUserLists(w.p, pk);
    expect(settleUserLists(w.db, 100, pk, D, lists, true)).toBe(true);
    expect(relayEntries(w.db, pk).map((r) => r.url)).toEqual(['wss://mine', 'ws://op', 'ws://a']);
    expect(listServers(w.db, pk)).toEqual(['https://my.blossom', 'http://blossom', 'http://m1']);
    // kept as held, it dated every list sent from here after 2100, which every relay that checks dates refuses, and no
    // list another app sent later could ever be newer (sync's read leaves such a copy to wait for its time)
    expect(w.db.all('SELECT kind, created_at FROM lists WHERE owner = ?', pk)).toEqual([]);
    expect(nextListTime(w.db, pk, 100)).toBe(100);
    // one dated within the day is the list held, as any other
    const near = await world({ 'ws://idx': async (s) => [await buildRelayList(s, [{ url: 'wss://mine', read: true, write: true }], 100 + 86_400)] });
    settleUserLists(near.db, 100, near.s.pubkey(), D, await readUserLists(near.p, near.s.pubkey()), true);
    expect(near.db.all('SELECT kind, created_at FROM lists')).toEqual([{ kind: 10002, created_at: 100 + 86_400 }]);
  });

  test('with the switch off, their lists are only read, never rewritten', async () => {
    const w = await world({
      'ws://a': async (s) => [await buildRelayList(s, [{ url: 'wss://mine', read: true, write: true }], 5), await buildServerList(s, ['https://my.blossom'], 5)],
    });
    settleUserLists(w.db, 100, w.s.pubkey(), D, await readUserLists(w.p, w.s.pubkey()), false);
    expect(relayEntries(w.db, w.s.pubkey()).map((r) => r.url)).toEqual(['wss://mine']);
    expect(w.db.all('SELECT op FROM outbox')).toEqual([]);
  });

  test('no list: absent only once the indexer and two default relays answered; then the default set', async () => {
    const quiet = await world({}, ['ws://b']);
    const unknown = await readUserLists(quiet.p, quiet.s.pubkey());
    expect(unknown.known).toBe(false);
    expect(settleUserLists(quiet.db, 100, quiet.s.pubkey(), D, unknown, true)).toBe(false);
    expect(relayEntries(quiet.db, quiet.s.pubkey())).toEqual([]);
    const w = await world();
    const absent = await readUserLists(w.p, w.s.pubkey());
    expect(absent).toEqual({ relays: null, servers: null, known: true, relayList: null, serverList: null });
    settleUserLists(w.db, 100, w.s.pubkey(), D, absent, false);
    expect(relayEntries(w.db, w.s.pubkey()).map((r) => r.url)).toEqual(['ws://op', 'ws://a', 'ws://b']);
    expect(w.db.all('SELECT op FROM outbox')).toEqual([{ op: 'publish_lists' }]);
  });

  test('the probe refuses a signer that can’t keep saves private; bookmarks are counted; imports join as pending saves', async () => {
    const w = await world({
      'ws://idx': async (s) => [await s.signEvent({ kind: 39701, created_at: 1, tags: [['d', 'example.com/a']], content: '' })],
      'ws://a': async (s) => [await s.signEvent({ kind: 10003, created_at: 1, tags: [['r', 'https://example.org/b']], content: '' })],
    });
    const bad = { pubkey: () => w.s.pubkey(), nip44Encrypt: async () => 'x', nip44Decrypt: async () => 'y' } as never;
    expect(await checkSignIn(w.p, bad)).toEqual({ ok: false, why: 'probe' });
    const c = await checkSignIn(w.p, w.s);
    expect(c.ok && [...c.links].sort()).toEqual(['https://example.com/a', 'https://example.org/b']);
    queueImport(w.db, 50, w.s.pubkey(), ['https://example.com/a', 'https://example.org/b', 'not a link']);
    const job = takeImport(w.db, w.s.pubkey())!;
    expect(takeImport(w.db, w.s.pubkey())).toBeNull();
    expect(queueImported(w.db, w.s.pubkey(), job.links, job.at, T)).toBe(2);
    expect(w.db.all('SELECT hash, text_state, saved_at, origin FROM items ORDER BY id')).toEqual([
      { hash: itemHash('https://example.com/a'), text_state: 'queued', saved_at: 50, origin: 'import' },
      { hash: itemHash('https://example.org/b'), text_state: 'queued', saved_at: 50, origin: 'import' },
    ]);
    expect(queueImported(w.db, w.s.pubkey(), job.links, job.at, T)).toBe(0);
  });

  test('a bookmark normalise refuses is passed over, not thrown at the sign-in every time', async () => {
    const long = `https://${'a'.repeat(2000)}.example/x`;
    // and one too long for its save's event (C§3.3), which could never be published: not counted, not brought in
    const tooLong = `https://example.net/?q=${'x'.repeat(10_000)}`;
    const w = await world({
      'ws://a': async (s) => [await s.signEvent({ kind: 10003, created_at: 1, tags: [['r', long], ['r', tooLong], ['r', 'https://example.org/b']], content: '' })],
    });
    const c = await checkSignIn(w.p, w.s);
    expect(c.ok && c.links).toEqual(['https://example.org/b']);
    expect(queueImported(w.db, w.s.pubkey(), [tooLong, long], 50, T)).toBe(0);
    // the phone's URL (Expo's, with no Unicode step) takes a host with a joiner, which normalise refuses (CheckJoiners)
    const real = globalThis.URL;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    globalThis.URL = require('whatwg-url-minimum').URL;
    try {
      const phone = await world({
        'ws://a': async (s) => [await s.signEvent({ kind: 10003, created_at: 1, tags: [['r', 'https://a‍b.example/'], ['r', 'https://example.org/b']], content: '' })],
      });
      const p = await checkSignIn(phone.p, phone.s);
      expect(p.ok && p.links).toEqual(['https://example.org/b']);
    } finally {
      globalThis.URL = real;
    }
  });

  test('an import is one transaction, not a commit for each link', async () => {
    const w = await world();
    let begins = 0;
    const exec = w.db.exec.bind(w.db);
    w.db.exec = (sql: string) => {
      if (/^BEGIN/.test(sql)) begins++;
      exec(sql);
    };
    const links = Array.from({ length: 500 }, (_, i) => `https://example.com/p/${i}`);
    expect(queueImported(w.db, w.s.pubkey(), links, 50, T)).toBe(500);
    expect(begins).toBe(1);
    expect(w.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM items WHERE origin = 'import'")!.n).toBe(500);
  });
});
