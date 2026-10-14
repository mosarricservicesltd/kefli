import { LocalSigner, encryptText, giftWrap, itemHash, wrapSaveRequest, type NostrEvent, type SaveRequest } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { absorbRecord } from '../src/data/devices';
import { browserName, INBOX_BLOB_LIFE, queueDeleteInboxBlob } from '../src/data/inbox';
import { enqueue } from '../src/data/outbox';
import { pendingParses } from '../src/data/pending';
import { INBOX_MAX_BYTES, INBOX_TIMEOUT_MS, drainInbox, judge, readBlob, type InboxPorts } from '../src/services/inbox';
import { GUARD_WORDS, type ParserResult } from '../src/services/page';
import { sendOne, type SendPorts } from '../src/services/send';
import { memoryDb } from './sqlite';

const D = { operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' }, mirrors: ['http://m1'], relays: ['ws://a'], indexer: ['ws://a'] };
const T0 = 1_800_000_000;
const TOKEN = 'ab'.repeat(32);
const WORDS = Array.from({ length: GUARD_WORDS + 10 }, (_, i) => `word${i}`).join(' ');

function world() {
  const db = memoryDb();
  migrate(db);
  const userSk = nodeCrypto.randomBytes(32);
  const user = new LocalSigner(userSk.slice());
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
  // what the operator answers for a blob it isn't serving: 404 once it has none (C§4.4, v1.12), or a failure of its own
  let missing = 404;
  const ports: InboxPorts = {
    db, now: () => clock, signer: user, crypto: nodeCrypto,
    query: async () => wraps,
    fetch: (async (url: string) => {
      const b = blobs.get(url);
      return b ? new Response(b as never) : new Response('', { status: missing });
    }) as never,
    // kefliMarkdown: the content HTML's heading, then the words; metadata comes from the request
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
    // the wrap dated by the test's clock too, not the real one (its created_at decides how long it is waited for, F3)
    const { wrap } = await wrapSaveRequest(from, owner, String(wraps.length), r as SaveRequest, clock, { now: clock });
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
  /** The blob deletes queued, one row per target. */
  const deletes = () => db.all<{ subject: string; payload: string; signer: string; lane: string; target: string }>(
    "SELECT o.subject, o.payload, o.signer, o.lane, t.target FROM outbox o JOIN outbox_targets t ON t.outbox_id = o.id WHERE o.op = 'delete_blob' ORDER BY o.id, t.target");
  const item = (hash: string) => db.get<{ text_state: string; title: string; origin: string; origin_device: string; state: string; saved_at: number }>(
    'SELECT text_state, title, origin, origin_device, state, saved_at FROM items WHERE owner = ? AND hash = ?', owner, hash);
  return {
    db, owner, user, userSk, device, ports, wraps, blobs, texts, request, send, withHtml, ops, deletes, item, parses: () => parses, tick: (s: number) => (clock += s),
    answerMissing: (status: number) => void (missing = status),
  };
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

  test('a save the signer can’t open out of sight waits for it, then arrives once it answers (F3)', async () => {
    const w = world();
    let refusing = true;
    const user = w.user;
    w.ports.signer = new Proxy(user, {
      get: (t, k) => (k === 'nip44Decrypt'
        ? (peer: string, c: string) => (refusing ? Promise.reject(Object.assign(new Error('background'), { code: 'background' })) : user.nip44Decrypt(peer, c))
        : Reflect.get(t, k)),
    });
    await w.send(w.request());
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    expect(w.db.get('SELECT 1 FROM inbox_seen')).toBeUndefined();
    expect(w.db.get("SELECT 1 FROM sync_cursors WHERE stream = 'inbox'")).toBeUndefined();
    refusing = false;
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
  });

  test('a key zeroed while the drain holds it leaves the wrap unrecorded for the next drain (F47, F3)', async () => {
    const w = world();
    await w.send(w.request());
    // the drain took the slot's key; the person comes back after five minutes away and the slot zeroes it mid-drain
    const held = new LocalSigner(w.userSk.slice());
    w.ports.signer = held;
    const query = w.ports.query;
    w.ports.query = async (relay, filters) => {
      held.zero();
      return query(relay, filters);
    };
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    expect(w.db.get('SELECT 1 FROM inbox_seen')).toBeUndefined();
    expect(w.db.get("SELECT 1 FROM sync_cursors WHERE stream = 'inbox'")).toBeUndefined();
    w.ports.signer = w.user;
    w.ports.query = query;
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
  });

  test('a wrap the signer still can’t open after a week is filed as not ours, so the cursor moves on (F3)', async () => {
    const w = world();
    w.ports.signer = new Proxy(w.user, {
      get: (t, k) => (k === 'nip44Decrypt' ? () => Promise.reject(Object.assign(new Error('timeout'), { code: 'timeout' })) : Reflect.get(t, k)),
    });
    await w.send(w.request());
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    w.tick(8 * 86_400);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_foreign: 1 });
    expect(w.db.get("SELECT 1 AS n FROM sync_cursors WHERE stream = 'inbox'")).toEqual({ n: 1 });
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
    const rumor = { kind: 30078, created_at: T0, tags: [['d', 'kefli/save-request/1']], content: '{nope', pubkey: w.device.pubkey(), id: '' };
    expect(judge(w.db, w.owner, rumor as never, { pubkey: w.device.pubkey() } as never, D.operator.blossom)).toEqual({ outcome: 'failed_parse' });
    w.db.run('UPDATE devices SET revoked_at = 5');
    await w.send(w.request());
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_token: 1 });
  });

  test("a blob that can't be read yet is tried again at each drain, then the page is fetched once it has expired", async () => {
    const w = world();
    // the operator failing (Caddy's answer while keflid restarts), not saying the blob is gone
    w.answerMissing(502);
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
    w2.answerMissing(503);
    const late = await w2.withHtml('<h1>Late</h1>', false);
    await w2.send(w2.request({ html: late.html }));
    expect(await drainInbox(w2.ports, w2.owner)).toEqual({ failed_blob: 1 });
    w2.tick(INBOX_BLOB_LIFE);
    expect(await drainInbox(w2.ports, w2.owner)).toEqual({ created: 1 });
    expect(w2.item(hash)?.text_state).toBe('queued');
  });

  test('a capture the operator answers 404 for is gone: its page is fetched at once, not after 14 days (C§4.4, v1.12)', async () => {
    const w = world();
    const gone = await w.withHtml('<h1>Gone</h1>', false);
    await w.send(w.request({ html: gone.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    const hash = itemHash('https://example.com/a');
    // waiting for its parse as a request without HTML does, which the runner starts straight after the drain
    expect(w.item(hash)).toMatchObject({ text_state: 'queued', title: 'From the browser', origin: 'browser', origin_device: 'Chrome on a Linux laptop' });
    expect(pendingParses(w.db, w.owner).map((p) => p.url)).toEqual(['https://example.com/a']);
    expect(w.parses()).toBe(0);
    // taken, not failed_blob: its wrap is deleted, and it isn't tried again
    expect(w.db.all('SELECT outcome, wrap_json FROM inbox_seen')).toEqual([{ outcome: 'created', wrap_json: null }]);
    expect(w.ops()).toContain('delete_wrap');
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
  });

  test('a blob that failed before and is then answered 404 is gone too, within its 14 days', async () => {
    const w = world();
    w.answerMissing(500);
    const blob = await w.withHtml('<h1>Lost</h1>', false);
    await w.send(w.request({ html: blob.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    w.tick(3_600);
    w.answerMissing(404);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('queued');
    expect(pendingParses(w.db, w.owner)).toHaveLength(1);
    expect(w.db.get("SELECT 1 AS n FROM inbox_seen WHERE outcome = 'failed_blob'")).toBeUndefined();
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
  });

  test('only a 404 says the blob is gone: every other failure is tried again, as before', async () => {
    const w = world();
    const enc = await encryptText('<h1>Checked</h1>', nodeCrypto);
    const html = { ...enc.text, server: D.operator.blossom };
    const at = `${D.operator.blossom}/${enc.text.sha256}`;
    for (const status of [400, 401, 403, 410, 429, 500, 502, 503, 507]) {
      w.answerMissing(status);
      expect([status, await readBlob(w.ports, html)]).toEqual([status, { kind: 'failed' }]);
    }
    w.answerMissing(404);
    expect(await readBlob(w.ports, html)).toEqual({ kind: 'gone' });
    // a blob that doesn't check out, served under its address
    w.blobs.set(at, (await encryptText('<h1>Another</h1>', nodeCrypto)).blob);
    expect(await readBlob(w.ports, html)).toEqual({ kind: 'failed' });
    w.blobs.set(at, enc.blob);
    expect(await readBlob(w.ports, html)).toEqual({ kind: 'html', html: '<h1>Checked</h1>' });
    // the network failing
    const served = w.ports.fetch;
    w.ports.fetch = (async () => {
      throw new TypeError('Network request failed');
    }) as never;
    expect(await readBlob(w.ports, html)).toEqual({ kind: 'failed' });
    // and through a drain: failed_blob, still fetching, no parse
    await w.send(w.request({ html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('fetching');
    expect(pendingParses(w.db, w.owner)).toEqual([]);
    w.ports.fetch = served;
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('cached');
  });

  test('a blob server that trickles, or never ends, lets go at the deadline or the cap (F12)', async () => {
    const MB = 1_048_576;
    const w = world();
    const blob = await w.withHtml('<h1>Slow</h1>', false);
    const pulled = { n: 0 };
    const endless = () => new ReadableStream<Uint8Array>({ pull: (c) => void (pulled.n++, c.enqueue(new Uint8Array(MB))) }, { highWaterMark: 0 });
    w.ports.fetch = (async () => new Response(endless(), { status: 200 })) as never;
    await w.send(w.request({ html: blob.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    expect(pulled.n).toBeLessThanOrEqual(INBOX_MAX_BYTES / MB + 2);

    jest.useFakeTimers();
    try {
      w.ports.fetch = (async () => new Response(new ReadableStream({ pull: () => new Promise(() => undefined) }), { status: 200 })) as never;
      const got = readBlob(w.ports, blob.html);
      await jest.advanceTimersByTimeAsync(INBOX_TIMEOUT_MS * 2);
      expect(await Promise.race([got, Promise.resolve('still waiting')])).toEqual({ kind: 'failed' });
    } finally {
      jest.useRealTimers();
    }
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

  test("with the wrap's kind 5, the request's inbox blob is deleted from Kefli's server with the user's key (C§4.4, v1.12)", async () => {
    const w = world();
    const { html } = await w.withHtml('<html><h1>Read later</h1><p>…</p></html>');
    await w.send(w.request({ html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.deletes()).toEqual([{ subject: html.sha256, payload: JSON.stringify({ sha256: html.sha256 }), signer: w.owner, lane: 'bulk', target: D.operator.blossom }]);
    expect(w.ops()).toEqual(expect.arrayContaining(['upload_blob', 'mirror_blob', 'publish_item', 'delete_wrap', 'delete_blob']));
    // the save's own text, under its own key, is uploaded and kept
    const own = w.db.get<{ text_sha256: string }>('SELECT text_sha256 FROM items')!.text_sha256;
    expect(own).not.toBe(html.sha256);
    expect(w.db.get("SELECT 1 AS n FROM outbox WHERE op = 'upload_blob' AND subject = ?", own)).toEqual({ n: 1 });
  });

  test('a repeat save, an un-archived one, an X post and a capture already gone delete theirs too', async () => {
    const w = world();
    const first = await w.withHtml('<h1>First</h1>');
    await w.send(w.request({ html: first.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    // matched: the save keeps its text, so the second capture isn't read, but it is deleted
    w.tick(100);
    const again = await w.withHtml('<h1>Again</h1>');
    await w.send(w.request({ captured_at: T0 + 50, html: again.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ merged: 1 });
    expect(w.parses()).toBe(1);
    w.db.run("UPDATE items SET state = 'archived'");
    w.tick(100);
    const back = await w.withHtml('<h1>Back</h1>');
    await w.send(w.request({ captured_at: T0 + 150, html: back.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ unarchived: 1 });
    // an X post's HTML is discarded (C§4.3); a capture the operator no longer has meets a 404, which counts as done
    const x = await w.withHtml('<h1>x</h1>');
    await w.send(w.request({ url: 'https://x.com/someone/status/123', html: x.html }));
    const gone = await w.withHtml('<h1>Gone</h1>', false);
    await w.send(w.request({ url: 'https://example.com/b', html: gone.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 2 });
    expect(w.parses()).toBe(1);
    expect(w.deletes().map((d) => d.subject).sort()).toEqual([first, again, back, x, gone].map((b) => b.html.sha256).sort());
    expect(new Set(w.deletes().map((d) => d.target))).toEqual(new Set([D.operator.blossom]));
  });

  test('the delete goes out signed by the user, and a 404 counts as done', async () => {
    const w = world();
    const one = await w.withHtml('<h1>One</h1>');
    const two = await w.withHtml('<h1>Two</h1>');
    await w.send(w.request({ html: one.html }));
    await w.send(w.request({ url: 'https://example.com/b', html: two.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 2 });
    // only the deletes left in the outbox, so each send is one of them
    w.db.run("DELETE FROM outbox WHERE op != 'delete_blob'");
    const calls: { method: string; url: string; auth: NostrEvent }[] = [];
    // the server answers the first 404 (the blob expired meanwhile) and the second 200
    const answers = [404, 200];
    const ports: SendPorts = {
      db: w.db, now: w.ports.now, signer: async (pk) => (pk === w.owner ? w.user : null), crypto: nodeCrypto,
      fetch: (async (url: string, init: RequestInit) => {
        const header = (init.headers as Record<string, string>).Authorization;
        calls.push({ method: String(init.method), url, auth: JSON.parse(Buffer.from(header.slice('Nostr '.length), 'base64').toString()) });
        return new Response('', { status: answers[calls.length - 1] });
      }) as never,
      defaults: () => ({ v: 1, ...D }),
      publish: async () => ({ ok: true }),
      readBlob: async () => null,
    };
    expect(await sendOne(ports)).toBe(true);
    expect(await sendOne(ports)).toBe(true);
    expect(await sendOne(ports)).toBe(false);
    expect(calls.map((c) => [c.method, c.url]).sort()).toEqual([one, two].map((b) => ['DELETE', `${D.operator.blossom}/${b.html.sha256}`]).sort());
    for (const c of calls) {
      expect(c.auth).toMatchObject({ kind: 24242, pubkey: w.owner });
      expect(c.auth.tags).toEqual(expect.arrayContaining([['t', 'delete'], ['x', c.url.split('/').pop()]]));
    }
    expect(w.db.get('SELECT COUNT(*) AS n FROM outbox')).toEqual({ n: 0 });
  });

  test('a wrap that is left, or whose blob fails, deletes nothing until it is taken', async () => {
    const w = world();
    const { html } = await w.withHtml('<h1>x</h1>');
    // an unknown token; a request naming another server, taken without its HTML; a blob the operator fails to serve
    await w.send(w.request({ token: 'cd'.repeat(32), html }));
    await w.send(w.request({ url: 'https://example.com/b', html: { ...html, server: 'http://elsewhere' } }));
    w.answerMissing(503);
    const later = await w.withHtml('<h1>Later</h1>', false);
    await w.send(w.request({ url: 'https://example.com/c', html: later.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_token: 1, created: 1, failed_blob: 1 });
    expect(w.deletes()).toEqual([]);
    // read at the next drain, its capture goes
    later.serve();
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.deletes().map((d) => d.subject)).toEqual([later.html.sha256]);
  });

  test("a request naming a save's own text, or no sha256 at all, deletes nothing (RULED)", async () => {
    const w = world();
    const { html } = await w.withHtml('<h1>Mine</h1>');
    await w.send(w.request({ html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    const own = w.db.get<{ text_sha256: string }>('SELECT text_sha256 FROM items')!.text_sha256;
    w.db.run("DELETE FROM outbox WHERE op = 'delete_blob'");
    // a faulty or hostile browser names the save's own text, for the same page and for another
    const forged = { ...html, sha256: own };
    w.tick(60);
    await w.send(w.request({ html: forged }));
    await w.send(w.request({ url: 'https://example.com/b', html: forged }));
    await w.send(w.request({ url: 'https://example.com/c', html: { ...html, sha256: '../account' } }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ merged: 1, created: 2 });
    expect(w.deletes()).toEqual([]);
    expect(w.ops().filter((o) => o === 'delete_wrap')).toHaveLength(4);
  });

  test("an inbox blob's delete leaves alone this phone's uploads and a delete already waiting", () => {
    const w = world();
    const staged = 'ef'.repeat(32);
    w.db.run("INSERT INTO blobs (sha256, hash, kind, staged_path, size, owner) VALUES (?, 'h', 'text', '/staged', 10, ?)", staged, w.owner);
    queueDeleteInboxBlob(w.db, T0, w.owner, staged, D.operator.blossom);
    expect(w.deletes()).toEqual([]);
    // a save's delete, to every server it named, keeps them all
    const waiting = '12'.repeat(32);
    enqueue(w.db, T0, { op: 'delete_blob', signer: w.owner, subject: waiting, payload: { sha256: waiting }, targets: [D.operator.blossom, D.mirrors[0]], lane: 'bulk' });
    queueDeleteInboxBlob(w.db, T0, w.owner, waiting, D.operator.blossom);
    expect(w.deletes().map((d) => d.target)).toEqual([D.operator.blossom, D.mirrors[0]]);
    for (const bad of [null, 42, {}, 'AB'.repeat(32), 'ab'.repeat(31)]) queueDeleteInboxBlob(w.db, T0, w.owner, bad, D.operator.blossom);
    expect(w.deletes()).toHaveLength(2);
    const capture = '34'.repeat(32);
    queueDeleteInboxBlob(w.db, T0, w.owner, capture, D.operator.blossom);
    expect(w.deletes().filter((d) => d.subject === capture)).toEqual([
      { subject: capture, payload: JSON.stringify({ sha256: capture }), signer: w.owner, lane: 'bulk', target: D.operator.blossom },
    ]);
  });

  test("the row names the browser by its brand", () => {
    expect(browserName('Chrome on a Windows laptop')).toBe('Chrome');
    expect(browserName('Firefox on a Mac')).toBe('Firefox');
    expect(browserName('Edge')).toBe('Edge');
  });
});

// Against server/dev's stack (relays with AUTH, the operator Blossom server):
//   KEFLI_LOCAL_STACK=1 npx jest -c apps/mobile/jest.config.js inbox
const local = process.env.KEFLI_LOCAL_STACK === '1' ? describe : describe.skip;
local('the inbox on the local stack', () => {
  test('a browser save sent through the operator relay and Blossom server arrives with its text', async () => {
    const { RelayPool } = await import('../src/net/pool');
    const { uploadBlob, verifyEventWith, nobleSecp } = await import('@kefli/protocol');
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
