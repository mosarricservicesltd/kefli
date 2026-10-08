import { LocalSigner, encryptText, giftWrap, itemHash, wrapSaveRequest, type NostrEvent, type SaveRequest } from '@shelf/protocol';
import { nodeCrypto } from '@shelf/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { absorbRecord } from '../src/data/devices';
import { browserName, INBOX_BLOB_LIFE } from '../src/data/inbox';
import { pendingParses } from '../src/data/pending';
import { drainInbox, judge, type InboxPorts } from '../src/services/inbox';
import { GUARD_WORDS, type ParserResult } from '../src/services/page';
import { memoryDb } from './sqlite';

const D = { operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' }, mirrors: ['http://m1'], relays: ['ws://a'], indexer: ['ws://a'] };
const T0 = 1_800_000_000;
const TOKEN = 'ab'.repeat(32);
const WORDS = Array.from({ length: GUARD_WORDS + 10 }, (_, i) => `word${i}`).join(' ');

function world() {
  const db = memoryDb();
  migrate(db);
  const user = new LocalSigner(nodeCrypto.randomBytes(32));
  const device = new LocalSigner(nodeCrypto.randomBytes(32));
  const owner = user.pubkey();
  ensureIdentityRow(db, T0, owner, 'new', true);
  seedGeneratedLists(db, owner, D);
  db.run('UPDATE identities SET registered_at = 1 WHERE pubkey = ?', owner);
  absorbRecord(db, owner, { v: 1, devices: [{ device_pubkey: device.pubkey(), label: 'Chrome on a Linux laptop', token: TOKEN, connected_at: 1, revoked_at: null }] }, 'rec', 1);
  let clock = T0;
  const wraps: NostrEvent[] = [];
  const blobs = new Map<string, Uint8Array>();
  const texts = new Map<string, string>();
  let parses = 0;
  const ports: InboxPorts = {
    db, now: () => clock, signer: user, crypto: nodeCrypto,
    query: async () => wraps,
    fetch: (async (url: string) => {
      const b = blobs.get(url);
      return b ? new Response(b as never) : new Response('', { status: 404 });
    }) as never,
    // shelfMarkdown: the content HTML's heading, then the words; metadata comes from the request
    markdown: async (html): Promise<ParserResult> => {
      parses++;
      const h1 = /<h1>(.*?)<\/h1>/.exec(html)?.[1] ?? '';
      return { ok: true, title: null, byline: null, site: null, lang: null, hero: null, canonical: null, readerable: true, markdown: `# ${h1}\n\n${WORDS}` };
    },
    defaults: async () => D,
    stage: (sha) => `/staged/${sha}`,
    unstage: () => undefined,
    writeText: (hash, md) => void texts.set(hash, md),
    targets: async () => ({ api: D.operator.api, blossom: D.operator.blossom, mirror: D.mirrors[0] }),
  };
  const request = (over: Partial<SaveRequest> = {}): SaveRequest => ({
    v: 1, url: 'https://example.com/a', canonical: null, title: 'From the browser', site: 'example.com', byline: null, lang: 'en', hero: null,
    captured_at: T0 - 60, token: TOKEN, html: null, ...over,
  });
  const send = async (r: SaveRequest | Record<string, unknown>, from: LocalSigner = device) => {
    const { wrap } = await wrapSaveRequest(from, owner, String(wraps.length), r as SaveRequest, clock);
    wraps.push(wrap);
    return wrap.id;
  };
  /** The extension's inbox blob: the HTML encrypted and served by the operator. */
  const withHtml = async (html: string, served = true) => {
    const enc = await encryptText(html, nodeCrypto);
    if (served) blobs.set(`${D.operator.blossom}/${enc.text.sha256}`, enc.blob);
    return { html: { ...enc.text, server: D.operator.blossom }, serve: () => blobs.set(`${D.operator.blossom}/${enc.text.sha256}`, enc.blob) };
  };
  const ops = () => db.all<{ op: string; subject: string }>('SELECT op, subject FROM outbox ORDER BY id').map((r) => r.op);
  const item = (hash: string) => db.get<{ text_state: string; title: string; origin: string; origin_device: string; state: string; saved_at: number }>(
    'SELECT text_state, title, origin, origin_device, state, saved_at FROM items WHERE owner = ? AND hash = ?', owner, hash);
  return { db, owner, user, device, ports, wraps, texts, request, send, withHtml, ops, item, parses: () => parses, tick: (s: number) => (clock += s) };
}

describe('the inbox (mobile spec 4.7, contract 4.4)', () => {
  test("a browser save with its HTML becomes a save with the phone's own text, and its wrap is deleted", async () => {
    const w = world();
    const { html } = await w.withHtml('<html><h1>Read later</h1><p>…</p></html>');
    const id = await w.send(w.request({ html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    const hash = itemHash('https://example.com/a');
    expect(w.item(hash)).toMatchObject({ text_state: 'cached', title: 'From the browser', origin: 'browser', origin_device: 'Chrome on a Linux laptop', saved_at: T0 - 60 });
    expect(w.texts.get(hash)).toContain('# Read later');
    expect(w.ops()).toEqual(expect.arrayContaining(['upload_blob', 'mirror_blob', 'publish_item', 'publish_lists', 'delete_wrap']));
    expect(w.db.get('SELECT payload FROM outbox WHERE op = ?', 'delete_wrap')).toEqual({ payload: JSON.stringify({ id }) });
    // seen once: a second drain does nothing
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    expect(w.parses()).toBe(1);
  });

  test('without HTML, or for an X post, the save waits for its parse as a share does', async () => {
    const w = world();
    const { html } = await w.withHtml('<h1>x</h1>');
    await w.send(w.request());
    await w.send(w.request({ url: 'https://x.com/someone/status/123', html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 2 });
    expect(pendingParses(w.db, w.owner).map((p) => [p.url, p.x_state]).sort()).toEqual([
      ['https://example.com/a', null],
      ['https://x.com/someone/status/123', 'pending'],
    ]);
    expect(w.parses()).toBe(0);
  });

  test("other apps' messages, unknown tokens, other keys and other versions are left alone", async () => {
    const w = world();
    const stranger = new LocalSigner(nodeCrypto.randomBytes(32));
    const { wrap: dm } = await giftWrap(stranger, w.owner, { kind: 14, created_at: T0, tags: [], content: 'hello' });
    w.wraps.push(dm);
    await w.send(w.request({ token: 'cd'.repeat(32) }));
    await w.send(w.request(), stranger);
    await w.send({ ...w.request(), v: 2 });
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_foreign: 1, ignored_token: 2, ignored_version: 1 });
    expect(w.ops()).toEqual([]);
    expect(w.db.get('SELECT COUNT(*) AS n FROM items')).toEqual({ n: 0 });
  });

  test('unreadable JSON is failed_parse; a disconnected browser is ignored', async () => {
    const w = world();
    const rumor = { kind: 30078, created_at: T0, tags: [['d', 'shelf/save-request/1']], content: '{nope', pubkey: w.device.pubkey(), id: '' };
    expect(judge(w.db, w.owner, rumor as never, { pubkey: w.device.pubkey() } as never, D.operator.blossom)).toEqual({ outcome: 'failed_parse' });
    w.db.run('UPDATE devices SET revoked_at = 5');
    await w.send(w.request());
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_token: 1 });
  });

  test("a blob that can't be read is tried again at each drain, then the page is fetched once it has expired", async () => {
    const w = world();
    const blob = await w.withHtml('<h1>Later</h1>', false);
    await w.send(w.request({ html: blob.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    const hash = itemHash('https://example.com/a');
    expect(w.item(hash)?.text_state).toBe('fetching');
    expect(pendingParses(w.db, w.owner)).toEqual([]);
    expect(w.ops()).not.toContain('delete_wrap');
    // the blob comes back: the next drain makes the save
    blob.serve();
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(hash)?.text_state).toBe('cached');
    expect(w.ops()).toContain('delete_wrap');

    const w2 = world();
    const gone = await w2.withHtml('<h1>Gone</h1>', false);
    await w2.send(w2.request({ html: gone.html }));
    await drainInbox(w2.ports, w2.owner);
    w2.tick(INBOX_BLOB_LIFE);
    expect(await drainInbox(w2.ports, w2.owner)).toEqual({ created: 1 });
    expect(w2.item(hash)?.text_state).toBe('queued');
  });

  test('a request naming another server is taken without its HTML', async () => {
    const w = world();
    const { html } = await w.withHtml('<h1>x</h1>');
    await w.send(w.request({ html: { ...html, server: 'http://elsewhere' } }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('queued');
  });

  test('a save already here is un-archived, or matched and left as it is (the repeat-save rule)', async () => {
    const w = world();
    await w.send(w.request());
    await drainInbox(w.ports, w.owner);
    const hash = itemHash('https://example.com/a');
    w.tick(100);
    await w.send(w.request({ captured_at: T0 + 50 }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ merged: 1 });
    w.db.run("UPDATE items SET state = 'archived'");
    w.tick(100);
    await w.send(w.request({ captured_at: T0 + 150 }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ unarchived: 1 });
    expect(w.item(hash)).toMatchObject({ state: 'unread', saved_at: T0 + 150 });
    expect(w.ops().filter((o) => o === 'delete_wrap')).toHaveLength(3);
  });

  test("the row names the browser by its brand", () => {
    expect(browserName('Chrome on a Windows laptop')).toBe('Chrome');
    expect(browserName('Firefox on a Mac')).toBe('Firefox');
    expect(browserName('Edge')).toBe('Edge');
  });
});

// Against server/dev's stack (relays with AUTH, the operator Blossom server):
//   SHELF_LOCAL_STACK=1 npx jest -c apps/mobile/jest.config.js inbox
const local = process.env.SHELF_LOCAL_STACK === '1' ? describe : describe.skip;
local('the inbox on the local stack', () => {
  test('a browser save sent through the operator relay and Blossom server arrives with its text', async () => {
    const { RelayPool } = await import('../src/net/pool');
    const { uploadBlob, verifyEventWith, nobleSecp } = await import('@shelf/protocol');
    const w = world();
    const live = { relay: 'ws://localhost:7447', blossom: 'http://localhost:3447' };
    const pool = new RelayPool({ verify: (e) => verifyEventWith(nobleSecp, e), signer: async () => w.user, allowInsecure: true });
    const enc = await encryptText('<html><h1>Over the wire</h1><p>…</p></html>', nodeCrypto);
    expect((await uploadBlob(live.blossom, enc.blob, enc.text.sha256, w.device)).ok).toBe(true);
    const r = w.request({ captured_at: Math.floor(Date.now() / 1000), html: { ...enc.text, server: live.blossom } });
    const { wrap } = await wrapSaveRequest(w.device, w.owner, 'live', r, Math.floor(Date.now() / 1000));
    expect(await pool.publish(live.relay, wrap)).toEqual({ ok: true });
    const out = await drainInbox({
      ...w.ports, now: () => Math.floor(Date.now() / 1000), fetch: globalThis.fetch,
      query: (url, f) => pool.query(url, f as never),
      defaults: async () => ({ operator: { relay: live.relay, blossom: live.blossom } }),
    }, w.owner);
    pool.close();
    expect(out).toEqual({ created: 1 });
    expect(w.item(itemHash('https://example.com/a'))).toMatchObject({ text_state: 'cached', title: 'From the browser' });
    expect(w.texts.get(itemHash('https://example.com/a'))).toContain('# Over the wire');
  }, 20_000);
});
