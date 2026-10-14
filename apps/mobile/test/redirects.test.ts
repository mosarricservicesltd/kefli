// Redirects followed by hand (mobile spec 5.4, 7.1): a page, an image or X's embed is fetched one hop at a time, each
// hop's address checked before the phone asks for it, ten at most; a hop that fails ends the fetch as a failed one.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { xEmbedUrl } from '@kefli/protocol';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { Blocked, MAX_REDIRECTS, open, redirectTo } from '../src/net/http';
import { fetchArticleImages, imageState, type ImagePorts } from '../src/services/images';
import { DESKTOP_UA, PAGE_TIMEOUT_MS, fetchPage, fetchable, type PagePorts, type ParserResult } from '../src/services/page';
import { checkXPost } from '../src/services/xpost';
import { memoryDb } from './sqlite';

type Hop = { status?: number; location?: string; type?: string; body?: BodyInit };

/**
 * A web whose fetch behaves as OkHttp's does: it follows redirects itself, asking for every hop on the way, unless
 * asked for redirect: 'manual', when it hands back the 3xx. Every address asked for is recorded, with how. A
 * fragment never reaches a server; a Location may hold any character, as OkHttp reads header lines as UTF-8.
 */
function web(routes: Record<string, Hop>, followAnyway = false) {
  const asked: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    let at = url;
    for (let n = 0; 21 > n; n++) {
      asked.push({ url: at, init });
      const r = routes[at.split('#')[0]];
      if (!r) throw new Error('unknown host');
      const headers = new Map(Object.entries({ 'content-type': r.type ?? 'text/html', ...(r.location ? { location: r.location } : {}) }));
      const res = new Response(r.body ?? '<p>x</p>', { status: r.status ?? 200 });
      Object.defineProperty(res, 'headers', { value: { get: (k: string) => headers.get(k.toLowerCase()) ?? null } });
      Object.defineProperty(res, 'url', { value: at });
      if (!r.location || (init.redirect === 'manual' && !followAnyway)) return res;
      at = new URL(r.location, at).href;
    }
    throw new Error('Too many follow-up requests: 21');
  }) as unknown as typeof fetch;
  return { f, asked, urls: () => asked.map((a) => a.url) };
}

const WORDS = `${Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ')}\n`;
const READ: ParserResult = { ok: true, title: 'A story', byline: null, site: null, lang: 'en', hero: null, canonical: null, readerable: true, markdown: WORDS };
const pages = (f: typeof fetch, render?: PagePorts['render']): PagePorts => ({ fetch: f, parse: async () => READ, ...(render ? { render } : {}) });

/** The addresses a page's redirect may name that are the phone's own network, its own files, or no web at all. */
const NOT_THE_WEB = [
  'http://192.168.1.1/cgi-bin/reboot', 'http://10.0.0.1/', 'http://127.0.0.1:8080/admin', 'http://0x7f.1/', 'http://localhost/',
  'http://[::1]/', 'http://[::ffff:192.168.0.1]/', 'http://169.254.169.254/latest/meta-data/', 'http://router.lan/', 'http://printer.local/',
  'http://１２７.０.０.１/', 'http://filesystem.local/data/user/0/app.kefli/files/kefli/a.html', 'http:///filesystem.local/etc/hosts',
  'file:///data/user/0/app.kefli/databases/kefli.db', 'content://media/external/images/1', 'javascript:alert(1)', 'http://[::1',
];

describe("a page's redirects are followed by hand, never onto the phone's own network (5.4, 7.1)", () => {
  test('a redirect to a private, loopback or link-local address, the phone’s files or another scheme is never asked for: the page fails', async () => {
    for (const target of NOT_THE_WEB) {
      let resolved = '';
      try {
        resolved = new URL(target, 'https://news.example/a').href;
      } catch {
        // a Location that names nowhere
      }
      const w = web({ 'https://news.example/a': { status: 302, location: target }, [resolved]: { body: '<p>the router</p>' } });
      const o = await fetchPage(pages(w.f), 'https://news.example/a');
      expect([target, o]).toEqual([target, { kind: 'failed', reason: 'http', finalUrl: 'https://news.example/a' }]);
      expect([target, w.urls()]).toEqual([target, ['https://news.example/a']]);
      expect(w.asked[0].init.redirect).toBe('manual');
    }
  });

  test('the same address further along a chain of public hops is refused just the same, unasked', async () => {
    const w = web({
      'https://t.example/1': { status: 301, location: 'https://u.example/2' },
      'https://u.example/2': { status: 307, location: '/3' },
      'https://u.example/3': { status: 308, location: 'http://192.168.0.10/nas' },
      'http://192.168.0.10/nas': {},
    });
    expect(await fetchPage(pages(w.f), 'https://t.example/1')).toEqual({ kind: 'failed', reason: 'http', finalUrl: 'https://t.example/1' });
    expect(w.urls()).toEqual(['https://t.example/1', 'https://u.example/2', 'https://u.example/3']);
  });

  test('public hops are followed, ten at most, each asked as the browser with no cookies; the page is where they end', async () => {
    const chain = (n: number) => {
      const routes: Record<string, Hop> = {};
      for (let i = 0; n > i; i++) routes[`https://a.example/${i}`] = { status: i % 2 ? 302 : 301, location: `https://a.example/${i + 1}` };
      routes[`https://a.example/${n}`] = {};
      return web(routes);
    };
    const ten = chain(MAX_REDIRECTS);
    expect(await fetchPage(pages(ten.f), 'https://a.example/0')).toMatchObject({ kind: 'parsed', finalUrl: `https://a.example/${MAX_REDIRECTS}` });
    expect(ten.asked).toHaveLength(MAX_REDIRECTS + 1);
    for (const a of ten.asked) {
      expect([a.init.redirect, a.init.credentials, (a.init.headers as Record<string, string>)['User-Agent']]).toEqual(['manual', 'omit', DESKTOP_UA]);
    }
    // each hop's own request is let go before the next is asked
    expect(ten.asked.slice(0, -1).every((a) => a.init.signal?.aborted)).toBe(true);
    // one more is a loop, or near enough: the page fails, its eleventh Location never asked for
    const eleven = chain(MAX_REDIRECTS + 1);
    expect(await fetchPage(pages(eleven.f), 'https://a.example/0')).toEqual({ kind: 'failed', reason: 'http', finalUrl: 'https://a.example/0' });
    expect(eleven.asked).toHaveLength(MAX_REDIRECTS + 1);
  });

  test("a relative Location goes where a browser's would; a 3xx that isn't a redirect is the answer itself", async () => {
    const w = web({ 'https://a.example/x/y?z': { status: 303, location: '../w?q=1#f' }, 'https://a.example/w?q=1': {} });
    expect(await fetchPage(pages(w.f), 'https://a.example/x/y?z')).toMatchObject({ kind: 'parsed', finalUrl: 'https://a.example/w?q=1#f' });
    const at = 'https://a.example/';
    const said = (status: number, location?: string) => redirectTo({ status, headers: new Headers(location === undefined ? {} : { location }) }, at);
    expect([said(301, '//b.example/c'), said(302, 'https://c.example'), said(300, '/x'), said(304, '/x'), said(301), said(302, ''), said(200, '/x')])
      .toEqual(['https://b.example/c', 'https://c.example/', null, null, null, null, null]);
    expect(said(308, 'http://[::1')).toBe('');
  });

  test('a fetch that follows redirects itself is still refused an answer from the phone’s network', async () => {
    // as React Native's own fetch would, ignoring redirect: 'manual'
    const w = web({ 'https://news.example/a': { status: 302, location: 'http://192.168.1.1/' }, 'http://192.168.1.1/': {} }, true);
    expect(await fetchPage(pages(w.f), 'https://news.example/a')).toEqual({ kind: 'failed', reason: 'http', finalUrl: 'https://news.example/a' });
    // a page on the person's own network that they shared themselves is still read where it says it ended
    const lan = web({ 'http://printer.local/': { status: 301, location: '/status' }, 'http://printer.local/status': {} }, true);
    expect(await fetchPage(pages(lan.f), 'http://printer.local/')).toMatchObject({ kind: 'parsed', finalUrl: 'http://printer.local/status' });
  });

  test('a page the browser engine renders that ends on the phone’s network fails as a refused redirect does', async () => {
    const w = web({ 'https://cf.example/a': { status: 403 } });
    const render = async () => ({ url: 'http://192.168.1.1/', html: `<p>${WORDS}</p>` });
    expect(await fetchPage(pages(w.f, render), 'https://cf.example/a')).toEqual({ kind: 'failed', reason: 'http', finalUrl: 'https://cf.example/a' });
    const elsewhere = async () => ({ url: 'https://cf.example/b', html: `<p>${WORDS}</p>` });
    expect(await fetchPage(pages(w.f, elsewhere), 'https://cf.example/a')).toMatchObject({ kind: 'parsed', finalUrl: 'https://cf.example/b' });
  });

  test("expo/fetch's stand-in for the phone's files is never asked for, however its host is written", async () => {
    const w = web({});
    for (const url of [
      'http:///filesystem.local/data/user/0/app.kefli/files/a.html', 'http://FILESYSTEM.LOCAL./x', 'http://ｆｉｌｅｓｙｓｔｅｍ.ｌｏｃａｌ/x',
      'http://filesystem%2Elocal/x', 'http://a@filesystem.local/x', 'https://filesystem.local/x', 'http:\\\\filesystem.local\\x',
    ]) {
      expect([url, fetchable(url)]).toEqual([url, false]);
      expect(await fetchPage(pages(w.f), url)).toEqual({ kind: 'failed', reason: 'http', finalUrl: url });
    }
    expect(w.asked).toEqual([]);
    expect(fetchable('https://filesystem.local.example.com/x')).toBe(true);
  });

  test('every hop runs inside the one deadline: a chain that outlasts it is the network being slow, and goes no further', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    try {
      const asked: string[] = [];
      // each hop answers 8 s later, abort or not
      const slow = (async (url: string) => {
        asked.push(url);
        await new Promise((r) => setTimeout(r, 8_000));
        const n = Number(url.slice(-1));
        return new Response('', { status: 302, headers: { location: `https://slow.example/${n + 1}` } });
      }) as unknown as typeof fetch;
      let out: unknown = null;
      void fetchPage(pages(slow), 'https://slow.example/0').then((o) => (out = o));
      await jest.advanceTimersByTimeAsync(PAGE_TIMEOUT_MS + 1);
      expect(out).toEqual({ kind: 'offline', timedOut: true });
      // the hop on its way when the deadline passed answers later, and nothing more is asked for
      await jest.advanceTimersByTimeAsync(30_000);
      expect(asked).toEqual(['https://slow.example/0', 'https://slow.example/1', 'https://slow.example/2']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("images and X's embed take the same hops (F26, 5.4)", () => {
  const PK = 'ab'.repeat(32);
  const HASH = '01'.repeat(32);
  const png = () => {
    const b = new Uint8Array(24);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 8, 0, 0, 0, 8]);
    return b;
  };

  test("an image that redirects onto the phone's network is never asked for there: it fails, and the images after it still come", async () => {
    const db = memoryDb();
    migrate(db);
    ensureIdentityRow(db, 1, PK, 'new', true);
    db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'https://e.com/', 1, 'unread', 'cached', 'share')", PK, HASH);
    const w = web({
      'https://img.example/cam.png': { status: 302, location: 'http://192.168.1.20/snapshot.png' },
      'http://192.168.1.20/snapshot.png': { type: 'image/png', body: png() },
      'https://img.example/ok.png': { type: 'image/png', body: png() },
    });
    const ports: ImagePorts = {
      db, now: () => 1_000, fetch: w.f, nameOf: (u) => u.slice(-6), files: { write: (n) => `/img/${n}`, remove: () => undefined },
      readArticle: () => ({ blocks: [{ kind: 'img', src: 'https://img.example/cam.png' }, { kind: 'img', src: 'https://img.example/ok.png' }] }),
    };
    expect(await fetchArticleImages(ports, PK, HASH)).toBe(1);
    expect(w.urls()).toEqual(['https://img.example/cam.png', 'https://img.example/ok.png']);
    expect([imageState(db, 'https://img.example/cam.png', 1_000), imageState(db, 'https://img.example/ok.png', 1_000)]).toEqual(['failed', 'here']);
  });

  test("X's embed redirecting onto the phone's network is X failing, the address never asked for", async () => {
    const post = 'https://x.com/someone/status/1';
    const w = web({ [xEmbedUrl(post)]: { status: 302, location: 'http://10.1.1.1/' }, 'http://10.1.1.1/': { body: '{"html":""}' } });
    expect(await checkXPost({ fetch: w.f }, post)).toEqual({ kind: 'xfail' });
    expect(w.urls()).toEqual([xEmbedUrl(post)]);
  });
});

describe('the hops against a real server and a real fetch', () => {
  let server: Server;
  let base = '';
  const seen: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push(req.url!);
      const to: Record<string, string> = { '/a': '/b', '/b': '/c', '/start': '/inside' };
      if (to[req.url!]) {
        res.writeHead(302, { location: to[req.url!] });
        res.end('moved');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<p>here</p>');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  test("redirect: 'manual' hands each 3xx back, and the hops are followed here, where the deadline and the check are", async () => {
    seen.length = 0;
    const o = await open(fetch, `${base}/a`, {}, 5_000, { max: MAX_REDIRECTS, allow: () => true });
    expect(new TextDecoder().decode(await o.read(1024))).toBe('<p>here</p>');
    expect([o.url, seen]).toEqual([`${base}/c`, ['/a', '/b', '/c']]);
    // the same server's redirect to itself, its own address not a public one: the first ask is the caller's to make,
    // the hop is not
    seen.length = 0;
    await expect(open(fetch, `${base}/start`, {}, 5_000, { max: MAX_REDIRECTS, allow: () => false })).rejects.toBeInstanceOf(Blocked);
    expect(seen).toEqual(['/start']);
  });
});
