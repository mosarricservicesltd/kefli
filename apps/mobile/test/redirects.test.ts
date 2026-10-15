// Redirects followed by hand (mobile spec 5.4, 7.1): a page, an image or X's embed is fetched one hop at a time, each
// hop's address checked before the phone asks for it, ten at most; a hop that fails ends the fetch as a failed one.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { LocalSigner, encryptText, normaliseMarkdown, xEmbedUrl } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { MB, accountFigures } from '../src/data/account';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { textQueue } from '../src/data/sync';
import { Blocked, MAX_REDIRECTS, NO_HOPS, WEB_HOPS, apiFetch, fromFiles, loopback, open, redirectTo, serverHops } from '../src/net/http';
import { checkAccount } from '../src/services/account';
import { fetchArticleImages, imageState, type ImagePorts } from '../src/services/images';
import { readBlob } from '../src/services/inbox';
import { DESKTOP_UA, PAGE_TIMEOUT_MS, fetchPage, fetchable, type PagePorts, type ParserResult } from '../src/services/page';
import { fetchText, type SyncPorts } from '../src/services/sync';
import { checkXPost, resolveTco } from '../src/services/xpost';
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

/**
 * The web as a release build reaches it: plain http refused before it connects, once its name resolves, in expo/fetch's
 * words for OkHttp's refusal; the names in dead resolve to nothing, whatever the scheme.
 */
function release(routes: Record<string, Hop>, dead: string[] = []) {
  const w = web(routes);
  const asked: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    asked.push(url);
    const host = new URL(url).hostname;
    if (dead.includes(host)) throw new Error(`fetch failed: java.net.UnknownHostException: Unable to resolve host "${host}"`);
    if (url.startsWith('http://')) {
      throw new Error(`fetch failed: java.net.UnknownServiceException: CLEARTEXT communication to ${host} not permitted by network security policy`);
    }
    return w.f(url, init);
  }) as unknown as typeof fetch;
  return { f, asked };
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
      // the link a failed save keeps has no user name and password in it (contract 4.3, ruling 8)
      expect(await fetchPage(pages(w.f), url)).toEqual({ kind: 'failed', reason: 'http', finalUrl: url.replace('a@', '') });
    }
    expect(w.asked).toEqual([]);
    expect(fetchable('https://filesystem.local.example.com/x')).toBe(true);
  });

  // expo/fetch's OkHttp client turns any address whose text begins http://filesystem.local back into a file: URL and
  // reads the rest from the phone's storage, relative to the app's working directory, the root:
  // http://filesystem.localdata/data/app.kefli/… is /data/data/app.kefli/…. Such a name is no local one, so it passed
  // the public-address check; and each hop followed by hand is a fresh request, which that client reads this way,
  // where OkHttp's own following never did.
  const FILES = [
    'http://filesystem.localdata/data/app.kefli/files/kefli/a.html', 'http://FileSystem.LocalData:80/user/0/app.kefli/databases/kefli.db',
    'http://ｆｉｌｅｓｙｓｔｅｍ.ｌｏｃａｌｄａｔａ/data/app.kefli/x', 'http://filesystem.local-x/', 'http://filesystem.local0./etc/hosts',
  ];

  test("a host that only begins with the stand-in for the phone's files is never asked for, first or at any hop", async () => {
    for (const url of FILES) {
      const first = web({});
      expect([url, fetchable(url), await fetchPage(pages(first.f), url)]).toEqual([url, false, { kind: 'failed', reason: 'http', finalUrl: url }]);
      expect(first.asked).toEqual([]);
      const hop = web({ 'https://news.example/a': { status: 302, location: url }, [new URL(url).href]: { body: '<p>the phone’s own files</p>' } });
      expect([url, await fetchPage(pages(hop.f), 'https://news.example/a')]).toEqual([url, { kind: 'failed', reason: 'http', finalUrl: 'https://news.example/a' }]);
      expect([url, hop.urls()]).toEqual([url, ['https://news.example/a']]);
    }
    // the scheme as the URL parser reads it, past leading spaces and a tab inside it; over https only the stand-in
    // itself is refused, the rest being the web's to answer
    expect([' http://filesystem.localdata/x', 'ht\ttp://filesystem.localdata/x', 'http://filesystem.local./x', 'https://filesystem.local/x'].map(fromFiles))
      .toEqual([true, true, true, true]);
    expect(['https://filesystem.localdata/x', 'https://filesystem.local.example.com/x', 'http://www.filesystem.localdata/x', 'http://e.com/filesystem.local'].map(fromFiles))
      .toEqual([false, false, false, false]);
  });

  test('a redirect through plain http is followed over https; one to a site with no https fails, refused as cleartext', async () => {
    // a shortener's link made for an http address, its site long since on https: OkHttp refused the http hop
    const moved = release({ 'https://bit.example/x': { status: 301, location: 'http://news.example/story' }, 'https://news.example/story': {} });
    expect(await fetchPage(pages(moved.f), 'https://bit.example/x')).toMatchObject({ kind: 'parsed', finalUrl: 'https://news.example/story' });
    expect(moved.asked).toEqual(['https://bit.example/x', 'https://news.example/story']);
    // a site with no https: its address as itself, which every build refuses once the name resolves, fails the page
    const old = release({ 'https://bit.example/y': { status: 302, location: 'http://old.example/story' } });
    expect(await fetchPage(pages(old.f), 'https://bit.example/y')).toEqual({ kind: 'failed', reason: 'http', finalUrl: 'https://bit.example/y' });
    expect(old.asked).toEqual(['https://bit.example/y', 'https://old.example/story', 'http://old.example/story']);
    // the network gone mid-chain is still the network: the save waits
    const gone = release({ 'https://bit.example/z': { status: 302, location: 'http://gone.example/' } }, ['gone.example']);
    expect(await fetchPage(pages(gone.f), 'https://bit.example/z')).toEqual({ kind: 'offline' });
    expect(gone.asked).toEqual(['https://bit.example/z', 'https://gone.example/', 'http://gone.example/']);
    // an address with a port keeps its http (overHttps), asked once and refused
    const port = release({ 'https://bit.example/p': { status: 302, location: 'http://news.example:8080/story' } });
    expect(await fetchPage(pages(port.f), 'https://bit.example/p')).toEqual({ kind: 'failed', reason: 'http', finalUrl: 'https://bit.example/p' });
    expect(port.asked).toEqual(['https://bit.example/p', 'http://news.example:8080/story']);
    // an https page sending its request to its own http isn't asked again over https, round and round to the tenth hop
    const down = release({ 'https://down.example/a': { status: 301, location: 'http://down.example/a' } });
    expect(await fetchPage(pages(down.f), 'https://down.example/a')).toEqual({ kind: 'failed', reason: 'http', finalUrl: 'https://down.example/a' });
    expect(down.asked).toEqual(['https://down.example/a', 'http://down.example/a']);
  });

  test('an https try still under way at the deadline is the network being slow: its http is never asked', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    try {
      const asked: string[] = [];
      const f = (async (url: string, init: RequestInit) => {
        asked.push(url);
        if (url === 'https://bit.example/s') return new Response('', { status: 301, headers: { location: 'http://slow.example/story' } });
        // the https try answers nothing until the deadline lets it go
        return new Promise<Response>((_, fail) => init.signal?.addEventListener('abort', () => fail(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
      }) as unknown as typeof fetch;
      let out: unknown = null;
      void fetchPage(pages(f), 'https://bit.example/s').then((o) => (out = o));
      await jest.advanceTimersByTimeAsync(PAGE_TIMEOUT_MS + 1);
      expect(out).toEqual({ kind: 'offline', timedOut: true });
      expect(asked).toEqual(['https://bit.example/s', 'https://slow.example/story']);
    } finally {
      jest.useRealTimers();
    }
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

  test("an image at, or redirected to, a host that only begins with the stand-in for the phone's files is never asked for", async () => {
    const db = memoryDb();
    migrate(db);
    ensureIdentityRow(db, 1, PK, 'new', true);
    db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'https://e.com/', 1, 'unread', 'cached', 'share')", PK, HASH);
    const w = web({
      'https://img.example/a.png': { status: 302, location: 'http://filesystem.localdata/data/app.kefli/files/kefli/img.png' },
      'http://filesystem.localdata/data/app.kefli/files/kefli/img.png': { type: 'image/png', body: png() },
      // a port keeps an address's http (net/http overHttps), and OkHttp drops a default one before the stand-in is read
      'http://filesystem.localdata:80/data/app.kefli/files/kefli/img.png': { type: 'image/png', body: png() },
      'https://img.example/ok.png': { type: 'image/png', body: png() },
    });
    const srcs = ['https://img.example/a.png', 'http://filesystem.localdata:80/data/app.kefli/files/kefli/img.png', 'https://img.example/ok.png'];
    const ports: ImagePorts = {
      db, now: () => 1_000, fetch: w.f, nameOf: (u) => u.slice(-6), files: { write: (n) => `/img/${n}`, remove: () => undefined },
      readArticle: () => ({ blocks: srcs.map((src) => ({ kind: 'img', src })) }),
    };
    expect(await fetchArticleImages(ports, PK, HASH)).toBe(1);
    expect(w.urls()).toEqual(['https://img.example/a.png', 'https://img.example/ok.png']);
  });

  test('an http image is asked for over https; one whose site has no https fails alone, and the images after it still come', async () => {
    const db = memoryDb();
    migrate(db);
    ensureIdentityRow(db, 1, PK, 'new', true);
    db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'https://e.com/', 1, 'unread', 'cached', 'share')", PK, HASH);
    const w = release({ 'https://img.example/moved.png': { type: 'image/png', body: png() }, 'https://img.example/ok.png': { type: 'image/png', body: png() } });
    const srcs = ['http://old.example/a.png', 'http://img.example/moved.png', 'https://img.example/ok.png'];
    const ports: ImagePorts = {
      db, now: () => 1_000, fetch: w.f, nameOf: (u) => u.slice(-9), files: { write: (n) => `/img/${n}`, remove: () => undefined },
      readArticle: () => ({ blocks: srcs.map((src) => ({ kind: 'img', src })) }),
    };
    // before, the https try failing read as the network: the run stopped there at every sync, and no image after it came
    expect(await fetchArticleImages(ports, PK, HASH)).toBe(2);
    expect(w.asked).toEqual(['https://old.example/a.png', 'http://old.example/a.png', 'https://img.example/moved.png', 'https://img.example/ok.png']);
    expect(srcs.map((u) => imageState(db, u, 1_000))).toEqual(['failed', 'here', 'here']);
  });

  test('a t.co link through plain http is followed over https', async () => {
    const w = release({ 'https://t.co/h': { status: 301, location: 'http://news.example/story' }, 'https://news.example/story': {} });
    expect(await resolveTco({ fetch: w.f }, 'https://t.co/h')).toBe('https://news.example/story');
    expect(w.asked).toEqual(['https://t.co/h', 'https://news.example/story']);
    // the post's article, which OkHttp's refusal of the http hop had passed over as a link that doesn't resolve
    const post = 'https://x.com/someone/status/2';
    const x = release({
      [xEmbedUrl(post)]: { type: 'application/json', body: JSON.stringify({ html: '<a href="https://t.co/h">x</a>' }) },
      'https://t.co/h': { status: 301, location: 'http://news.example/story' }, 'https://news.example/story': {},
    });
    expect(await checkXPost({ fetch: x.f }, post)).toEqual({ kind: 'article', url: 'https://news.example/story' });
  });

  test("a t.co link leading to a host that only begins with the stand-in for the phone's files is never followed there", async () => {
    const w = web({ 'https://t.co/f': { status: 301, location: 'http://filesystem.localdata/data/app.kefli/x' }, 'http://filesystem.localdata/data/app.kefli/x': {} });
    await expect(resolveTco({ fetch: w.f }, 'https://t.co/f')).rejects.toThrow('not a public address');
    expect(w.urls()).toEqual(['https://t.co/f']);
  });

  test("X's embed redirecting onto the phone's network is X failing, the address never asked for", async () => {
    const post = 'https://x.com/someone/status/1';
    const w = web({ [xEmbedUrl(post)]: { status: 302, location: 'http://10.1.1.1/' }, 'http://10.1.1.1/': { body: '{"html":""}' } });
    expect(await checkXPost({ fetch: w.f }, post)).toEqual({ kind: 'xfail' });
    expect(w.urls()).toEqual([xEmbedUrl(post)]);
  });
});

describe("a text's blob servers, the inbox's and Kefli's API take the hops too (7.1)", () => {
  const PK = 'cd'.repeat(32);
  const HASH = '02'.repeat(32);
  /** The addresses on the phone's own network a hostile server's redirect may name, each serving what was asked for. */
  const INSIDE = ['http://192.168.1.1/', 'http://10.0.0.5/', 'http://127.0.0.1:8080/', 'http://localhost/', 'http://[::1]/', 'http://169.254.169.254/'];

  /** A save whose text is on servers, as another phone's arrives, and sync's ports for its text over a web of routes. */
  async function textWorld(servers: string[], routes: (sha: string, blob: Uint8Array<ArrayBuffer>) => Record<string, Hop>, localStack?: boolean) {
    const db = memoryDb();
    migrate(db);
    ensureIdentityRow(db, 1, PK, 'new', true);
    const enc = await encryptText(normaliseMarkdown('# A text\n\nA few words of it.\n'), nodeCrypto);
    db.run(`INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, text_sha256, text_key, text_nonce, text_servers)
      VALUES (?, ?, 'https://e.com/a', 1, 'unread', 'remote', 'sync', ?, ?, ?, ?)`, PK, HASH, enc.text.sha256, enc.text.key, enc.text.nonce, JSON.stringify(servers));
    const w = web(routes(enc.text.sha256, new Uint8Array(enc.blob)));
    const written: string[] = [];
    const ports: SyncPorts = {
      db, now: () => 1_000, signer: async () => null, query: async () => [], fetch: w.f, crypto: nodeCrypto,
      defaults: async () => ({ operator: { relay: 'wss://op.example', blossom: servers[0] }, relays: [], indexer: [], mirrors: [] }),
      files: { writeText: (hash) => void written.push(hash), removeText: () => undefined, removeAll: () => undefined },
      ...(localStack === undefined ? {} : { localStack }),
    };
    return { w, ports, job: textQueue(db, PK)[0], written, sha: enc.text.sha256 };
  }

  test('loopback is localhost, 127.0.0.0/8 and ::1 as the URL parser writes them; a local stack’s hops may go there, no other’s', () => {
    expect(['http://localhost:3447/a', 'http://LOCALHOST./a', 'http://127.0.0.1:8447/', 'http://127.9.9.9/', 'http://[::1]:3448/', 'http://[0:0::1]/', 'http://0x7f.1/'].map(loopback))
      .toEqual([true, true, true, true, true, true, true]);
    expect(['http://localhost.example/', 'http://192.168.1.1/', 'http://[::2]/', 'ws://localhost:7447', 'file:///localhost', 'http://filesystem.local/x'].map(loopback))
      .toEqual([false, false, false, false, false, false]);
    expect(serverHops(false)).toBe(WEB_HOPS);
    expect([serverHops(true).max, serverHops(true).allow('http://localhost:3448/x'), serverHops(false).allow('http://localhost:3448/x')]).toEqual([MAX_REDIRECTS, true, false]);
    // the local stack's hops are the web's and loopback only: never the rest of the phone's network, nor its files
    expect(['http://192.168.1.1/', 'http://10.0.0.1/', 'http://printer.local/', 'http://filesystem.localdata/x', 'https://news.example/'].map(serverHops(true).allow))
      .toEqual([false, false, false, false, true]);
  });

  test("a blob server's redirect into the phone's network is never asked: the text comes from the next server, or waits", async () => {
    for (const inside of INSIDE) {
      const t = await textWorld(['https://mirror.example', 'https://blossom.example'], (sha, blob) => ({
        [`https://mirror.example/${sha}`]: { status: 302, location: `${inside}${sha}` }, [`${inside}${sha}`]: { body: blob },
        [`https://blossom.example/${sha}`]: { body: blob },
      }));
      expect([inside, await fetchText(t.ports, t.job)]).toEqual([inside, 'ok']);
      expect([inside, t.w.urls()]).toEqual([inside, [`https://mirror.example/${t.sha}`, `https://blossom.example/${t.sha}`]]);
      expect(t.w.asked.every((a) => a.init.redirect === 'manual')).toBe(true);
    }
    // the only server sending the phone there: the text waits for the next sync, as for a server not answering
    const alone = await textWorld(['https://mirror.example'], (sha, blob) => ({
      [`https://mirror.example/${sha}`]: { status: 307, location: `http://192.168.1.1/${sha}` }, [`http://192.168.1.1/${sha}`]: { body: blob },
    }));
    expect(await fetchText(alone.ports, alone.job)).toBe('offline');
    expect(alone.w.urls()).toEqual([`https://mirror.example/${alone.sha}`]);
    expect(alone.written).toEqual([]);
  });

  test("a blob server's public redirect is followed, as OkHttp followed it; on the local stack a loopback one too", async () => {
    const cdn = await textWorld(['https://mirror.example'], (sha, blob) => ({
      [`https://mirror.example/${sha}`]: { status: 301, location: `https://cdn.example/b/${sha}` }, [`https://cdn.example/b/${sha}`]: { body: blob },
    }));
    expect(await fetchText(cdn.ports, cdn.job)).toBe('ok');
    expect(cdn.written).toEqual([HASH]);
    const routes = (sha: string, blob: Uint8Array<ArrayBuffer>): Record<string, Hop> => ({
      [`http://localhost:3447/${sha}`]: { status: 302, location: `http://127.0.0.1:3448/${sha}` }, [`http://127.0.0.1:3448/${sha}`]: { body: blob },
    });
    const local = await textWorld(['http://localhost:3447'], routes, true);
    expect(await fetchText(local.ports, local.job)).toBe('ok');
    expect(local.w.urls()).toEqual([`http://localhost:3447/${local.sha}`, `http://127.0.0.1:3448/${local.sha}`]);
    // a release build's: the same redirect is refused, the loopback address never asked
    const release = await textWorld(['http://localhost:3447'], routes);
    expect(await fetchText(release.ports, release.job)).toBe('offline');
    expect(release.w.urls()).toEqual([`http://localhost:3447/${release.sha}`]);
  });

  test("the inbox blob's server redirecting into the phone's network is never asked: the capture is read again later", async () => {
    const enc = await encryptText('<h1>Captured</h1>', nodeCrypto);
    const html = { ...enc.text, server: 'https://blossom.example' };
    for (const inside of INSIDE) {
      const w = web({ [`https://blossom.example/${enc.text.sha256}`]: { status: 307, location: `${inside}x` }, [`${inside}x`]: { body: new Uint8Array(enc.blob) } });
      expect([inside, await readBlob({ fetch: w.f, crypto: nodeCrypto }, html)]).toEqual([inside, { kind: 'failed', down: true }]);
      expect(w.urls()).toEqual([`https://blossom.example/${enc.text.sha256}`]);
    }
    const local = { ...enc.text, server: 'http://localhost:3447' };
    const routes = { [`http://localhost:3447/${enc.text.sha256}`]: { status: 302, location: 'http://localhost:3449/x' }, 'http://localhost:3449/x': { body: new Uint8Array(enc.blob) } };
    expect(await readBlob({ fetch: web(routes).f, crypto: nodeCrypto, localStack: true }, local)).toEqual({ kind: 'html', html: '<h1>Captured</h1>', size: enc.blob.length });
    expect(await readBlob({ fetch: web(routes).f, crypto: nodeCrypto }, local)).toEqual({ kind: 'failed', down: true });
  });

  /** GET /account over a web of routes, as Advanced asks it; followAnyway, through a fetch that follows them itself. */
  function accountWorld(routes: Record<string, Hop>, followAnyway = false) {
    const db = memoryDb();
    migrate(db);
    const own = new LocalSigner(nodeCrypto.randomBytes(32));
    ensureIdentityRow(db, 1_000, own.pubkey(), 'new', true);
    const w = web(routes, followAnyway);
    const ports = { db, now: () => 1_000, owner: own.pubkey(), api: async () => 'https://api.example', signer: async () => own, fetch: w.f, crypto: nodeCrypto };
    return { w, ports, db, owner: own.pubkey() };
  }
  const FIGURES = JSON.stringify({ v: 1, quota: 50 * MB, used: 1, daily: 20 * MB, today: 0 });
  const authorised = (init: RequestInit) => new Headers(init.headers).has('authorization');

  test("Kefli's API redirecting into the phone's network is never asked, and the check fails", async () => {
    for (const inside of INSIDE) {
      const a = accountWorld({ 'https://api.example/account': { status: 302, location: `${inside}account` }, [`${inside}account`]: { body: FIGURES } });
      expect([inside, await checkAccount(a.ports)]).toEqual([inside, 'failed']);
      expect(a.w.urls()).toEqual(['https://api.example/account']);
      expect(accountFigures(a.db, a.owner)).toBeNull();
    }
  });

  test("Kefli's API answering with any redirect, to its own origin or another, fails the check, and nothing it names is asked", async () => {
    // every call to the API is signed for its exact address (C§6), so it never answers through a redirect. Followed, a
    // redirect's page was taken for the library's figures, and the NIP-98 header went on to another path of its origin
    const named: [number, string][] = [
      [307, 'https://elsewhere.example/account'], [308, 'https://api.example:8443/account'], [308, '/v1/account'], [303, '/v1/account'],
      [301, 'https://api.example/account/'], [302, 'http://api.example/account'],
    ];
    for (const [status, location] of named) {
      const to = new URL(location, 'https://api.example/account').href;
      const a = accountWorld({ 'https://api.example/account': { status, location }, [to]: { body: FIGURES } });
      expect([status, location, await checkAccount(a.ports)]).toEqual([status, location, 'failed']);
      expect([status, location, a.w.asked.map((x) => [x.url, authorised(x.init), x.init.redirect])])
        .toEqual([status, location, [['https://api.example/account', true, 'manual']]]);
      expect(accountFigures(a.db, a.owner)).toBeNull();
    }
    // a 3xx that names nowhere, or is no redirect at all, is no answer of the API's either, whatever its body says
    for (const status of [300, 302, 399]) {
      const a = accountWorld({ 'https://api.example/account': { status, body: FIGURES } });
      expect([status, await checkAccount(a.ports)]).toEqual([status, 'failed']);
      expect(accountFigures(a.db, a.owner)).toBeNull();
    }
    // nor is the last hop's answer from a fetch that follows redirects itself, as React Native's own does
    const rn = accountWorld({ 'https://api.example/account': { status: 308, location: '/v1/account' }, 'https://api.example/v1/account': { body: FIGURES } }, true);
    expect(await checkAccount(rn.ports)).toBe('failed');
    expect(accountFigures(rn.db, rn.owner)).toBeNull();
  });

  test("Kefli's API answering as itself is still read, its address written however the fetch writes it", async () => {
    const a = accountWorld({ 'https://api.example/account': { body: FIGURES } });
    expect(await checkAccount(a.ports)).toBe('ok');
    // OkHttp writes the address it asked in its own way: its host in lower case, a default port left out
    const answering = (url: string) => (async () => {
      const res = new Response(FIGURES, { status: 200 });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as unknown as typeof fetch;
    for (const written of ['https://api.example/account', 'https://API.example:443/account']) {
      const o = await open(answering(written), 'https://api.example/account', {}, 5_000, NO_HOPS);
      o.done();
      expect(o.url).toBe(written);
    }
    await expect(open(answering('https://api.example/v1/account'), 'https://api.example/account', {}, 5_000, NO_HOPS)).rejects.toMatchObject({ why: 'redirect' });
  });
});

describe("Kefli's API follows no redirect, on any build (contract 6)", () => {
  type Answer = { status: number; location?: string; redirected?: boolean; url?: string };
  /** apiFetch over an API that answers every call with a, every address it is asked recorded with how. */
  function api(a: Answer) {
    const asked: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      asked.push({ url, init });
      if (!url.startsWith('https://api.example/')) return new Response('<p>a page</p>', { status: 200 });
      const res = new Response(null, { status: a.status, headers: a.location ? { location: a.location } : {} });
      if (a.redirected) Object.defineProperty(res, 'redirected', { value: true });
      if (a.url) Object.defineProperty(res, 'url', { value: a.url });
      return res;
    }) as unknown as typeof fetch;
    return { f: apiFetch(f), asked };
  }

  test('every 3xx, with a Location or without, rejects as a refused redirect; nothing it names is asked', async () => {
    // followed, a DELETE /account answered 303 to any page that answers 200 read as the account deleted, and Delete my
    // data went on to wipe the phone; a POST answered 301 or 302 went the same way
    const answers: Answer[] = [
      { status: 303, location: 'https://news.example/' }, { status: 302, location: 'https://news.example/' }, { status: 301, location: '/v1/account' },
      { status: 307, location: '/v1/account' }, { status: 308, location: 'https://api.example/v1/account' }, { status: 302 }, { status: 300 },
      { status: 304 }, { status: 305, location: 'https://proxy.example/' }, { status: 399 },
    ];
    for (const a of answers) {
      for (const method of ['DELETE', 'POST', 'GET']) {
        const w = api(a);
        const call = w.f('https://api.example/account', { method, ...(method === 'POST' ? { body: '{"v":1}' } : {}) });
        await expect(call).rejects.toMatchObject({ name: 'Blocked', why: 'redirect' });
        expect([a, method, w.asked.map((x) => [x.url, x.init.method, x.init.redirect, x.init.credentials])])
          .toEqual([a, method, [['https://api.example/account', method, 'manual', 'omit']]]);
      }
    }
  });

  test('an answer a fetch says came through a redirect, or from another address, is refused as one', async () => {
    for (const a of [{ status: 200, redirected: true }, { status: 200, url: 'https://news.example/' }, { status: 200, url: 'https://api.example/v1/account' }]) {
      await expect(api(a).f('https://api.example/account', { method: 'DELETE' })).rejects.toBeInstanceOf(Blocked);
    }
  });

  test("the API's own answers come back as they are, a refusal's status and a server error's among them", async () => {
    for (const status of [200, 204, 400, 401, 403, 404, 409, 429, 500, 503]) {
      const res = await api({ status }).f('https://api.example/account', { method: 'DELETE' });
      expect([status, res.status, res.ok]).toEqual([status, status, status >= 200 && 300 > status]);
    }
  });

  test('no hop is taken on the local stack either, whose API never redirects', async () => {
    expect([NO_HOPS.max, NO_HOPS.allow('http://localhost:8447/account'), NO_HOPS.allow('https://api.example/account')]).toEqual([0, false, false]);
    const w = web({ 'http://localhost:8447/account': { status: 307, location: 'http://localhost:8447/v1/account' }, 'http://localhost:8447/v1/account': { body: '{}' } });
    await expect(apiFetch(w.f)('http://localhost:8447/account', { method: 'DELETE' })).rejects.toMatchObject({ why: 'redirect' });
    expect(w.urls()).toEqual(['http://localhost:8447/account']);
  });
});

describe("the local stack's loopback hops are wired where its servers are asked, and only there", () => {
  const source = (path: string) => readFileSync(join(__dirname, '..', 'src', path), 'utf8');
  /** The text of what follows from in src, to the end of the braces it opens next. */
  function block(src: string, from: string): string {
    const at = src.indexOf(from);
    if (at === -1) throw new Error(`no ${from}`);
    let depth = 0;
    for (let i = src.indexOf('{', at); src.length > i; i++) {
      if (src[i] === '{') depth++;
      if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
    }
    throw new Error(`no end to ${from}`);
  }
  const WIRED = 'localStack: LOCAL_STACK';

  test("the runner's ports pass the build's own word, so a release build's never allow loopback", () => {
    // services/config.ts LOCAL_STACK is true only in the local stack's build (app.config.js KEFLI_VARIANT=local)
    const runner = source('services/runner.ts');
    const ports = {
      sync: block(runner, 'function syncPorts('),
      inbox: block(runner, 'export function runInbox('),
      moveInbox: block(runner, 'drainSourceInbox:'),
      outbox: block(runner, 'return await drain({'),
      move: block(runner, 'const r = await runMove({'),
    };
    // left out, as they were, the local stack's servers redirecting on loopback failed its sync, inbox and move
    for (const [name, text] of Object.entries(ports)) expect([name, text.includes(WIRED)]).toEqual([name, true]);
    expect(source('services/config.ts')).toContain("export const LOCAL_STACK = build.variant === 'local';");
  });

  test('ports that reach only the API take no word of the build: it follows no redirect on any', () => {
    // Connect's, pairing a phone's and Advanced's check ask only the API (net/http NO_HOPS)
    expect(block(source('services/runner.ts'), 'export function connectPorts(').includes('localStack')).toBe(false);
    expect(block(source('screens/Advanced.tsx'), 'checkAccount({').includes('localStack')).toBe(false);
    expect(source('screens/Scan.tsx')).not.toContain('localStack');
  });
});

describe('a request that is not a GET, redirected (the Fetch Standard, HTTP-redirect fetch)', () => {
  /** Each hop as asked: its method, address, body and Content-Type. */
  async function hops(method: string, status: number) {
    const w = web({ 'https://api.example/register': { status, location: '/registered' }, 'https://api.example/registered': { body: '{}' } });
    const init = { method, body: '{"v":1}', headers: { 'Content-Type': 'application/json', Authorization: 'Nostr x' } };
    const o = await open(w.f, 'https://api.example/register', init, 5_000, serverHops(false));
    o.done();
    return w.asked.map((a) => [a.init.method, a.url, a.init.body ?? null, new Headers(a.init.headers).get('content-type'), new Headers(a.init.headers).has('authorization')]);
  }

  test("a 303, or a 301 or 302 to a POST, is followed with a GET and without the body or what describes it", async () => {
    // sent again as it was, a POST to Kefli's API answered 303 went on as a POST, its body with it
    for (const [method, status] of [['POST', 303], ['PUT', 303], ['DELETE', 303], ['POST', 301], ['POST', 302]] as const) {
      expect([method, status, (await hops(method, status))[1]]).toEqual([method, status, ['GET', 'https://api.example/registered', null, null, true]]);
    }
  });

  test('a 307 or 308 keeps the method and body, and so does a 301 or 302 to anything but a POST', async () => {
    for (const [method, status] of [['POST', 307], ['POST', 308], ['PUT', 301], ['PUT', 302], ['DELETE', 302]] as const) {
      expect([method, status, (await hops(method, status))[1]]).toEqual([method, status, [method, 'https://api.example/registered', '{"v":1}', 'application/json', true]]);
    }
    // a GET or a HEAD answered 303 stays as it was
    expect((await hops('HEAD', 303))[1]).toEqual(['HEAD', 'https://api.example/registered', '{"v":1}', 'application/json', true]);
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
