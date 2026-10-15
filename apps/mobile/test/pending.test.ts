import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { itemHash } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, queueImported, queueSave } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import * as pendingData from '../src/data/pending';
import { pendingParses } from '../src/data/pending';
import { commitDelete, deleteItem } from '../src/data/library';
import { search } from '../src/data/search';
import { DESKTOP_UA, MOBILE_UA, PAGE_MAX_BYTES, RENDER_MAX_BYTES, fetchPage, parsedOutcome, refusal, type ParserResult } from '../src/services/page';
import { AGAIN_MS, RUN_SECONDS, nextRunIn, runPendingParses, settle, type PendingPorts, type PendingResult } from '../src/services/pending';
import { TimedOut } from '../src/net/http';
import { memoryDb } from './sqlite';

const PK = 'ab'.repeat(32);
const D = { v: 1, operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' }, relays: ['ws://a', 'ws://b'], indexer: ['ws://idx'], mirrors: ['http://m1'] };
const T = { api: D.operator.api, blossom: D.operator.blossom, mirror: D.mirrors[0] };
const LONG = Array.from({ length: 130 }, (_, i) => `word${i}`).join(' ');

type Page = { status?: number; type?: string; body?: string; finalUrl?: string; length?: number; only?: string; location?: string };

function world(pages: Record<string, Page | 'down'> = {}, parse?: (url: string) => ParserResult) {
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, 1, PK, 'new', true);
  seedGeneratedLists(db, PK, D);
  const uas: string[] = [];
  const staged = new Map<string, Uint8Array>();
  const texts = new Map<string, string>();
  const ports: PendingPorts = {
    db, now: () => 5000,
    page: {
      fetch: (async (url: string, init: RequestInit) => {
        const ua = (init.headers as Record<string, string>)['User-Agent'];
        uas.push(ua);
        const pg = pages[url];
        if (!pg || pg === 'down') throw new Error('offline');
        if (pg.only && pg.only !== ua) return Object.assign(new Response('', { status: 403 }), {});
        const res = new Response(pg.body ?? '<html></html>', { status: pg.status ?? 200, headers: { 'content-type': pg.type ?? 'text/html; charset=utf-8', ...(pg.length ? { 'content-length': String(pg.length) } : {}), ...(pg.location ? { location: pg.location } : {}) } });
        Object.defineProperty(res, 'url', { value: pg.finalUrl ?? url });
        return res;
      }) as never,
      parse: async (_b, _t, url) => (parse ? parse(url) : { ok: true, title: `Title of ${url}`, byline: null, site: 'Site', lang: 'en', hero: null, canonical: null, readerable: true, markdown: `${LONG}\n` }),
    },
    x: { fetch: (async () => { throw new Error('offline'); }) as never },
    crypto: nodeCrypto,
    stage: (sha, bytes) => (staged.set(sha, bytes), `/staging/${sha}`),
    unstage: (path) => { staged.delete(path.split('/').pop()!); },
    writeText: (hash, md) => texts.set(hash, md),
    targets: async () => T,
  };
  const share = (url: string) => queueSave(db, 1000, {
    owner: PK, hash: itemHash(url), url, canonical: null, title: null, site: null, byline: null, savedAt: 1000, words: null, lang: null,
    hero: null, text: null, textHash: null, textState: 'queued', sharedUrl: url, origin: 'share',
  }, null, T);
  const outbox = () => db.all<{ op: string; subject: string; state: string }>('SELECT op, subject, state FROM outbox ORDER BY id');
  return { db, ports, uas, staged, texts, share, outbox };
}

/**
 * The world's page fetch as a release build's: plain http refused before it connects, as expo/fetch reports OkHttp's
 * refusal. Returns every address asked for.
 */
function releaseBuild(w: ReturnType<typeof world>): string[] {
  const fetch = w.ports.page.fetch;
  const asked: string[] = [];
  w.ports.page.fetch = (async (url: string, init: RequestInit) => {
    asked.push(url);
    if (url.startsWith('http://')) {
      throw new Error(`fetch failed: java.net.UnknownServiceException: CLEARTEXT communication to ${new URL(url).hostname} not permitted by network security policy`);
    }
    return fetch(url, init);
  }) as never;
  return asked;
}

describe('pending parses (mobile spec 4.5 phase 7, 5.4)', () => {
  test("the person's own saves are parsed before an import's (FD 117)", () => {
    const w = world();
    queueImported(w.db, PK, ['https://i.com/1', 'https://i.com/2'], 900, T);
    w.share('https://own.com/a');
    expect(pendingParses(w.db, PK).map((p) => p.url)).toEqual(['https://own.com/a', 'https://i.com/1', 'https://i.com/2']);
  });

  test('what a response may be', () => {
    expect(refusal(200, 'text/html; charset=utf-8', 10)).toBeNull();
    expect(refusal(200, 'application/xhtml+xml', 10)).toBeNull();
    expect(refusal(404, 'text/html', 10)).toBe('http');
    expect(refusal(200, 'application/pdf', 10)).toBe('not_html');
    expect(refusal(200, 'text/html', PAGE_MAX_BYTES + 1)).toBe('too_large');
  });

  test('a page: offline, a 403 tried again as a phone, refused types and sizes, and the guard', async () => {
    const w = world({
      'https://a.com/p': { only: MOBILE_UA },
      'https://a.com/pdf': { type: 'application/pdf' },
      'https://a.com/big': { length: PAGE_MAX_BYTES + 1 },
      'https://a.com/short': {},
      'https://a.com/broken': {},
    }, (url) => (url.endsWith('short') ? { ok: true, title: null, byline: null, site: null, lang: null, hero: null, canonical: null, readerable: false, markdown: 'Too short.\n' }
      : url.endsWith('broken') ? { ok: false, reason: 'not_readable' }
      : { ok: true, title: 'T', byline: null, site: null, lang: null, hero: null, canonical: null, readerable: false, markdown: `${LONG}\n` }));
    expect(await fetchPage(w.ports.page, 'https://down.com/')).toEqual({ kind: 'offline' });
    const ok = await fetchPage(w.ports.page, 'https://a.com/p');
    expect(ok.kind).toBe('parsed');
    expect(w.uas.slice(-2)).toEqual([DESKTOP_UA, MOBILE_UA]);
    expect(await fetchPage(w.ports.page, 'https://a.com/pdf')).toMatchObject({ kind: 'failed', reason: 'not_html' });
    expect(await fetchPage(w.ports.page, 'https://a.com/big')).toMatchObject({ kind: 'failed', reason: 'too_large' });
    expect(await fetchPage(w.ports.page, 'https://a.com/short')).toMatchObject({ kind: 'failed', reason: 'not_readable' });
    expect(await fetchPage(w.ports.page, 'https://a.com/broken')).toMatchObject({ kind: 'failed', reason: 'not_readable' });
  });

  test('a share made offline waits on the phone, then is re-keyed by its final address and sent', async () => {
    const w = world({ 'https://t.co/x': { finalUrl: 'https://news.com/story' } });
    expect(w.share('https://t.co/x')).toEqual([]);
    expect(w.outbox().map((o) => o.op)).toEqual(['register', 'publish_lists']);
    expect(pendingParses(w.db, PK)).toHaveLength(1);
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 1, failed: 0, waiting: 0, xWaiting: 0 });
    const final = itemHash('https://news.com/story');
    const row = w.db.get<Record<string, unknown>>('SELECT * FROM items WHERE hash = ?', final);
    expect(row).toMatchObject({ url: 'https://news.com/story', title: 'Title of https://news.com/story', text_state: 'cached', words: 130, dirty: 1 });
    expect(w.db.get('SELECT 1 FROM items WHERE hash = ?', itemHash('https://t.co/x'))).toBeUndefined();
    expect(w.outbox().filter((o) => o.op !== 'register' && o.op !== 'publish_lists').map((o) => [o.op, o.state])).toEqual([
      ['upload_blob', 'queued'], ['mirror_blob', 'queued'], ['publish_item', 'queued'],
    ]);
    expect(w.texts.get(final)).toBe(`${LONG}\n`);
    expect(w.db.all("SELECT rowid FROM items_fts WHERE items_fts MATCH 'word42'")).toHaveLength(1);
    expect(w.staged.size).toBe(1);
  });

  test('a page still turned away with 403 is loaded in a browser engine and parsed the same way', async () => {
    const w = world({ 'https://cf.com/p': { only: 'a browser' }, 'https://cf.com/q': { only: 'a browser' } });
    const seen: string[] = [];
    const page = {
      ...w.ports.page,
      render: async (url: string) => {
        seen.push(url);
        return url.endsWith('/p') ? { url: 'https://cf.com/p?final', html: '<html><body>rendered</body></html>' } : null;
      },
    };
    expect(await fetchPage(page, 'https://cf.com/p')).toMatchObject({ kind: 'parsed', finalUrl: 'https://cf.com/p?final' });
    // the engine failing too leaves the honest failure
    expect(await fetchPage(page, 'https://cf.com/q')).toMatchObject({ kind: 'failed', reason: 'http' });
    expect(seen).toEqual(['https://cf.com/p', 'https://cf.com/q']);
    // a rendered page past the cap is too large; without the port a 403 is a failure as before
    const big = { ...w.ports.page, render: async () => ({ url: 'https://cf.com/p', html: 'x'.repeat(RENDER_MAX_BYTES + 1) }) };
    expect(await fetchPage(big, 'https://cf.com/p')).toMatchObject({ kind: 'failed', reason: 'too_large' });
    expect(await fetchPage(w.ports.page, 'https://cf.com/p')).toMatchObject({ kind: 'failed', reason: 'http' });
    // a bare 103 Early Hints handed back as the answer goes to the engine as well
    // (a Response can't be made with a 1xx, so this one is hand-made)
    const early = (async (url: string) => ({ status: 103, url, headers: new Headers(), arrayBuffer: async () => new ArrayBuffer(0) })) as never;
    expect(await fetchPage({ ...w.ports.page, fetch: early, render: page.render }, 'https://sub.com/p')).toMatchObject({ kind: 'parsed' });
    expect(seen.at(-1)).toBe('https://sub.com/p');
  });

  test("a browser's save naming a private address is never fetched; the phone's own share of one is", async () => {
    const w = world({ 'http://192.168.1.1/admin': {}, 'http://printer.local/': {} });
    w.share('http://192.168.1.1/admin');
    w.db.run("UPDATE items SET origin = 'browser' WHERE url = 'http://192.168.1.1/admin'");
    w.share('http://printer.local/');
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ parsed: 1, failed: 1 });
    expect(w.uas).toHaveLength(1);
    expect(w.db.get<{ text_state: string }>("SELECT text_state FROM items WHERE url = 'http://192.168.1.1/admin'")?.text_state).toBe('failed');
  });

  test('a re-keyed share that turns out to be a save already here joins it', async () => {
    const w = world({ 'https://t.co/y': { finalUrl: 'https://news.com/old' } });
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'https://news.com/old', 10, 'archived', 'cached', 'share')", PK, itemHash('https://news.com/old'));
    w.share('https://t.co/y');
    await runPendingParses(w.ports, PK);
    expect(w.db.all<{ hash: string; state: string }>('SELECT hash, state FROM items')).toEqual([{ hash: itemHash('https://news.com/old'), state: 'unread' }]);
    expect(w.staged.size).toBe(0);
    expect(w.outbox().some((o) => o.op === 'publish_item' && o.subject === itemHash('https://news.com/old'))).toBe(true);
  });

  test('a page that can never be read goes out without text; offline, the queue waits', async () => {
    const w = world({ 'https://a.com/gone': { status: 410 }, 'https://b.com/later': 'down' });
    w.share('https://a.com/gone');
    w.share('https://b.com/later');
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 0, failed: 1, waiting: 1, xWaiting: 0 });
    expect(w.db.get('SELECT text_state, fail_reason FROM items WHERE hash = ?', itemHash('https://a.com/gone'))).toEqual({ text_state: 'failed', fail_reason: 'http' });
    expect(w.outbox().filter((o) => o.op === 'publish_item').map((o) => o.subject)).toEqual([itemHash('https://a.com/gone')]);
    expect(pendingParses(w.db, PK).map((x) => x.url)).toEqual(['https://b.com/later']);
  });

  test('one page that always times out waits without holding up the shares after it; a run of them stops the queue (F12)', async () => {
    const w = world({ 'https://b.com/ok': {}, 'https://d.com/ok': {}, 'https://h.com/ok': {} });
    let clock = 5000;
    w.ports.now = () => clock;
    const page = w.ports.page.fetch;
    const slow = new Set(['https://a.com/slow', 'https://c.com/slow', 'https://e.com/slow', 'https://f.com/slow', 'https://g.com/slow']);
    const asked: string[] = [];
    w.ports.page.fetch = (async (url: string, init: RequestInit) => {
      asked.push(url);
      if (slow.has(url)) throw new TimedOut();
      return page(url, init);
    }) as never;
    for (const u of ['https://a.com/slow', 'https://b.com/ok', 'https://c.com/slow', 'https://d.com/ok']) w.share(u);
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 2, failed: 0, waiting: 2, xWaiting: 0 });
    expect(pendingParses(w.db, PK).map((x) => x.url)).toEqual(['https://a.com/slow', 'https://c.com/slow']);
    // three slow pages in a row read as the network: the rest wait for the next sync, unasked; the pages that timed
    // out before go after the new shares
    for (const u of ['https://e.com/slow', 'https://f.com/slow', 'https://g.com/slow']) w.share(u);
    clock += 60;
    asked.length = 0;
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 0, failed: 0, waiting: 5, xWaiting: 0 });
    expect(asked).toEqual(['https://e.com/slow', 'https://f.com/slow', 'https://g.com/slow']);
    // five pages that always time out sit ahead of a later share by date, and still don't hold it up
    w.share('https://h.com/ok');
    clock += 60;
    asked.length = 0;
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 1, failed: 0, waiting: 5, xWaiting: 0 });
    expect(asked.slice(0, 2)).toEqual(['https://h.com/ok', 'https://a.com/slow']);
  });

  test('a dead link shared offline waits at the back without holding up the shares behind it', async () => {
    // fetch rejecting, as for a domain that is gone, a broken certificate or a redirect loop: before, the first such
    // page stopped the queue, and it came first again at every sync, so nothing behind it was ever parsed
    const w = world({ 'https://b.com/ok': {}, 'https://c.com/ok': {}, 'https://gone.example/a': 'down' });
    for (const u of ['https://gone.example/a', 'https://b.com/ok', 'https://c.com/ok']) w.share(u);
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 2, failed: 0, waiting: 1, xWaiting: 0 });
    expect(pendingParses(w.db, PK).map((x) => x.url)).toEqual(['https://gone.example/a']);
    w.share('https://d.com/new');
    expect(pendingParses(w.db, PK).map((x) => x.url)).toEqual(['https://d.com/new', 'https://gone.example/a']);
  });

  test('three in a row that cannot be had are the network: the rest wait for the next sync, unasked', async () => {
    const w = world({ 'https://e.com/ok': {} });
    for (const u of ['https://a.com/x', 'https://b.com/x', 'https://c.com/x', 'https://e.com/ok']) w.share(u);
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 0, failed: 0, waiting: 4, xWaiting: 0 });
    expect(w.uas).toHaveLength(3);
  });

  test('an X post whose check cannot reach X waits at the back without holding up the rest', async () => {
    const w = world({ 'https://b.com/ok': {} });
    w.share('https://x.com/someone/status/1');
    w.db.run("UPDATE items SET x_state = 'pending' WHERE url = 'https://x.com/someone/status/1'");
    w.share('https://b.com/ok');
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 1, failed: 0, waiting: 1, xWaiting: 0 });
    expect(pendingParses(w.db, PK).map((x) => x.url)).toEqual(['https://x.com/someone/status/1']);
  });

  test('a save whose parse throws waits at the back and the rest go on, with no staged blob left behind', async () => {
    const w = world({ 'https://a.com/one': {}, 'https://b.com/two': {} });
    for (const u of ['https://a.com/one', 'https://b.com/two']) w.share(u);
    const apply = jest.spyOn(pendingData, 'applyParsed').mockImplementationOnce(() => {
      throw new Error('database disk image is malformed');
    });
    try {
      expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 1, failed: 0, waiting: 1, xWaiting: 0 });
    } finally {
      apply.mockRestore();
    }
    expect(pendingParses(w.db, PK).map((x) => x.url)).toEqual(['https://a.com/one']);
    // only the parsed save's blob is staged; the one whose save couldn't take it went
    expect(w.staged.size).toBe(1);
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 1, failed: 0, waiting: 0, xWaiting: 0 });
  });

  test('two runs at once (a sync and the inbox) parse each save once, and keep it', async () => {
    // the inbox runs pending parses when it saves something, whatever a sync is doing: before, both read the same
    // queue, and the second to apply its parse re-keyed a save the first had already re-keyed, found it already
    // there, and deleted it as a duplicate
    const w = world({ 'https://t.co/x': { finalUrl: 'https://news.com/story' }, 'https://t.co/y': { finalUrl: 'https://news.com/other' } });
    w.share('https://t.co/x');
    w.share('https://t.co/y');
    const page = w.ports.page.fetch;
    let fetches = 0;
    w.ports.page.fetch = (async (url: string, init: RequestInit) => {
      fetches++;
      await new Promise((r) => setTimeout(r, 5));
      return page(url, init);
    }) as never;
    const [a, b] = await Promise.all([runPendingParses(w.ports, PK), runPendingParses(w.ports, PK)]);
    expect(a.parsed + b.parsed).toBeGreaterThanOrEqual(2);
    expect(w.db.all<{ hash: string; text_state: string }>('SELECT hash, text_state FROM items ORDER BY hash')).toEqual(
      [itemHash('https://news.com/other'), itemHash('https://news.com/story')].sort().map((hash) => ({ hash, text_state: 'cached' })),
    );
    expect(fetches).toBe(2);
    expect(w.staged.size).toBe(2);
  });

  test('a parse applied to a save another path has settled meanwhile is dropped, not applied over it', async () => {
    const w = world({ 'https://t.co/z': { finalUrl: 'https://news.com/z' } });
    w.share('https://t.co/z');
    const [item] = pendingParses(w.db, PK);
    const outcome = await fetchPage(w.ports.page, item.url);
    if (outcome.kind === 'offline') throw new Error('offline');
    // the same save settled twice at once, as the inbox and a pending parse could before
    expect(await Promise.all([settle(w.ports, PK, item, outcome), settle(w.ports, PK, item, outcome)])).toEqual(['parsed', 'parsed']);
    expect(w.db.all('SELECT hash, text_state FROM items')).toEqual([{ hash: itemHash('https://news.com/z'), text_state: 'cached' }]);
    expect(w.staged.size).toBe(1);
    // nor does a failure land on a save that has its text
    await settle(w.ports, PK, item, { kind: 'failed', reason: 'http', finalUrl: item.url });
    expect(w.db.get('SELECT text_state FROM items')).toEqual({ text_state: 'cached' });
  });

  test("another phone's save without text keeps its address when parsed here", async () => {
    const w = world({ 'https://c.com/a': { finalUrl: 'https://c.com/b' } });
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, published, event_id) VALUES (?, ?, 'https://c.com/a', 10, 'unread', 'queued', 'sync', 1, 'e1')", PK, itemHash('https://c.com/a'));
    await runPendingParses(w.ports, PK);
    expect(w.db.get('SELECT hash, url, text_state FROM items')).toEqual({ hash: itemHash('https://c.com/a'), url: 'https://c.com/a', text_state: 'cached' });
  });

  test('a parse is searchable as its row is stored: at the address the save keeps, with its fields as fitted', async () => {
    // an address long enough that the page's title has to be cut down, and its site shed, for the event to fit
    const far = `https://d.example/r?${'x'.repeat(8_950)}`;
    const w = world({ 'https://c.example/a': { finalUrl: 'https://landing.example/elsewhere' }, [far]: {} }, (url) => ({
      ok: true, title: url === far ? `Bracken ${'b'.repeat(290)}` : `Quietus ${'q'.repeat(290)}`, byline: null,
      site: url === far ? 'Fernwood' : 'Heathersite', lang: 'en', hero: null, canonical: null, readerable: true, markdown: `${LONG}\n`,
    }));
    // another phone's save, which keeps its own address whatever its page now lands on
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, published, event_id) VALUES (?, ?, 'https://c.example/a', 10, 'unread', 'queued', 'sync', 1, 'e1')", PK, itemHash('https://c.example/a'));
    w.share(far);
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ parsed: 2 });
    const rows = w.db.all<{ title: string | null; site: string | null; url: string }>('SELECT title, site, url FROM items ORDER BY id');
    expect(rows.map((r) => [r.url.slice(0, 22), r.title?.length, r.site])).toEqual([
      ['https://c.example/a', 298, 'Heathersite'], ['https://d.example/r?xx', 80, null],
    ]);
    // the index is contentless: each column is asked what it holds
    const holds = (q: string) => w.db.all('SELECT rowid FROM items_fts WHERE items_fts MATCH ?', q).length;
    // the address the published save keeps and the fields the other kept are there, its title as cut ('Bracken bbb…')
    const cutTail = rows[1].title!.slice('Bracken '.length, -1);
    expect(cutTail).toBe('b'.repeat(71));
    expect([holds('url:c'), holds('site:heathersite'), holds(`title:${'q'.repeat(290)}`), holds(`title:${cutTail}`)]).toEqual([1, 1, 1, 1]);
    // where the page now lands, the site shed and the cut title's tail are not
    expect([holds('url:landing'), holds('url:elsewhere'), holds('site:fernwood'), holds(`title:${'b'.repeat(290)}`)]).toEqual([0, 0, 0, 0]);
    expect([search(w.db, PK, 'landing'), search(w.db, PK, 'fernwood')]).toEqual([[], []]);
  });

  test("a published save whose page can't be read here has nothing new to send", async () => {
    const w = world({ 'https://c.com/gone': { status: 410 } });
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, published, event_id, modified_at) VALUES (?, ?, 'https://c.com/gone', 10, 'unread', 'queued', 'sync', 1, 'e1', 7)", PK, itemHash('https://c.com/gone'));
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ failed: 1 });
    expect(w.db.get('SELECT text_state, fail_reason, dirty, modified_at FROM items')).toEqual({ text_state: 'failed', fail_reason: 'http', dirty: 0, modified_at: 7 });
    expect(w.outbox()).toEqual([]);
  });

  test("a published save's text is its only change: uploaded and mirrored, the save not sent again until they hold it (C§4.2)", async () => {
    const w = world({ 'https://c.com/a': {} });
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, published, event_id, modified_at) VALUES (?, ?, 'https://c.com/a', 10, 'unread', 'queued', 'sync', 1, 'e1', 7)", PK, itemHash('https://c.com/a'));
    await runPendingParses(w.ports, PK);
    expect(w.outbox().filter((o) => o.op !== 'register').map((o) => o.op)).toEqual(['upload_blob', 'mirror_blob']);
    // the row stays clean, so a newer copy from another phone is still taken over it (data/sync.ts keeps the text)
    expect(w.db.get('SELECT dirty, modified_at, text_servers FROM items')).toEqual({ dirty: 0, modified_at: 7, text_servers: null });
  });

  test('a waiting share whose page is too large for its event is fitted, and keeps an address it can publish (C§3.3)', async () => {
    const far = `https://d.com/landing?${'x'.repeat(12_000)}`;
    const huge = (url: string): ParserResult => ({
      ok: true, title: 'T'.repeat(50_000), byline: 'B'.repeat(9_000), site: 'S', lang: 'en', hero: `https://cdn.d.com/${'h'.repeat(9_000)}`,
      canonical: url === far ? null : `https://d.com/b?${'c'.repeat(9_000)}`, readerable: true, markdown: `${LONG}\n`,
    });
    const w = world({ 'https://d.com/a': {}, 'https://d.com/r': { finalUrl: far } }, huge);
    w.share('https://d.com/a');
    w.share('https://d.com/r');
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ parsed: 2 });
    const rows = w.db.all<{ hash: string; url: string; canonical: string | null; hero: string | null; title: string }>('SELECT hash, url, canonical, hero, title FROM items ORDER BY id');
    expect(rows.map((r) => [r.hash, r.url, r.canonical, r.hero])).toEqual([
      [itemHash('https://d.com/a', `https://d.com/b?${'c'.repeat(9_000)}`), 'https://d.com/a', null, null],
      [itemHash('https://d.com/r'), 'https://d.com/r', null, null],
    ]);
    expect(rows.every((r) => r.title.length <= 300)).toBe(true);
  });

  test('a plain http save whose site has no https waits as a page that can’t be had, without stopping the saves behind it', async () => {
    const w = world({ 'https://g.com/b': {} });
    const asked = releaseBuild(w);
    w.share('http://g.com/a');
    w.share('https://g.com/b');
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ parsed: 1, waiting: 1 });
    expect(w.db.all('SELECT url, text_state FROM items ORDER BY id')).toEqual([
      { url: 'http://g.com/a', text_state: 'queued' }, { url: 'https://g.com/b', text_state: 'cached' },
    ]);
    // asked over https only, as the share path asks (net/http overHttps)
    expect(asked).toEqual(['https://g.com/b', 'https://g.com/a']);
  });

  test('a plain http save made offline, or imported, is fetched over https and re-keyed by where it lands', async () => {
    const w = world({ 'https://news.example/a': {}, 'https://old.example/post': {} });
    const asked = releaseBuild(w);
    w.share('http://news.example/a');
    queueImported(w.db, PK, ['http://old.example/post'], 900, T);
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 2, failed: 0, waiting: 0, xWaiting: 0 });
    expect(asked).toEqual(['https://news.example/a', 'https://old.example/post']);
    expect(w.db.all('SELECT hash, url, text_state FROM items ORDER BY id')).toEqual([
      { hash: itemHash('https://news.example/a'), url: 'https://news.example/a', text_state: 'cached' },
      { hash: itemHash('https://old.example/post'), url: 'https://old.example/post', text_state: 'cached' },
    ]);
  });

  test('cleartext the build refuses fails the save at once, sent without its text, and the queue goes on', async () => {
    // a port keeps its http (overHttps), and an https page can redirect to plain http: neither will ever be fetched
    const w = world({ 'https://b.example/ok': {}, 'https://site.example/a': { status: 301, location: 'http://site.example/a' } });
    const asked = releaseBuild(w);
    for (const u of ['http://g.example:8080/a', 'https://site.example/a', 'https://b.example/ok']) w.share(u);
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 1, failed: 2, waiting: 0, xWaiting: 0 });
    expect(asked).toEqual(['https://site.example/a', 'http://site.example/a', 'https://b.example/ok', 'http://g.example:8080/a']);
    expect(w.db.all('SELECT url, text_state, fail_reason FROM items ORDER BY id')).toEqual([
      { url: 'http://g.example:8080/a', text_state: 'failed', fail_reason: 'http' },
      { url: 'https://site.example/a', text_state: 'failed', fail_reason: 'http' },
      { url: 'https://b.example/ok', text_state: 'cached', fail_reason: null },
    ]);
    // each goes out without text, its row opening the original, rather than waiting for good unpublished
    expect(w.outbox().filter((o) => o.op === 'publish_item').map((o) => o.subject).sort()).toEqual(
      [itemHash('http://g.example:8080/a'), itemHash('https://site.example/a'), itemHash('https://b.example/ok')].sort(),
    );
    expect(pendingParses(w.db, PK)).toEqual([]);
  });

  test('a save deleted while its page is fetched takes nothing: no upload, no sends, no text, no search entry', async () => {
    const w = world({ 'https://f.com/a': {}, 'https://f.com/b': { status: 404 } });
    w.share('https://f.com/a');
    w.share('https://f.com/b');
    const fetch = w.ports.page.fetch;
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    w.ports.page.fetch = (async (url: string, init: RequestInit) => (await gate, fetch(url, init))) as never;
    const run = runPendingParses(w.ports, PK);
    await new Promise((r) => setTimeout(r, 20));
    // while the first is fetched: it is deleted for good, and the second is deleted and waits on its Undo
    const a = deleteItem(w.db, 6000, PK, itemHash('https://f.com/a'));
    commitDelete(w.db, PK, itemHash('https://f.com/a'), a.held);
    deleteItem(w.db, 6000, PK, itemHash('https://f.com/b'));
    open();
    await run;
    expect(w.outbox().filter((r) => ['upload_blob', 'mirror_blob', 'publish_item'].includes(r.op))).toEqual([]);
    expect(w.db.all('SELECT sha256 FROM blobs')).toEqual([]);
    expect([w.staged.size, w.texts.size]).toEqual([0, 0]);
    expect(w.db.get('SELECT COUNT(*) AS n FROM items_fts')).toEqual({ n: 0 });
    // the second, if its delete is undone, is still waiting for its parse
    expect(w.db.all('SELECT url, text_state FROM items')).toEqual([{ url: 'https://f.com/b', text_state: 'queued' }]);
  });

  test("a save whose delete waits on Undo while its page is parsed takes nothing, another phone's included: shown again, it is parsed then", async () => {
    const w = world({ 'https://f.com/new': {}, 'https://f.com/out': {} });
    w.share('https://f.com/new');
    // another phone's save without text, whose text is its only change once parsed here (C§4.2)
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, published, event_id, modified_at) VALUES (?, ?, 'https://f.com/out', 10, 'unread', 'queued', 'sync', 1, 'e1', 7)", PK, itemHash('https://f.com/out'));
    const fetch = w.ports.page.fetch;
    const undos = new Map<string, () => void>();
    // each deleted as its page arrives, its delete waiting on Undo
    w.ports.page.fetch = (async (url: string, init: RequestInit) => {
      if (!undos.has(url)) undos.set(url, deleteItem(w.db, 6000, PK, itemHash(url)).revert);
      return fetch(url, init);
    }) as never;
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ parsed: 2 });
    expect(w.outbox().filter((r) => ['upload_blob', 'mirror_blob', 'publish_item'].includes(r.op))).toEqual([]);
    expect([w.staged.size, w.texts.size, w.db.get('SELECT COUNT(*) AS n FROM items_fts')]).toEqual([0, 0, { n: 0 }]);
    expect(w.db.all('SELECT url, text_state, modified_at FROM items ORDER BY id')).toEqual([
      { url: 'https://f.com/new', text_state: 'queued', modified_at: expect.any(Number) }, { url: 'https://f.com/out', text_state: 'queued', modified_at: 7 },
    ]);
    // Undo: each is parsed at the next run, the new one sent with its text, the other phone's given only its text
    for (const undo of undos.values()) undo();
    w.ports.page.fetch = fetch;
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ parsed: 2 });
    expect(w.db.all('SELECT url, text_state FROM items ORDER BY id')).toEqual([
      { url: 'https://f.com/new', text_state: 'cached' }, { url: 'https://f.com/out', text_state: 'cached' },
    ]);
    const sends = w.outbox().filter((r) => ['upload_blob', 'mirror_blob', 'publish_item'].includes(r.op));
    expect(sends.map((r) => r.op).sort()).toEqual(['mirror_blob', 'mirror_blob', 'publish_item', 'upload_blob', 'upload_blob']);
    expect(sends.filter((r) => r.op === 'publish_item').map((r) => r.subject)).toEqual([itemHash('https://f.com/new')]);
  });
});

describe('a save at an http address whose site has no https (RULED: past three days it fails as a page that can’t be read)', () => {
  const DAY = 86_400;
  const TLS = () => new Error('fetch failed: javax.net.ssl.SSLPeerUnverifiedException: Hostname old.example not verified:');
  const REFUSED = () => new Error('fetch failed: java.net.ConnectException: Failed to connect to old.example/203.0.113.7:443');
  const NO_NAME = () => new Error('fetch failed: java.net.UnknownHostException: Unable to resolve host "old.example": No address associated with hostname');

  /**
   * The world as a release build on a network: plain http refused before it connects, old.example's https failing
   * as fail makes it, and every other site as the world has it. Returns every address asked for.
   */
  function noHttps(w: ReturnType<typeof world>, fail: () => Error): string[] {
    const asked = releaseBuild(w);
    const inner = w.ports.page.fetch;
    w.ports.page.fetch = (async (url: string, init: RequestInit) => {
      if (!url.startsWith('https://old.example/')) return inner(url, init);
      asked.push(url);
      throw fail();
    }) as never;
    return asked;
  }
  const at = (w: ReturnType<typeof world>, seconds: number) => (w.ports.now = () => 1000 + seconds);
  const publishes = (w: ReturnType<typeof world>) => w.outbox().filter((o) => o.op === 'publish_item').map((o) => o.subject);

  test('more than three days old, its https refused with the phone online: sent without its text, its link kept', async () => {
    const w = world({ 'https://ok.example/a': {} });
    const asked = noHttps(w, TLS);
    let asks = 0;
    w.ports.online = async () => (asks++, true);
    w.share('http://old.example/post');
    w.share('https://ok.example/a');
    at(w, 3 * DAY + 1);
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 1, failed: 1, waiting: 0, xWaiting: 0 });
    expect(asked).toEqual(['https://ok.example/a', 'https://old.example/post']);
    expect(w.db.get('SELECT hash, url, text_state, fail_reason FROM items WHERE url = ?', 'http://old.example/post')).toEqual({
      hash: itemHash('http://old.example/post'), url: 'http://old.example/post', text_state: 'failed', fail_reason: 'http',
    });
    expect(publishes(w)).toContain(itemHash('http://old.example/post'));
    expect(pendingParses(w.db, PK)).toEqual([]);
    // the network's state was asked once, for the one save the rule could fail
    expect(asks).toBe(1);
  });

  test('so is one whose connection is refused on port 443', async () => {
    const w = world();
    noHttps(w, REFUSED);
    w.ports.online = async () => true;
    w.share('http://old.example/post');
    at(w, 10 * DAY);
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ failed: 1, waiting: 0 });
  });

  test("so is one whose firewall turns port 443 away as host unreachable, RHEL's and CentOS's default", async () => {
    // left waiting, a site whose server has only port 80 open behind that firewall was never read nor backed up
    const w = world();
    noHttps(w, () => new Error('fetch failed: java.net.NoRouteToHostException: Host unreachable'));
    w.ports.online = async () => true;
    w.share('http://old.example/post');
    at(w, 10 * DAY);
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ failed: 1, waiting: 0 });
    expect(w.db.get('SELECT text_state, fail_reason FROM items')).toEqual({ text_state: 'failed', fail_reason: 'http' });
    expect(publishes(w)).toEqual([itemHash('http://old.example/post')]);
  });

  test('three days old or less it waits, as its share did: a captive portal or a TLS hiccup can’t fail it', async () => {
    const w = world();
    noHttps(w, TLS);
    w.ports.online = async () => true;
    w.share('http://old.example/post');
    at(w, 3 * DAY);
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ failed: 0, waiting: 1 });
    expect(w.db.get('SELECT text_state FROM items')).toEqual({ text_state: 'queued' });
    expect(publishes(w)).toEqual([]);
  });

  test('at any age it waits while the phone is off the internet, or can’t say it is on it', async () => {
    // Android doesn't count a network behind a captive portal as reaching the internet (expo-network isInternetReachable)
    for (const online of [async () => false, async () => Promise.reject(new Error('no state')), undefined]) {
      const w = world();
      noHttps(w, TLS);
      w.ports.online = online;
      w.share('http://old.example/post');
      at(w, 30 * DAY);
      expect(await runPendingParses(w.ports, PK)).toMatchObject({ failed: 0, waiting: 1 });
      expect(publishes(w)).toEqual([]);
    }
  });

  test('at any age it waits when its https attempt met the network: a name that resolves nowhere, or a time-out', async () => {
    for (const fail of [NO_NAME, () => new TimedOut()]) {
      const w = world();
      noHttps(w, fail);
      w.ports.online = async () => true;
      w.share('http://old.example/post');
      at(w, 30 * DAY);
      expect(await runPendingParses(w.ports, PK)).toMatchObject({ failed: 0, waiting: 1 });
    }
  });

  test('a save at an https address whose TLS is refused waits at any age: only an http one is asked over https alone', async () => {
    const w = world();
    noHttps(w, TLS);
    w.ports.online = async () => true;
    w.share('https://old.example/post');
    at(w, 30 * DAY);
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ failed: 0, waiting: 1 });
  });

  test("the runner gives the queue Android's own judgement of the internet (runner.ts can't load in Node)", () => {
    // without the port no save is ever failed for want of https, so the rule would never reach the phone
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'runner.ts'), 'utf8');
    const fn = src.slice(src.indexOf('async function parsePending('), src.indexOf('let xFailures'));
    expect(fn).toMatch(/\bonline: async \(\) => \(await getNetworkStateAsync\(\)\)\.isInternetReachable === true,/);
  });

  test("another phone's save at such an address is marked failed here, with nothing new to send (C§4.2)", async () => {
    const w = world();
    noHttps(w, TLS);
    w.ports.online = async () => true;
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, published, event_id, modified_at) VALUES (?, ?, 'http://old.example/post', 10, 'unread', 'queued', 'sync', 1, 'e1', 7)", PK, itemHash('http://old.example/post'));
    at(w, 30 * DAY);
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ failed: 1 });
    expect(w.db.get('SELECT text_state, fail_reason, dirty, modified_at FROM items')).toEqual({ text_state: 'failed', fail_reason: 'http', dirty: 0, modified_at: 7 });
    expect(w.outbox()).toEqual([]);
  });
});

describe('a user name and password are never kept in a stored address (contract 4.3, ruling 8)', () => {
  // the hash leaves them out, but the stored address is what Original, Open in browser and X's embed query are given
  test('an imported link is queued without them', () => {
    const w = world();
    expect(queueImported(w.db, PK, ['https://reader:hunter2@old.example/post', 'https://medium.example/@writer/essay'], 900, T)).toBe(2);
    expect(w.db.all('SELECT url, shared_url FROM items ORDER BY id')).toEqual([
      { url: 'https://old.example/post', shared_url: 'https://old.example/post' },
      { url: 'https://medium.example/@writer/essay', shared_url: 'https://medium.example/@writer/essay' },
    ]);
  });

  test("a parse whose address has them, as a browser's request may, is stored without them", async () => {
    const w = world();
    w.share('https://news.example/a');
    const [item] = pendingParses(w.db, PK);
    const outcome = parsedOutcome({ ok: true, title: 'T', byline: null, site: null, lang: null, hero: null, canonical: null, readerable: true, markdown: `${LONG}\n` }, 'https://reader:hunter2@news.example/a');
    expect(await settle(w.ports, PK, item, outcome)).toBe('parsed');
    expect(w.db.all('SELECT hash, url, text_state FROM items')).toEqual([{ hash: itemHash('https://news.example/a'), url: 'https://news.example/a', text_state: 'cached' }]);
  });

  test("another phone's save stored with them keeps its address without them once parsed here", async () => {
    const w = world({ 'https://c.com/a': {} });
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, published, event_id) VALUES (?, ?, 'https://reader:hunter2@c.com/a', 10, 'unread', 'queued', 'sync', 1, 'e1')", PK, itemHash('https://c.com/a'));
    await runPendingParses(w.ports, PK);
    expect(w.db.get('SELECT hash, url, text_state FROM items')).toEqual({ hash: itemHash('https://c.com/a'), url: 'https://c.com/a', text_state: 'cached' });
  });

  test("X's embed is asked about a waiting post without them, as a row stored before ruling 8 holds them", async () => {
    const w = world();
    const asked: string[] = [];
    w.ports.x = { fetch: (async (u: string) => (asked.push(u), Promise.reject(new Error('offline')))) as never };
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, x_state) VALUES (?, ?, 'https://reader:hunter2@x.com/someone/status/1', 10, 'unread', 'queued', 'share', 'pending')", PK, itemHash('https://x.com/someone/status/1'));
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ waiting: 1 });
    expect(asked).toHaveLength(1);
    expect(asked[0]).not.toMatch(/reader|hunter2/);
  });

  test("an X post's article address is taken without them", () => {
    const w = world();
    w.share('https://x.com/someone/status/1');
    const [item] = pendingParses(w.db, PK);
    expect(pendingData.xFound(w.db, item, 'https://reader:hunter2@news.example/story').url).toBe('https://news.example/story');
    expect(w.db.get('SELECT url FROM items')).toEqual({ url: 'https://news.example/story' });
  });
});

describe('a run of pending parses has a minute (an import of thousands held every later sync for hours)', () => {
  /** The world's clock, moved on by each page fetched. */
  function timed(w: ReturnType<typeof world>, pageSeconds: number) {
    const clock = { now: 5000 };
    w.ports.now = () => clock.now;
    const fetch = w.ports.page.fetch;
    w.ports.page.fetch = (async (url: string, init: RequestInit) => ((clock.now += pageSeconds), fetch(url, init))) as never;
    return clock;
  }

  test('a run starts parses for RUN_SECONDS at most; the rest wait for a run the runner starts soon', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://i.example/${i}`);
    const w = world(Object.fromEntries(urls.map((u) => [u, {}])));
    timed(w, 10);
    queueImported(w.db, PK, urls, 900, T);
    const first = await runPendingParses(w.ports, PK);
    expect(first).toEqual({ parsed: RUN_SECONDS / 10, failed: 0, waiting: 0, xWaiting: 0, untried: 10 - RUN_SECONDS / 10 });
    expect(nextRunIn(first, 0)).toBe(AGAIN_MS);
    expect(pendingParses(w.db, PK).map((q) => q.url)).toEqual(urls.slice(RUN_SECONDS / 10));
    const second = await runPendingParses(w.ports, PK);
    expect(second).toEqual({ parsed: 10 - RUN_SECONDS / 10, failed: 0, waiting: 0, xWaiting: 0 });
    expect(nextRunIn(second, 0)).toBeNull();
  });

  test('a run out of time asks for the next soon only for parses never tried; those that couldn’t be had wait for a sync', async () => {
    const fresh = ['https://a.example/1', 'https://a.example/2', 'https://a.example/3'];
    const w = world(Object.fromEntries(fresh.map((u) => [u, {}])));
    timed(w, 30);
    // two that couldn't be had at an earlier sync, at the back of the queue
    for (const u of ['https://gone.example/x', 'https://gone.example/y']) w.share(u);
    w.db.run("UPDATE items SET timed_out_at = 100 WHERE url LIKE 'https://gone.example/%'");
    for (const u of fresh) w.share(u);
    const first = await runPendingParses(w.ports, PK);
    expect(first).toEqual({ parsed: 2, failed: 0, waiting: 0, xWaiting: 0, untried: 1 });
    expect(nextRunIn(first, 0)).toBe(AGAIN_MS);
    const second = await runPendingParses(w.ports, PK);
    // the last new one, then one of the old until the minute is spent: none of those left was never tried
    expect(second).toEqual({ parsed: 1, failed: 0, waiting: 1, xWaiting: 0, untried: 0 });
    expect(nextRunIn(second, 0)).toBeNull();
  });

  test('three in a row that can’t be had after a parse are dead links: the next run comes soon, three from the start still the network', async () => {
    // an old import: dead links come in runs, and a run that stopped at three of them waited for the next sync, for
    // days if Kefli wasn't opened, with most of the import never tried
    const dead = ['https://gone.example/1', 'https://gone.example/2', 'https://gone.example/3'];
    const live = ['https://ok.example/1', 'https://ok.example/2', 'https://ok.example/3'];
    const w = world(Object.fromEntries([...live.map((u) => [u, {}]), ...dead.map((u) => [u, 'down'])]));
    queueImported(w.db, PK, [live[0], ...dead, live[1], live[2]], 900, T);
    const first = await runPendingParses(w.ports, PK);
    expect(first).toEqual({ parsed: 1, failed: 0, waiting: 5, xWaiting: 0, untried: 2 });
    expect(nextRunIn(first, 0)).toBe(AGAIN_MS);
    // the dead links at the back now: the rest are parsed, and the three tried again, in a row, end the run
    const second = await runPendingParses(w.ports, PK);
    expect(second).toEqual({ parsed: 2, failed: 0, waiting: 3, xWaiting: 0 });
    expect(nextRunIn(second, 0)).toBeNull();
    // three from a run's start are the network, as before: the rest wait for the next sync, unasked
    const off = world(Object.fromEntries(live.map((u) => [u, 'down'])));
    queueImported(off.db, PK, [...live, 'https://ok.example/4'], 900, T);
    const offline = await runPendingParses(off.ports, PK);
    expect(offline).toEqual({ parsed: 0, failed: 0, waiting: 4, xWaiting: 0 });
    expect(nextRunIn(offline, 0)).toBeNull();
  });

  test("X posts X doesn't answer go to the back, so they can't spend every run's minute ahead of the pages behind them", async () => {
    const pages = Array.from({ length: 4 }, (_, i) => `https://p.example/${i}`);
    const w = world(Object.fromEntries(pages.map((u) => [u, {}])));
    const clock = timed(w, 10);
    // X's embed failing after 25 s, the longest a post's check can take
    w.ports.x = { fetch: (async () => ((clock.now += 25), new Response('', { status: 500 }))) as never };
    const posts = [1, 2, 3].map((n) => `https://x.com/someone/status/${n}`);
    for (const u of posts) {
      w.share(u);
      w.db.run("UPDATE items SET x_state = 'pending' WHERE url = ?", u);
    }
    for (const u of pages) w.share(u);
    expect(await runPendingParses(w.ports, PK)).toEqual({ parsed: 0, failed: 0, waiting: 0, xWaiting: 3, untried: 4 });
    // before, the posts came first again at each run, and the pages behind them were never reached
    expect(await runPendingParses(w.ports, PK)).toMatchObject({ parsed: 4, untried: 0 });
    expect(pendingParses(w.db, PK).map((q) => q.url).sort()).toEqual(posts);
  });

  test('a call while a run goes is answered inside the same minute: what it queued is left for the next run, soon', async () => {
    const w = world({ 'https://a.example/1': {}, 'https://a.example/2': {} });
    const clock = timed(w, 0);
    const fetch = w.ports.page.fetch;
    let second: Promise<PendingResult> | null = null;
    w.ports.page.fetch = (async (url: string, init: RequestInit) => {
      await new Promise((r) => setTimeout(r, 1));
      clock.now += RUN_SECONDS + 10;
      // the inbox saves one and asks for its parse while the run's first page is fetched
      if (!second) {
        w.share('https://a.example/2');
        second = runPendingParses(w.ports, PK);
      }
      return fetch(url, init);
    }) as never;
    w.share('https://a.example/1');
    const first = await runPendingParses(w.ports, PK);
    expect(first).toEqual({ parsed: 1, failed: 0, waiting: 0, xWaiting: 0, untried: 1 });
    expect(await second).toEqual(first);
    expect(pendingParses(w.db, PK).map((q) => q.url)).toEqual(['https://a.example/2']);
  });

  test('the next run comes soon while parses never tried remain, and backs off for X as before (G3)', () => {
    const r = (o: Partial<PendingResult>): PendingResult => ({ parsed: 0, failed: 0, waiting: 0, xWaiting: 0, ...o });
    // the network going, or nothing left: the next sync
    expect([nextRunIn(r({}), 0), nextRunIn(r({ waiting: 5 }), 0), nextRunIn(r({ untried: 0 }), 0)]).toEqual([null, null, null]);
    expect(nextRunIn(r({ untried: 3 }), 0)).toBe(AGAIN_MS);
    expect([nextRunIn(r({ xWaiting: 1 }), 1), nextRunIn(r({ xWaiting: 1 }), 8)]).toEqual([30_000, 3_600_000]);
    expect(nextRunIn(r({ xWaiting: 1, untried: 2 }), 8)).toBe(AGAIN_MS);
  });

  test("the runner's timer is the one nextRunIn gives (runner.ts can't load in Node)", () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'services', 'runner.ts'), 'utf8');
    const fn = src.slice(src.indexOf('async function parsePending('), src.indexOf('let xFailures'));
    expect(fn).toMatch(/const next = nextRunIn\(r, xFailures\);\s+if \(next !== null\) xTimer = setTimeout\(\(\) => runSync\(\)\.catch\(\(\) => undefined\), next\);/);
  });
});
