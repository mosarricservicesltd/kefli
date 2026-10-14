import { itemHash, xEmbedUrl } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, queueSave } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { MAX_EMBED_LINKS, MAX_TCO, X_LINKS_MS, checkXPost, resolveTco, xRetryDelay, type XPorts } from '../src/services/xpost';
import { runPendingParses, type PendingPorts } from '../src/services/pending';
import { memoryDb } from './sqlite';

const POST = 'https://x.com/someone/status/1839655107733281247';
const embed = (links: string[]) => ({ html: `<blockquote>${links.map((l) => `<a href="${l}">x</a>`).join(' ')}</blockquote>` });

type Route = { status?: number; json?: unknown; location?: string; url?: string } | 'down' | 'slow';
function net(routes: Record<string, Route>): XPorts {
  return {
    fetch: (async (url: string) => {
      const r = routes[url];
      if (!r || r === 'down') throw new Error('offline');
      if (r === 'slow') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const res = new Response(r.json ? JSON.stringify(r.json) : '', { status: r.status ?? 200, headers: r.location ? { location: r.location } : {} });
      if (r.url) Object.defineProperty(res, 'url', { value: r.url });
      return res;
    }) as never,
  };
}

describe('X posts (mobile spec 5.4, FD 78, G3)', () => {
  test("a post's first link that leaves X, through t.co", async () => {
    const p = net({
      [xEmbedUrl(POST)]: { json: embed(['https://twitter.com/someone', 'https://t.co/abc']) },
      'https://t.co/abc': { status: 301, location: 'https://news.com/story' },
      'https://news.com/story': { url: 'https://news.com/story' },
    });
    expect(await checkXPost(p, POST)).toEqual({ kind: 'article', url: 'https://news.com/story' });
  });

  test('no article, an X Article, a refused post, X failing, offline', async () => {
    expect(await checkXPost(net({ [xEmbedUrl(POST)]: { json: embed(['https://x.com/a']) } }), POST)).toEqual({ kind: 'none', why: 'no-link' });
    expect(await checkXPost(net({ [xEmbedUrl(POST)]: { json: embed(['https://x.com/i/article/9']) } }), POST)).toEqual({ kind: 'none', why: 'article' });
    expect(await checkXPost(net({ [xEmbedUrl(POST)]: { status: 404 } }), POST)).toEqual({ kind: 'none', why: 'no-link' });
    expect(await checkXPost(net({ [xEmbedUrl(POST)]: { status: 503 } }), POST)).toEqual({ kind: 'xfail' });
    expect(await checkXPost(net({ [xEmbedUrl(POST)]: 'slow' }), POST)).toEqual({ kind: 'xfail' });
    expect(await checkXPost(net({ [xEmbedUrl(POST)]: { status: 200 } }), POST)).toEqual({ kind: 'xfail' });
    expect(await checkXPost(net({}), POST)).toEqual({ kind: 'offline' });
  });

  test('t.co is followed five hops at most, and a fetch that follows itself reports where it ended', async () => {
    const loop: Record<string, Route> = {};
    for (let i = 0; 10 > i; i++) loop[`https://t.co/${i}`] = { status: 302, location: `https://t.co/${i + 1}` };
    expect(await resolveTco(net(loop), 'https://t.co/0')).toBe('https://t.co/5');
    expect(await resolveTco(net({ 'https://t.co/z': { url: 'https://end.com/' } }), 'https://t.co/z')).toBe('https://end.com/');
  });

  test('at most 20 t.co links are followed: an embed of hundreds that lead back to X ends with nothing', async () => {
    const asked: string[] = [];
    const routes: Record<string, Route> = {};
    const links = Array.from({ length: 300 }, (_, i) => `https://t.co/${i}`);
    for (const l of links) routes[l] = { status: 301, location: 'https://x.com/someone' };
    routes['https://x.com/someone'] = { url: 'https://x.com/someone' };
    routes[xEmbedUrl(POST)] = { json: embed(links) };
    const p = net(routes);
    const counting: XPorts = { fetch: ((url: string, init?: RequestInit) => (asked.push(url), p.fetch(url, init))) as never };
    expect(await checkXPost(counting, POST)).toEqual({ kind: 'none', why: 'no-link' });
    expect(asked.filter((u) => u.startsWith('https://t.co/'))).toHaveLength(MAX_TCO);
    routes[xEmbedUrl(POST)] = { json: embed([...links.slice(0, 5), 'https://t.co/news']) };
    routes['https://t.co/news'] = { status: 301, location: 'https://news.com/story' };
    routes['https://news.com/story'] = { url: 'https://news.com/story' };
    expect(await checkXPost(net(routes), POST)).toEqual({ kind: 'article', url: 'https://news.com/story' });
  });

  test('only the first 200 of an embed’s links are looked at: 5,000 X links before the article find none', async () => {
    const xs = Array.from({ length: 5_000 }, (_, i) => `https://twitter.com/hashtag/t${i}`);
    const routes: Record<string, Route> = {
      [xEmbedUrl(POST)]: { json: embed([...xs, 'https://news.com/story']) },
    };
    const t = Date.now();
    expect(await checkXPost(net(routes), POST)).toEqual({ kind: 'none', why: 'no-link' });
    expect(Date.now() - t).toBeLessThan(5_000);
    routes[xEmbedUrl(POST)] = { json: embed([...xs.slice(0, MAX_EMBED_LINKS - 1), 'https://news.com/story']) };
    expect(await checkXPost(net(routes), POST)).toEqual({ kind: 'article', url: 'https://news.com/story' });
  });

  test('t.co links that take too long together leave the post waiting, as X failing does', async () => {
    let clock = 0;
    const routes: Record<string, Route> = { [xEmbedUrl(POST)]: { json: embed(Array.from({ length: 10 }, (_, i) => `https://t.co/${i}`)) } };
    const slow: XPorts = {
      fetch: (async (url: string) => {
        if (url.startsWith('https://t.co/')) {
          clock += 4_000; // each hop answers just inside its own 5 s, on a chain that never ends
          return new Response('', { status: 302, headers: { location: `${url}x` } });
        }
        return net(routes).fetch(url);
      }) as never,
    };
    expect(await checkXPost(slow, POST, () => clock)).toEqual({ kind: 'xfail' });
    expect(clock).toBeLessThanOrEqual(X_LINKS_MS + 4_000);
  });

  test('a t.co link is never followed to a private address, nor saved from one', async () => {
    const asked: string[] = [];
    const routes: Record<string, Route> = {
      [xEmbedUrl(POST)]: { json: embed(['https://t.co/lan', 'https://t.co/wide', 'https://t.co/news']) },
      'https://t.co/lan': { status: 302, location: 'http://192.168.1.1/cgi-bin/reboot' },
      'https://t.co/wide': { status: 302, location: 'http://１２７.０.０.１:8080/' },
      'https://t.co/news': { status: 301, location: 'https://news.com/story' },
      'https://news.com/story': { url: 'https://news.com/story' },
    };
    const p = net(routes);
    const counting: XPorts = { fetch: ((url: string, init?: RequestInit) => (asked.push(url), p.fetch(url, init))) as never };
    expect(await checkXPost(counting, POST)).toEqual({ kind: 'article', url: 'https://news.com/story' });
    expect(asked.some((u) => /192\.168|127|１２７/.test(u))).toBe(false);
    await expect(resolveTco(net({ 'https://t.co/z': { url: 'http://localhost/' } }), 'https://t.co/z')).rejects.toThrow('not a public address');
  });

  test('X failing is tried again from 30 s, doubling to an hour', () => {
    expect([1, 2, 3, 7, 8, 20].map(xRetryDelay)).toEqual([30, 60, 120, 1920, 3600, 3600]);
  });

  test('a waiting post whose article address is too long to publish keeps the post’s address (C§3.3)', async () => {
    const db = memoryDb();
    migrate(db);
    const PK = 'ab'.repeat(32);
    ensureIdentityRow(db, 1, PK, 'new', true);
    const T = { api: 'http://api', blossom: 'http://b', mirror: 'http://m' };
    const A = 'https://x.com/a/status/1';
    queueSave(db, 1, { owner: PK, hash: itemHash(A), url: A, canonical: null, title: null, site: null, byline: null, savedAt: 1, words: null,
      lang: null, hero: null, text: null, textHash: null, textState: 'queued', sharedUrl: A, origin: 'share', xState: 'pending' }, null, T);
    const far = `https://news.com/a?${'x'.repeat(12_000)}`;
    const asked: string[] = [];
    const ports: PendingPorts = {
      db, now: () => 9,
      x: net({ [xEmbedUrl(A)]: { json: embed([far]) } }),
      page: {
        fetch: (async (url: string) => (asked.push(url), Object.defineProperty(new Response('<p/>', { status: 404, headers: { 'content-type': 'text/html' } }), 'url', { value: url }))) as never,
        parse: async () => ({ ok: false, reason: 'not_readable' }),
      },
      crypto: nodeCrypto, stage: (sha) => `/s/${sha}`, unstage: () => undefined, writeText: () => undefined, targets: async () => T,
    };
    await runPendingParses(ports, PK);
    expect(asked).toEqual([A]);
    expect(db.get('SELECT hash, url, x_state, text_state FROM items')).toEqual({ hash: itemHash(A), url: A, x_state: 'none', text_state: 'failed' });
  });

  test('a waiting post: its article re-keys the save; no article fails it; X failing leaves it waiting', async () => {
    const db = memoryDb();
    migrate(db);
    const PK = 'ab'.repeat(32);
    ensureIdentityRow(db, 1, PK, 'new', true);
    const D = { operator: { relay: 'ws://op', blossom: 'http://b', api: 'http://api' }, relays: ['ws://a'], indexer: [], mirrors: ['http://m'] };
    seedGeneratedLists(db, PK, D);
    const T = { api: 'http://api', blossom: 'http://b', mirror: 'http://m' };
    const post = (url: string) => queueSave(db, 1, { owner: PK, hash: itemHash(url), url, canonical: null, title: null, site: null, byline: null, savedAt: 1, words: null,
      lang: null, hero: null, text: null, textHash: null, textState: 'queued', sharedUrl: url, origin: 'share', xState: 'pending' }, null, T);
    const A = 'https://x.com/a/status/1';
    const B = 'https://x.com/b/status/2';
    const C = 'https://x.com/c/status/3';
    post(A);
    post(B);
    post(C);
    const words = Array.from({ length: 130 }, (_, i) => `w${i}`).join(' ');
    const ports: PendingPorts = {
      db, now: () => 9,
      x: net({
        [xEmbedUrl(A)]: { json: embed(['https://news.com/a']) },
        [xEmbedUrl(B)]: { json: embed([]) },
        [xEmbedUrl(C)]: { status: 500 },
      }),
      page: {
        fetch: (async (url: string) => Object.defineProperty(new Response('<p/>', { headers: { 'content-type': 'text/html' } }), 'url', { value: url })) as never,
        parse: async () => ({ ok: true, title: 'News', byline: null, site: null, lang: null, hero: null, canonical: null, readerable: true, markdown: `${words}\n` }),
      },
      crypto: nodeCrypto, stage: (sha) => `/s/${sha}`, unstage: () => undefined, writeText: () => undefined, targets: async () => T,
    };
    expect(await runPendingParses(ports, PK)).toEqual({ parsed: 1, failed: 1, waiting: 0, xWaiting: 1 });
    const rows = db.all<{ hash: string; url: string; text_state: string; fail_reason: string | null; x_state: string | null; shared_url: string }>('SELECT hash, url, text_state, fail_reason, x_state, shared_url FROM items ORDER BY id');
    expect(rows).toEqual([
      { hash: itemHash('https://news.com/a'), url: 'https://news.com/a', text_state: 'cached', fail_reason: null, x_state: null, shared_url: A },
      { hash: itemHash(B), url: B, text_state: 'failed', fail_reason: 'x_no_article', x_state: 'none', shared_url: B },
      { hash: itemHash(C), url: C, text_state: 'queued', fail_reason: null, x_state: 'pending', shared_url: C },
    ]);
  });
});
