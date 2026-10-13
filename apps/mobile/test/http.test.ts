import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { xEmbedUrl } from '@kefli/protocol';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { MAX_IMAGE_BYTES } from '../src/data/images';
import { open, TimedOut, TooLarge } from '../src/net/http';
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
