// A share's save (mobile spec 5.4, contract 4.1): two shares of one link at once, as two sheets or the start-up pickup
// and a sheet run them, must agree on which one made the save, so the second's Undo never takes the first's away.
import { LocalSigner, buildItemEvent, itemHash } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import type { SqlDb } from '../src/data/db';
import { getItem, itemJson } from '../src/data/items';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, undoSave } from '../src/data/saves';
import type { PagePorts } from '../src/services/page';
import { memoryDb } from './sqlite';

const mockWorld = {} as { db: SqlDb; page: PagePorts; signer: LocalSigner };
const mockDefaults = {
  v: 1, operator: { relay: 'wss://op.example', blossom: 'https://blossom.example', api: 'https://api.example' },
  relays: ['wss://a.example', 'wss://b.example'], indexer: ['wss://idx.example'], mirrors: ['https://m1.example'],
};

jest.mock('../src/services/pagePorts', () => ({ phonePagePorts: () => mockWorld.page }));
jest.mock('../src/crypto/port', () => ({ phoneCrypto: jest.requireActual('@kefli/protocol/node').nodeCrypto }));
jest.mock('../src/services/config', () => ({ loadDefaults: async () => mockDefaults }));
jest.mock('../src/services/identity', () => ({ ensureSigner: async () => mockWorld.signer }));
jest.mock('../src/services/staging', () => ({ stageBlob: (sha: string) => `/staged/${sha}` }));
jest.mock('../src/services/textFiles', () => ({ textFiles: { writeText: () => undefined } }));
jest.mock('../src/services/store', () => ({ store: () => mockWorld.db }));
const mockSpools = new Map<string, string>();
jest.mock('expo-modules-core', () => ({
  requireNativeModule: () => ({
    readSpool: (id: string) => mockSpools.get(id) ?? null,
    deleteSpool: (id: string) => mockSpools.delete(id),
    listSpools: () => [...mockSpools.keys()],
    finish: () => true,
  }),
}), { virtual: true });

// eslint-disable-next-line import/first
import * as http from '../src/net/http';
// eslint-disable-next-line import/first
import { saveLater, saveLink } from '../src/services/save';
// eslint-disable-next-line import/first
import { pickUpSpools } from '../src/share/pickup';

const URL_A = 'https://news.example/story';
const WORDS = `${Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ')}\n`;

/** A page whose fetch waits until open() is called, so two shares can both be fetching it at once. */
function gatedPage(readable: boolean): { page: PagePorts; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const page: PagePorts = {
    fetch: (async (url: string) => {
      await gate;
      const res = readable
        ? new Response('<article><p>x</p></article>', { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as never,
    parse: async () => ({ ok: true, title: 'A story', byline: null, site: 'News', lang: 'en', hero: null, canonical: null, readerable: true, markdown: WORDS }),
  };
  return { page, open };
}

function setUp(): string {
  mockWorld.db = memoryDb();
  migrate(mockWorld.db);
  mockWorld.signer = new LocalSigner(nodeCrypto.randomBytes(32));
  const owner = mockWorld.signer.pubkey();
  ensureIdentityRow(mockWorld.db, 1, owner, 'new', true);
  return owner;
}

async function twice(readable: boolean) {
  const owner = setUp();
  const { page, open } = gatedPage(readable);
  mockWorld.page = page;
  const a = saveLink(URL_A, () => undefined);
  const b = saveLink(URL_A, () => undefined);
  await new Promise((r) => setTimeout(r, 20));
  open();
  const [first, second] = await Promise.all([a, b]);
  return { owner, first, second };
}

describe('two shares of one link at once (G2, FD 89)', () => {
  test('a page that can’t be read: the second is a repeat, and its Undo leaves the first', async () => {
    const { owner, first, second } = await twice(false);
    expect(first).toMatchObject({ kind: 'saved', prior: null });
    expect(first.held.length).toBeGreaterThan(0);
    expect(second).toMatchObject({ kind: 'again', held: [], prior: { state: 'unread' } });
    undoSave(mockWorld.db, owner, second.hash!, second.held, second.prior);
    expect(mockWorld.db.all('SELECT url, text_state FROM items')).toEqual([{ url: URL_A, text_state: 'failed' }]);
    expect(mockWorld.db.all("SELECT op FROM outbox WHERE state = 'held'")).toEqual([{ op: 'publish_item' }]);
  });

  test('a page that parses: the second is a repeat, and its Undo leaves the first, its text and its sends', async () => {
    const { owner, first, second } = await twice(true);
    expect(first).toMatchObject({ kind: 'saved', prior: null, title: 'A story' });
    expect(second).toMatchObject({ kind: 'again', held: [], prior: { state: 'unread' } });
    undoSave(mockWorld.db, owner, second.hash!, second.held, second.prior);
    expect(mockWorld.db.all('SELECT url, text_state, title FROM items')).toEqual([{ url: URL_A, text_state: 'cached', title: 'A story' }]);
    expect(mockWorld.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blobs')!.n).toBe(1);
    expect(mockWorld.db.all("SELECT op FROM outbox WHERE state = 'held' ORDER BY id").map((r) => (r as { op: string }).op))
      .toEqual(['upload_blob', 'mirror_blob', 'publish_item']);
  });

  test('one share alone is a new save, and its Undo takes it away (and the race below is the only change)', async () => {
    const owner = setUp();
    const { page, open } = gatedPage(true);
    mockWorld.page = page;
    open();
    const r = await saveLink(URL_A, () => undefined);
    expect(r).toMatchObject({ kind: 'saved', prior: null });
    undoSave(mockWorld.db, owner, r.hash!, r.held, r.prior);
    expect(mockWorld.db.all('SELECT 1 FROM items')).toEqual([]);
  });
});

describe('a share too large for its event (C§3.3)', () => {
  const key = nodeCrypto.randomBytes(32);
  const servers = ['https://blossom.example', 'https://m1.example'];
  const pageOf = (o: { url?: string; parsed?: Record<string, unknown> }, fetched: string[] = []): PagePorts => ({
    fetch: (async (url: string) => {
      fetched.push(url);
      const res = new Response('<article><p>x</p></article>', { status: 200, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(res, 'url', { value: o.url ?? url });
      return res;
    }) as never,
    parse: async () => ({ ok: true, title: 'A story', byline: null, site: 'News', lang: 'en', hero: null, canonical: null, readerable: true, markdown: WORDS, ...o.parsed }) as never,
  });

  test('a page whose fields are huge is fitted, so the save the outbox builds publishes', async () => {
    const owner = setUp();
    mockWorld.page = pageOf({ parsed: { title: 'T'.repeat(50_000), byline: 'B'.repeat(20_000), site: 'S'.repeat(20_000), hero: `https://cdn.example/${'h'.repeat(20_000)}`, canonical: `${URL_A}?${'c'.repeat(20_000)}` } });
    const r = await saveLink(URL_A, () => undefined);
    const row = getItem(mockWorld.db, owner, r.hash!)!;
    expect(row).toMatchObject({ url: URL_A, hero: null, canonical: null, text_state: 'cached' });
    expect(r.title!.length).toBeLessThanOrEqual(300);
    await expect(buildItemEvent(mockWorld.signer, row.hash, itemJson(row, servers), 1_760_000_000, key)).resolves.toBeDefined();
  });

  test('a redirect to an address too long to publish keeps the shared one, and the text', async () => {
    const owner = setUp();
    mockWorld.page = pageOf({ url: `https://news.example/landing?${'x'.repeat(12_000)}` });
    const r = await saveLink(URL_A, () => undefined);
    expect(r).toMatchObject({ kind: 'saved', hash: itemHash(URL_A), title: 'A story' });
    const row = getItem(mockWorld.db, owner, r.hash!)!;
    expect(row).toMatchObject({ url: URL_A, text_state: 'cached' });
    await expect(buildItemEvent(mockWorld.signer, row.hash, itemJson(row, servers), 1_760_000_000, key)).resolves.toBeDefined();
  });

  test('an X post linking to an article too long to publish saves nothing, as one linking to none', async () => {
    setUp();
    const fetched: string[] = [];
    mockWorld.page = pageOf({}, fetched);
    const realFetch = globalThis.fetch;
    const embed = { html: `<a href="https://news.example/?q=${'x'.repeat(10_000)}">the story</a>` };
    globalThis.fetch = (async () => new Response(JSON.stringify(embed), { status: 200, headers: { 'content-type': 'application/json' } })) as never;
    try {
      expect(await saveLink('https://x.com/someone/status/123', () => undefined)).toMatchObject({ kind: 'noarticle', hash: null, held: [] });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetched).toEqual([]);
    expect(mockWorld.db.all('SELECT 1 FROM items')).toEqual([]);
  });

  test('a shared address too long to publish is refused before anything is fetched', async () => {
    setUp();
    const fetched: string[] = [];
    mockWorld.page = pageOf({}, fetched);
    await expect(saveLink(`https://news.example/?q=${'x'.repeat(10_000)}`, () => undefined)).rejects.toThrow('too long');
    expect(fetched).toEqual([]);
    expect(mockWorld.db.all('SELECT 1 FROM items')).toEqual([]);
  });
});

describe('a plain http link (release builds allow no cleartext)', () => {
  test('a public one is fetched over https, and saved at the address its page ends at', async () => {
    const owner = setUp();
    const fetched: string[] = [];
    mockWorld.page = {
      fetch: (async (url: string) => {
        fetched.push(url);
        if (url.startsWith('http://')) throw new Error('CLEARTEXT communication not permitted by network security policy');
        return Object.defineProperty(new Response('<p>x</p>', { status: 200, headers: { 'content-type': 'text/html' } }), 'url', { value: url });
      }) as never,
      parse: async () => ({ ok: true, title: 'A story', byline: null, site: null, lang: null, hero: null, canonical: null, readerable: true, markdown: WORDS }),
    };
    const r = await saveLink('http://news.example/story', () => undefined);
    expect(fetched).toEqual(['https://news.example/story']);
    expect(r).toMatchObject({ kind: 'saved', hash: itemHash('https://news.example/story') });
    expect(getItem(mockWorld.db, owner, r.hash!)).toMatchObject({ url: 'https://news.example/story', shared_url: 'http://news.example/story', text_state: 'cached' });
  });

  test('a share of one whose site has no https waits, as a pending parse under three days old does', async () => {
    // a share is new, so the queue's rule that fails such a save past three days (page.ts HTTPS_WAIT_SECONDS) can't
    // reach it here: a captive portal or a TLS hiccup at the moment of sharing never fails it
    const owner = setUp();
    mockWorld.page = {
      fetch: (async () => Promise.reject(new Error('fetch failed: javax.net.ssl.SSLPeerUnverifiedException: Hostname old.example not verified:'))) as never,
      parse: async () => ({ ok: false, reason: 'error' }),
    };
    const r = await saveLink('http://old.example/post', () => undefined);
    expect(r).toMatchObject({ kind: 'offline', held: [] });
    expect(getItem(mockWorld.db, owner, r.hash!)).toMatchObject({ url: 'http://old.example/post', text_state: 'queued' });
  });

  test("the share asks by net/http's one rule, which pending parses and images follow too", async () => {
    // a copy of its own here could drift from the rule the queue behind it keeps (net/http overHttps, its cases there)
    setUp();
    const rule = jest.spyOn(http, 'overHttps');
    mockWorld.page = { fetch: (async () => Promise.reject(new Error('offline'))) as never, parse: async () => ({ ok: false, reason: 'error' }) };
    try {
      await saveLink('http://news.example:8080/a', () => undefined);
      expect(rule).toHaveBeenCalledWith('http://news.example:8080/a');
    } finally {
      rule.mockRestore();
    }
  });
});

describe('a shared address with a user name and password (contract 4.3, ruling 8)', () => {
  // the hash leaves them out, but a stored address is what Original, Open in browser and X's embed query are given
  const SHARED = 'https://reader:hunter2@news.example/story';
  /** Page ports answering status at each address, recording what was asked for. */
  const answering = (status: number, fetched: string[]): PagePorts => ({
    fetch: (async (url: string) => {
      fetched.push(url);
      return Object.defineProperty(new Response('<p>x</p>', { status, headers: { 'content-type': 'text/html' } }), 'url', { value: url });
    }) as never,
    parse: async () => ({ ok: true, title: 'A story', byline: null, site: null, lang: null, hero: null, canonical: null, readerable: true, markdown: WORDS }),
  });

  test('a page that parses is asked for, saved and kept without them', async () => {
    const owner = setUp();
    const fetched: string[] = [];
    mockWorld.page = answering(200, fetched);
    const r = await saveLink(SHARED, () => undefined);
    expect(fetched).toEqual(['https://news.example/story']);
    expect(getItem(mockWorld.db, owner, r.hash!)).toMatchObject({ url: 'https://news.example/story', shared_url: 'https://news.example/story', text_state: 'cached' });
  });

  test("a page that can't be read keeps its link without them", async () => {
    const owner = setUp();
    mockWorld.page = answering(404, []);
    const r = await saveLink(SHARED, () => undefined);
    expect(getItem(mockWorld.db, owner, r.hash!)).toMatchObject({ url: 'https://news.example/story', shared_url: 'https://news.example/story', text_state: 'failed' });
  });

  test("an X post's embed is asked for without them, and the post waits without them", async () => {
    const owner = setUp();
    const asked: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => (asked.push(u), Promise.reject(new Error('offline')))) as never;
    try {
      const r = await saveLink('https://reader:hunter2@x.com/someone/status/123', () => undefined);
      expect(r.kind).toBe('offline');
      expect(asked).toHaveLength(1);
      expect(asked[0]).not.toMatch(/reader|hunter2/);
      expect(getItem(mockWorld.db, owner, r.hash!)).toMatchObject({ url: 'https://x.com/someone/status/123', x_state: 'pending' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("the article an X post links to is kept without them, when its page can't be had yet", async () => {
    const owner = setUp();
    mockWorld.page = { fetch: (async () => Promise.reject(new Error('offline'))) as never, parse: async () => ({ ok: false, reason: 'error' }) };
    const realFetch = globalThis.fetch;
    const embed = { html: '<blockquote><a href="https://reader:hunter2@news.example/story">the story</a></blockquote>' };
    globalThis.fetch = (async () => new Response(JSON.stringify(embed), { status: 200, headers: { 'content-type': 'application/json' } })) as never;
    try {
      const r = await saveLink('https://x.com/someone/status/123', () => undefined);
      expect(r.kind).toBe('offline');
      expect(getItem(mockWorld.db, owner, r.hash!)).toMatchObject({ url: 'https://news.example/story', text_state: 'queued' });
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('a share saved for later, as the start-up pickup saves, is kept without them', async () => {
    const owner = setUp();
    const r = await saveLater(SHARED, () => undefined);
    expect(getItem(mockWorld.db, owner, r.hash!)).toMatchObject({ url: 'https://news.example/story', shared_url: 'https://news.example/story', text_state: 'queued' });
  });
});

describe('the start-up pickup saves without fetching (8.5)', () => {
  test('each spool waits for the pending queue as an offline share does, an X post for its check, before the sync', async () => {
    setUp();
    const fetched: string[] = [];
    mockWorld.page = { fetch: (async (u: string) => (fetched.push(u), Promise.reject(new Error('offline')))) as never, parse: async () => ({ ok: false, reason: 'error' }) };
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: string) => (fetched.push(u), Promise.reject(new Error('offline')))) as never;
    try {
      mockSpools.clear();
      for (const [id, text] of [['a', 'https://news.example/one'], ['b', 'Look at this https://x.com/someone/status/123'], ['c', 'https://news.example/one']]) {
        mockSpools.set(id, JSON.stringify({ v: 1, id, text, subject: null, referrer: null, receivedAt: 0 }));
      }
      expect(await pickUpSpools()).toBe(3);
      expect(fetched).toEqual([]);
      expect(mockSpools.size).toBe(0);
      expect(mockWorld.db.all('SELECT url, text_state, x_state, origin FROM items ORDER BY id')).toEqual([
        { url: 'https://news.example/one', text_state: 'queued', x_state: null, origin: 'share' },
        { url: 'https://x.com/someone/status/123', text_state: 'queued', x_state: 'pending', origin: 'share' },
      ]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
