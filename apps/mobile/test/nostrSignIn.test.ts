import { LocalSigner, buildRelayList, buildServerList, itemHash, type NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, queueImported } from '../src/data/saves';
import { relayEntries, listServers } from '../src/data/lists';
import { checkSignIn, queueImport, readUserLists, settleUserLists, takeImport, type SignInPorts } from '../src/services/nostrSignIn';
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
    expect(absent).toEqual({ relays: null, servers: null, known: true });
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
    const w = await world({
      'ws://a': async (s) => [await s.signEvent({ kind: 10003, created_at: 1, tags: [['r', long], ['r', 'https://example.org/b']], content: '' })],
    });
    const c = await checkSignIn(w.p, w.s);
    expect(c.ok && c.links).toEqual(['https://example.org/b']);
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
