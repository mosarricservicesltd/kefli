import { itemHash } from '@shelf/protocol';
import { nodeCrypto } from '@shelf/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, queueSave } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { pendingParses } from '../src/data/pending';
import { DESKTOP_UA, MOBILE_UA, PAGE_MAX_BYTES, fetchPage, refusal, type ParserResult } from '../src/services/page';
import { runPendingParses, type PendingPorts } from '../src/services/pending';
import { memoryDb } from './sqlite';

const PK = 'ab'.repeat(32);
const D = { v: 1, operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' }, relays: ['ws://a', 'ws://b'], indexer: ['ws://idx'], mirrors: ['http://m1'] };
const T = { api: D.operator.api, blossom: D.operator.blossom, mirror: D.mirrors[0] };
const LONG = Array.from({ length: 130 }, (_, i) => `word${i}`).join(' ');

type Page = { status?: number; type?: string; body?: string; finalUrl?: string; length?: number; only?: string };

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
        const res = new Response(pg.body ?? '<html></html>', { status: pg.status ?? 200, headers: { 'content-type': pg.type ?? 'text/html; charset=utf-8', ...(pg.length ? { 'content-length': String(pg.length) } : {}) } });
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

describe('pending parses (mobile spec 4.5 phase 7, 5.4)', () => {
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

  test("another phone's save without text keeps its address when parsed here", async () => {
    const w = world({ 'https://c.com/a': { finalUrl: 'https://c.com/b' } });
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, published, event_id) VALUES (?, ?, 'https://c.com/a', 10, 'unread', 'queued', 'sync', 1, 'e1')", PK, itemHash('https://c.com/a'));
    await runPendingParses(w.ports, PK);
    expect(w.db.get('SELECT hash, url, text_state FROM items')).toEqual({ hash: itemHash('https://c.com/a'), url: 'https://c.com/a', text_state: 'cached' });
  });
});
