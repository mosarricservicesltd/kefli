import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { MAX_IMAGE_BYTES, evictions, getImage, keptArticles, needsFetch, recordImage, wanted } from '../src/data/images';
import { imageKind, imageSize } from '../src/reader/imageSize';
import { articleImages, fetchArticleImages, fetchImage, imageState, removeImages, syncImages, type ImagePorts } from '../src/services/images';
import { memoryDb } from './sqlite';

const PK = 'ab'.repeat(32);
const h = (n: number) => n.toString(16).padStart(64, '0');

const png = (w: number, hh: number) => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, hh);
  return b;
};
const gif = (w: number, hh: number) => new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, w & 255, w >> 8, hh & 255, hh >> 8]);
const jpeg = (w: number, hh: number) => new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, // APP0, length 4
  0xff, 0xc4, 0x00, 0x03, 0x00, // a DHT segment, not a frame
  0xff, 0xc0, 0x00, 0x11, 0x08, hh >> 8, hh & 255, w >> 8, w & 255, 0x03, 0, 0, 0, 0,
]);
const webp = (w: number, hh: number) => {
  const b = new Uint8Array(30);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8);
  b.set([(w - 1) & 255, ((w - 1) >> 8) & 255, 0, (hh - 1) & 255, ((hh - 1) >> 8) & 255, 0], 24);
  return b;
};

function world() {
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, 1, PK, 'new', true);
  let clock = 1_000_000;
  const files = new Map<string, Uint8Array>();
  const texts = new Map<string, string>();
  const served = new Map<string, Response | 'down'>();
  const add = (n: number, state = 'unread', saved = n) =>
    db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, ?, ?, ?, 'cached', 'share')", PK, h(n), `https://e.com/${n}`, saved, state);
  const ports: ImagePorts = {
    db, now: () => clock,
    fetch: (async (url: string) => {
      const r = served.get(url);
      if (!r || r === 'down') throw new Error('offline');
      return r.clone();
    }) as never,
    nameOf: (url) => `img-${url.length}-${url.slice(-6)}`,
    files: { write: (name, bytes) => (files.set(`/img/${name}`, bytes), `/img/${name}`), remove: (path) => { files.delete(path); } },
    readArticle: (hash) => (texts.has(hash) ? { blocks: articleImages(texts.get(hash)!).map((src) => ({ kind: 'img', src })) } : null),
  };
  return { db, ports, files, texts, served, add, tick: (s: number) => (clock += s), now: () => clock };
}

describe('article images (mobile spec 4.5 phase 6, 5.6)', () => {
  test('sizes from the first bytes of each format', () => {
    expect(imageSize(png(720, 480))).toEqual({ w: 720, h: 480 });
    expect(imageSize(gif(64, 32))).toEqual({ w: 64, h: 32 });
    expect(imageSize(jpeg(1200, 800))).toEqual({ w: 1200, h: 800 });
    expect(imageSize(webp(300, 200))).toEqual({ w: 300, h: 200 });
    expect(imageKind(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBeNull();
    expect(imageSize(png(0, 10))).toBeNull();
  });

  test("an article's images, in reading order, once each", () => {
    expect(articleImages('![a](https://e.com/1.png)\n\nText.\n\n![b](https://e.com/2.png)\n\n![a again](https://e.com/1.png)\n')).toEqual(['https://e.com/1.png', 'https://e.com/2.png']);
  });

  test('an image is fetched, sized and kept; a failure is tried again after a day', async () => {
    const w = world();
    w.add(1);
    w.served.set('https://e.com/a.png', new Response(png(720, 480) as never));
    expect(await fetchImage(w.ports, PK, 'https://e.com/a.png', h(1))).toBe('ok');
    expect(getImage(w.db, 'https://e.com/a.png')).toMatchObject({ hash: h(1), bytes: 24, w: 720, h: 480 });
    expect(imageState(w.db, 'https://e.com/a.png', w.now())).toBe('here');

    w.served.set('https://e.com/x.svg', new Response('<svg/>'));
    expect(await fetchImage(w.ports, PK, 'https://e.com/x.svg', h(1))).toBe('failed');
    expect(imageState(w.db, 'https://e.com/x.svg', w.now())).toBe('failed');
    w.tick(86_400);
    expect(needsFetch(getImage(w.db, 'https://e.com/x.svg'), w.now())).toBe(true);

    w.served.set('https://e.com/big.png', new Response(png(1, 1) as never, { headers: { 'content-length': String(MAX_IMAGE_BYTES + 1) } }));
    expect(await fetchImage(w.ports, PK, 'https://e.com/big.png', h(1))).toBe('failed');
    w.served.set('https://e.com/404.png', new Response('', { status: 404 }));
    expect(await fetchImage(w.ports, PK, 'https://e.com/404.png', h(1))).toBe('failed');
    expect(await fetchImage(w.ports, PK, 'https://e.com/down.png', h(1))).toBe('offline');
    expect(imageState(w.db, 'https://e.com/down.png', w.now())).toBe('waiting');
    expect(await fetchImage(w.ports, PK, 'data:image/png;base64,AAAA', h(1))).toBe('skipped');
  });

  test('phase 6 fetches the newest unread articles, stopping when the network goes', async () => {
    const w = world();
    w.add(1);
    w.add(2);
    w.add(3, 'archived');
    for (const n of [1, 2, 3]) w.texts.set(h(n), `![p](https://e.com/${n}.png)\n`);
    w.served.set('https://e.com/1.png', new Response(png(10, 10) as never));
    w.served.set('https://e.com/2.png', 'down');
    expect(keptArticles(w.db, PK)).toEqual([h(2), h(1)]);
    expect(wanted(w.db, keptArticles(w.db, PK), (x) => [`https://e.com/${parseInt(x, 16)}.png`], w.now()).map((x) => x.url)).toEqual(['https://e.com/2.png', 'https://e.com/1.png']);
    expect(await syncImages(w.ports, PK)).toBe(0);
    w.served.set('https://e.com/2.png', new Response(png(10, 10) as never));
    expect(await syncImages(w.ports, PK)).toBe(2);
    // an archived article's images come only when it opens
    w.served.set('https://e.com/3.png', new Response(gif(5, 5) as never));
    expect(await fetchArticleImages(w.ports, PK, h(3))).toBe(1);
  });

  test("over budget, archived articles' images go first, never the open article's", () => {
    const w = world();
    w.add(1);
    w.add(2, 'archived');
    recordImage(w.db, 'u1', h(1), '/img/1', 100, 1, 1, 5);
    recordImage(w.db, 'u2', h(2), '/img/2', 100, 1, 1, 9);
    recordImage(w.db, 'u3', h(9), '/img/3', 100, 1, 1, 1);
    expect(evictions(w.db, PK, 50, null, 400)).toEqual([]);
    expect(evictions(w.db, PK, 150, null, 400).map((r) => r.url)).toEqual(['u3']);
    expect(evictions(w.db, PK, 250, null, 400).map((r) => r.url)).toEqual(['u3', 'u2']);
    expect(evictions(w.db, PK, 350, h(1), 400).map((r) => r.url)).toEqual(['u3', 'u2']);
  });

  test("an article's images go with it", async () => {
    const w = world();
    w.add(1);
    w.served.set('https://e.com/a.png', new Response(png(2, 2) as never));
    await fetchImage(w.ports, PK, 'https://e.com/a.png', h(1));
    expect(w.files.size).toBe(1);
    removeImages(w.ports, h(1));
    expect(w.files.size).toBe(0);
    expect(getImage(w.db, 'https://e.com/a.png')).toBeUndefined();
  });
});
