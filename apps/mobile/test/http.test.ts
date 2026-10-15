import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { xEmbedUrl } from '@kefli/protocol';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { MAX_IMAGE_BYTES } from '../src/data/images';
import { SERVER_TIMEOUT_MS, movingMs, open, overHttps, serverFetch, serverHops, TimedOut, TooLarge } from '../src/net/http';
import { fetchImage, imageState, IMAGE_TIMEOUT_MS, type ImagePorts } from '../src/services/images';
import { fetchPage, PAGE_MAX_BYTES, PAGE_TIMEOUT_MS, type PagePorts } from '../src/services/page';
import { checkXPost, X_TIMEOUT_MS } from '../src/services/xpost';
import { memoryDb } from './sqlite';

const PK = 'ab'.repeat(32);
const HASH = '01'.repeat(32);
const CHUNK = 64 * 1024;

/** A body that sends one chunk and then nothing, as a server that answers and stalls. */
const stalled = () => new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new Uint8Array(10)) });
/** A body with no end and no declared length, as fast as it is read; pulls counts the chunks handed out. */
function endless() {
  const seen = { pulls: 0 };
  const stream = new ReadableStream<Uint8Array>({ pull: (c) => void (seen.pulls++, c.enqueue(new Uint8Array(CHUNK))) }, { highWaterMark: 0 });
  return { stream, seen };
}

type Call = { url: string; init: RequestInit };
/** A fetch that answers every address with what make gives, ignoring the abort signal, and records what it was asked. */
function recording(make: (url: string) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return make(url);
  }) as unknown as typeof fetch;
  return { f, calls };
}

const html = (body: BodyInit) => new Response(body, { headers: { 'content-type': 'text/html' } });
const pagePorts = (f: typeof fetch): PagePorts => ({ fetch: f, parse: async () => ({ ok: false, reason: 'x' }) });

function imagePorts(f: typeof fetch): ImagePorts {
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, 1, PK, 'new', true);
  db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'https://e.com/', 1, 'unread', 'cached', 'share')", PK, HASH);
  return { db, now: () => 1_000, fetch: f, nameOf: (u) => u.slice(-6), files: { write: (n) => `/img/${n}`, remove: () => undefined }, readArticle: () => null };
}

/** Whether p is still waiting after ms of fake time. */
async function settlesWithin<T>(p: Promise<T>, ms: number): Promise<T> {
  let out: { v: T } | null = null;
  p.then((v) => (out = { v }));
  await jest.advanceTimersByTimeAsync(ms);
  if (!out) throw new Error(`still pending after ${ms} ms`);
  return (out as { v: T }).v;
}

describe('every read from the open web has a deadline over its body and a streamed cap (F12)', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  test('a page that answers and then stalls is given up at 20 s, as the network being too slow', async () => {
    const { f, calls } = recording(() => html(stalled()));
    expect(await settlesWithin(fetchPage(pagePorts(f), 'https://slow.example/'), PAGE_TIMEOUT_MS + 1)).toEqual({ kind: 'offline', timedOut: true });
    expect(calls[0].init.signal!.aborted).toBe(true);
  });

  test('a fetch that never answers at all is given up at the same deadline, even one that ignores the abort', async () => {
    const { f } = recording(() => new Promise<Response>(() => undefined));
    expect(await settlesWithin(fetchPage(pagePorts(f), 'https://black.hole/'), PAGE_TIMEOUT_MS + 1)).toEqual({ kind: 'offline', timedOut: true });
  });

  test('an endless page with no declared length is refused at 5 MB as it streams', async () => {
    const { stream, seen } = endless();
    const { f } = recording(() => html(stream));
    expect(await settlesWithin(fetchPage(pagePorts(f), 'https://big.example/'), 1)).toMatchObject({ kind: 'failed', reason: 'too_large' });
    expect(seen.pulls * CHUNK).toBeLessThanOrEqual(PAGE_MAX_BYTES + 2 * CHUNK);
  });

  test("a stalled or endless image is that image's failure, so the next sync moves on to the others", async () => {
    const slow = imagePorts(recording(() => new Response(stalled())).f);
    expect(await settlesWithin(fetchImage(slow, PK, 'https://img.example/a.png', HASH), IMAGE_TIMEOUT_MS + 1)).toBe('failed');
    expect(imageState(slow.db, 'https://img.example/a.png', 1_000)).toBe('failed');
    const { stream, seen } = endless();
    const big = imagePorts(recording(() => new Response(stream)).f);
    expect(await settlesWithin(fetchImage(big, PK, 'https://img.example/b.png', HASH), 1)).toBe('failed');
    expect(seen.pulls * CHUNK).toBeLessThanOrEqual(MAX_IMAGE_BYTES + 2 * CHUNK);
  });

  test("X's embed service answering and then stalling is X failing, at 5 s", async () => {
    const { f } = recording(() => new Response(stalled(), { headers: { 'content-type': 'application/json' } }));
    expect(await settlesWithin(checkXPost({ fetch: f }, 'https://x.com/a/status/1'), X_TIMEOUT_MS + 1)).toEqual({ kind: 'xfail' });
  });
});

describe('no read sends or keeps cookies (F27)', () => {
  test('pages, images, X embeds and t.co hops all ask with credentials omitted', async () => {
    const post = 'https://x.com/a/status/1';
    const { f, calls } = recording((url) => {
      if (url === xEmbedUrl(post)) return new Response(JSON.stringify({ html: '<a href="https://t.co/z">x</a>' }));
      if (url === 'https://t.co/z') return new Response('', { status: 301, headers: { location: 'https://news.example/s' } });
      return html('<p>hi</p>');
    });
    await fetchPage(pagePorts(f), 'https://news.example/s');
    await fetchImage(imagePorts(f), PK, 'https://img.example/c.png', HASH);
    expect(await checkXPost({ fetch: f }, post)).toEqual({ kind: 'article', url: 'https://news.example/s' });
    // the post's t.co link, and the hop past it to see that it ends there
    expect(calls.map((c) => c.url)).toEqual(['https://news.example/s', 'https://img.example/c.png', xEmbedUrl(post), 'https://t.co/z', 'https://news.example/s']);
    for (const c of calls) expect(c.init.credentials).toBe('omit');
  });
});

describe('plain http, which release builds refuse (7.1)', () => {
  const words = (cause: string) => (async () => {
    throw new Error(`fetch failed: ${cause}`);
  }) as unknown as typeof fetch;

  test("OkHttp's refusal of cleartext is a failure of what was asked for; any other error is still the network", async () => {
    // as expo/fetch reports OkHttp's refusal, which comes before any connection
    const refused = words('java.net.UnknownServiceException: CLEARTEXT communication to g.example not permitted by network security policy');
    await expect(open(refused, 'http://g.example/', {}, 1_000)).rejects.toMatchObject({ name: 'Blocked', why: 'cleartext' });
    expect(await fetchPage(pagePorts(refused), 'http://g.example/')).toEqual({ kind: 'failed', reason: 'http', finalUrl: 'http://g.example/' });
    const offline = words('java.net.UnknownHostException: Unable to resolve host "g.example": No address associated with hostname');
    await expect(open(offline, 'https://g.example/', {}, 1_000)).rejects.toThrow('Unable to resolve host');
    expect(await fetchPage(pagePorts(offline), 'https://g.example/')).toEqual({ kind: 'offline' });
  });

  test('a public http address is asked for over https; a local one, or one with a port, keeps its http', () => {
    expect(overHttps('http://news.example/a?b=1#c')).toBe('https://news.example/a?b=1#c');
    expect(overHttps('HTTP://news.example/a')).toBe('https://news.example/a');
    expect(overHttps('http://user@news.example/a')).toBe('https://user@news.example/a');
    expect(overHttps('http://localhost:8080/a')).toBe('http://localhost:8080/a');
    expect(overHttps('http://192.168.1.1/')).toBe('http://192.168.1.1/');
    expect(overHttps('http://printer.local/')).toBe('http://printer.local/');
    expect(overHttps('http://news.example:8080/a')).toBe('http://news.example:8080/a');
    expect(overHttps('https://news.example/a')).toBe('https://news.example/a');
  });

  test("http's own port written out is no port: the address goes over https without it, as it would with none", async () => {
    // the URL parser drops a port of 80, leading zeros and all, and an empty one; kept, https would knock on port 80
    expect(overHttps('http://news.example:80/a?b=1#c')).toBe('https://news.example/a?b=1#c');
    expect(overHttps('HTTP://news.example:80')).toBe('https://news.example');
    expect(overHttps('http://user:pw@news.example:080/a')).toBe('https://user:pw@news.example/a');
    expect(overHttps('http://news.example:/a')).toBe('https://news.example/a');
    // an IPv6 host's colons are no port either
    expect(overHttps('http://[2606:4700::1111]/a')).toBe('https://[2606:4700::1111]/a');
    expect(overHttps('http://[2606:4700::1111]:80/a')).toBe('https://[2606:4700::1111]/a');
    // any other port, and a local address with http's own, keep their http
    for (const kept of ['http://news.example:8080/a', 'http://news.example:443/a', 'http://news.example:800/a', 'http://news.example:8/a',
      'http://localhost:80/a', 'http://[::1]:80/a', 'http://192.168.1.1:80/']) expect(overHttps(kept)).toBe(kept);
    // a share of such an address in a release build, which refuses plain http before it connects: its page is had
    // over https, where with :80 kept as a port it failed at once as cleartext
    const asked: string[] = [];
    const release = (async (url: string) => {
      asked.push(url);
      if (url.startsWith('http://')) throw new Error('fetch failed: java.net.UnknownServiceException: CLEARTEXT communication to news.example not permitted by network security policy');
      return Object.defineProperty(html('<p>x</p>'), 'url', { value: url });
    }) as unknown as typeof fetch;
    const parsed: PagePorts = { fetch: release, parse: async () => ({ ok: true, title: 'A story', byline: null, site: null, lang: 'en', hero: null, canonical: null, readerable: true, markdown: `${'word '.repeat(150)}\n` }) };
    expect(await fetchPage(parsed, overHttps('http://news.example:80/story'))).toMatchObject({ kind: 'parsed', finalUrl: 'https://news.example/story' });
    expect(asked).toEqual(['https://news.example/story']);
  });
});

describe("a server's answer, read whole before it is handed back (serverFetch)", () => {
  const ask = (maxBytes?: number) => ({ hops: serverHops(false), timeoutMs: 1_000, ...(maxBytes === undefined ? {} : { maxBytes }) });

  test('the status, headers and body as bytes, text or JSON, as often as asked; the body decoded as UTF-8', async () => {
    const { f, calls } = recording(() => new Response('{"error":"déjà","n":1}', { status: 403, headers: { 'X-Reason': 'blocked: déjà' } }));
    const res = await serverFetch(f, ask())(new URL('https://api.example/devices'), { method: 'POST', body: '{}' });
    expect([res.ok, res.status, res.headers.get('x-reason'), res.url]).toEqual([false, 403, 'blocked: déjà', 'https://api.example/devices']);
    expect(await res.json()).toEqual({ error: 'déjà', n: 1 });
    expect(await res.text()).toBe('{"error":"déjà","n":1}');
    // each read its own copy
    const bytes = new Uint8Array(await res.arrayBuffer());
    bytes[0] = 0;
    expect(new TextDecoder().decode(await res.arrayBuffer()).startsWith('{')).toBe(true);
    // asked without cookies and with redirect: 'manual', so each hop is checked here
    expect([calls[0].url, calls[0].init.method, calls[0].init.credentials, calls[0].init.redirect]).toEqual(['https://api.example/devices', 'POST', 'omit', 'manual']);
    // a Request's own method, headers and body would go unread: none is taken
    await expect(serverFetch(f, ask())(new Request('https://api.example/x'))).rejects.toThrow(TypeError);
  });

  test('a body past the cap fails only when read: the status and headers are still there', async () => {
    const { f } = recording(() => new Response('x'.repeat(100), { status: 200 }));
    const res = await serverFetch(f, ask(10))('https://blossom.example/abc', { method: 'DELETE' });
    expect([res.ok, res.status]).toEqual([true, 200]);
    await expect(res.text()).rejects.toBeInstanceOf(TooLarge);
    await expect(res.json()).rejects.toBeInstanceOf(TooLarge);
    // and one declared past it is never read at all
    const declared = await serverFetch(recording(() => new Response('x', { headers: { 'content-length': '1000000' } })).f, ask(10))('https://blossom.example/abc');
    await expect(declared.arrayBuffer()).rejects.toMatchObject({ bytes: 1_000_000 });
  });

  test("a server that never answers, or stalls its body, is let go at the deadline; a hop into the phone's network isn't asked", async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    try {
      const never = recording(() => new Promise<Response>(() => undefined));
      const p = serverFetch(never.f, ask())('https://api.example/account', { method: 'DELETE' });
      p.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(1_001);
      await expect(p).rejects.toBeInstanceOf(TimedOut);
      const trickle = recording(() => new Response(stalled()));
      const q = serverFetch(trickle.f, ask())('https://api.example/account');
      q.catch(() => undefined);
      await jest.advanceTimersByTimeAsync(1_001);
      await expect(q).rejects.toBeInstanceOf(TimedOut);
    } finally {
      jest.useRealTimers();
    }
    const inside = recording((url) => (url.startsWith('https://') ? new Response('', { status: 302, headers: { location: 'http://10.0.0.1/' } }) : new Response('{}')));
    await expect(serverFetch(inside.f, ask())('https://api.example/register', { method: 'POST' })).rejects.toMatchObject({ name: 'Blocked', why: 'redirect' });
    expect(inside.calls.map((c) => c.url)).toEqual(['https://api.example/register']);
  });

  test('an upload has a second more for every 32 KB it sends', () => {
    expect([movingMs(0), movingMs(1), movingMs(32_768), movingMs(32_769), movingMs(8_388_608)])
      .toEqual([SERVER_TIMEOUT_MS, SERVER_TIMEOUT_MS + 1_000, SERVER_TIMEOUT_MS + 1_000, SERVER_TIMEOUT_MS + 2_000, SERVER_TIMEOUT_MS + 256_000]);
  });
});

describe('open() against a real server', () => {
  let server: Server;
  let base = '';
  const closed: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      req.socket.on('close', () => closed.push(req.url!));
      res.writeHead(200, { 'content-type': 'text/html' });
      if (req.url === '/trickle') {
        const t = setInterval(() => res.write(' '), 20);
        res.on('close', () => clearInterval(t));
        return;
      }
      const flood = () => {
        while (res.write(Buffer.alloc(CHUNK)));
      };
      res.on('drain', flood);
      flood();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  /** Whether the server has seen the connection for path go, within two seconds. */
  const letGo = async (path: string) => {
    for (let i = 0; 40 > i && !closed.includes(path); i++) await new Promise((r) => setTimeout(r, 50));
    return closed.includes(path);
  };

  test('a trickling body times out and the connection is let go', async () => {
    const started = Date.now();
    await expect(open(fetch, `${base}/trickle`, {}, 1000).then((o) => o.read(PAGE_MAX_BYTES))).rejects.toBeInstanceOf(TimedOut);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await letGo('/trickle')).toBe(true);
  });

  test('a flood is refused at the cap and the connection is let go', async () => {
    await expect(open(fetch, `${base}/flood`, {}, 10_000).then((o) => o.read(1024 * 1024))).rejects.toBeInstanceOf(TooLarge);
    expect(await letGo('/flood')).toBe(true);
  });
});
