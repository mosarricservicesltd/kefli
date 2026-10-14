import { LocalSigner, encryptText, giftWrap, itemHash, makeRumor, wrapSaveRequest, type NostrEvent, type SaveRequest } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { absorbRecord } from '../src/data/devices';
import { SEEN_KEEP, browserName, INBOX_BLOB_LIFE } from '../src/data/inbox';
import { pendingParses } from '../src/data/pending';
import {
  INBOX_DEEP_EVERY, INBOX_MAX_BYTES, INBOX_TIMEOUT_MS, INBOX_UNWRAPS, drainInbox, judge, readBlob, type InboxPorts,
} from '../src/services/inbox';
import { GUARD_WORDS, type ParserResult } from '../src/services/page';
import type { Filter } from '../src/services/sync';
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
  const ports: InboxPorts = {
    db, now: () => clock, signer: user, crypto: nodeCrypto,
    query: async () => wraps,
    fetch: (async (url: string) => {
      const b = blobs.get(url);
      return b ? new Response(b as never) : new Response('', { status: 404 });
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
  /** A wrap anyone could send, whose content decrypts to sealJson exactly as given. */
  const sendRawSeal = (sealJson: string, createdAt = clock) => {
    const k = generateSecretKey();
    const wrap = finalizeEvent({ kind: 1059, created_at: createdAt, tags: [['p', owner]], content: nip44.encrypt(sealJson, nip44.utils.getConversationKey(k, owner)) }, k);
    wraps.push(wrap as NostrEvent);
    return wrap.id;
  };
  /** A wrap whose seal, signed by the device, holds rumorJson exactly as given. */
  const sendRawRumor = async (rumorJson: string) =>
    sendRawSeal(JSON.stringify(await device.signEvent({ kind: 13, created_at: clock, tags: [], content: await device.nip44Encrypt(owner, rumorJson) })));
  /** n wraps nobody can take, as a flood sends them: the relay keeps them, and each is filed as not ours. */
  const junk = (n: number, createdAt = clock) => {
    for (let i = 0; i < n; i++) {
      const id = bytesToHex(nodeCrypto.randomBytes(32));
      wraps.push({ id, pubkey: id, sig: id + id, kind: 1059, created_at: createdAt, tags: [['p', owner]], content: 'x' });
    }
  };
  /** The operator relay as strfry answers: matching wraps newest first, at most limit or its own cap. */
  const relayLike = (cap: number) => async (_relay: string, filters: Filter[]) => {
    const f = filters[0];
    const all = wraps.filter((e) => (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until))
      .sort((a, b) => b.created_at - a.created_at);
    return all.slice(0, Math.min(f.limit ?? Infinity, cap));
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
  const cursor = () => db.get<{ since: number }>("SELECT since FROM sync_cursors WHERE stream = 'inbox'")?.since ?? null;
  return {
    db, owner, user, userSk, device, ports, wraps, texts, request, send, sendRawSeal, sendRawRumor, junk, relayLike, withHtml, ops, item, cursor,
    parses: () => parses, tick: (s: number) => (clock += s), now: () => clock,
  };
}

/** The user's key, counting what the drain asks of it; failing as a signer that doesn't answer while refusing. */
function countingSigner(user: LocalSigner, refuse = () => false) {
  const asked = { decrypts: 0 };
  const signer = new Proxy(user, {
    get: (t, k) => (k === 'nip44Decrypt'
      ? (peer: string, c: string) => (asked.decrypts++, refuse() ? Promise.reject(Object.assign(new Error('timeout'), { code: 'timeout' })) : user.nip44Decrypt(peer, c))
      : Reflect.get(t, k)),
  });
  return { signer, asked };
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
    expect(w.db.get("SELECT 1 FROM inbox_seen WHERE outcome != 'waiting'")).toBeUndefined();
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
    expect(w.db.get("SELECT 1 FROM inbox_seen WHERE outcome != 'waiting'")).toBeUndefined();
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

  test('a wrap anyone can send, holding no seal or rumor of NIP-01’s shape, is filed at once and the cursor moves on', async () => {
    const w = world();
    const { signer, asked } = countingSigner(w.user);
    w.ports.signer = signer;
    for (const s of ['null', '5', '[]', JSON.stringify({ kind: 13, id: '0'.repeat(64), sig: '0'.repeat(128), pubkey: w.device.pubkey(), created_at: 1, tags: [[1]], content: 'c' })]) w.sendRawSeal(s);
    const rumor = { pubkey: w.device.pubkey(), created_at: 1, kind: 30078, tags: [['d', 'kefli/save-request/x']], content: '{}', id: '0'.repeat(64) };
    for (const r of ['null', JSON.stringify({ ...rumor, tags: 'd' }), JSON.stringify({ ...rumor, content: 5 }), JSON.stringify({ ...rumor, created_at: undefined })]) await w.sendRawRumor(r);
    await w.send(w.request());
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_foreign: 8, created: 1 });
    expect(w.cursor()).toBe(w.now());
    // the next drain opens none of them again
    const before = asked.decrypts;
    w.tick(60);
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    expect(asked.decrypts).toBe(before);
  });

  test('once the signer doesn’t answer, the rest of the drain waits unasked: one timeout, not one per wrap (F3)', async () => {
    const w = world();
    let refusing = true;
    const { signer, asked } = countingSigner(w.user, () => refusing);
    w.ports.signer = signer;
    for (let i = 0; i < 40; i++) await w.send(w.request({ url: `https://example.com/${i}` }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    // a bunker takes two minutes to time out: asked for one wrap and the probe that it isn't answering, not forty times
    expect(asked.decrypts).toBe(2);
    expect(w.cursor()).toBeNull();
    refusing = false;
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 40 });
  });

  test('a wrap the signer won’t open, while it opens others, holds only itself: the saves behind it arrive at once', async () => {
    const w = world();
    // a bunker that never replies to this one ciphertext, or a resolver that returns nothing for it: anyone can send it
    const poison = new Set<string>();
    const asked = { decrypts: 0 };
    w.ports.signer = new Proxy(w.user, {
      get: (t, k) => (k === 'nip44Decrypt'
        ? (peer: string, c: string) => (asked.decrypts++, poison.has(c) ? Promise.reject(Object.assign(new Error('timeout'), { code: 'timeout' })) : w.user.nip44Decrypt(peer, c))
        : Reflect.get(t, k)),
    });
    // two of them, older than any browser save, so first in the drain's order
    for (const at of [w.now() - 2 * 86_400 + 100, w.now() - 2 * 86_400 + 101]) {
      const k = generateSecretKey();
      const wrap = finalizeEvent({ kind: 1059, created_at: at, tags: [['p', w.owner]], content: nip44.encrypt('x', nip44.utils.getConversationKey(k, w.owner)) }, k);
      w.wraps.push(wrap as NostrEvent);
      poison.add(wrap.content);
    }
    for (let i = 0; i < 3; i++) await w.send(w.request({ url: `https://example.com/${i}` }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 3 });
    // the two wait, so the cursor stays; the next drains try them after anything new, and ask nothing else
    expect(w.cursor()).toBeNull();
    w.tick(3600);
    await w.send(w.request({ url: 'https://example.com/later' }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    // a week after the first try they are filed as not ours, and the cursor moves on
    w.tick(7 * 86_400);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_foreign: 2 });
    expect(w.cursor()).toBe(w.now());
  });

  test('a wrap dated weeks ahead, which the signer can’t open, holds the cursor a week from the first try, not as long as its date says', async () => {
    const w = world();
    w.ports.signer = countingSigner(w.user, () => true).signer;
    w.sendRawSeal('null', w.now() + 30 * 86_400);
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    w.tick(8 * 86_400);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_foreign: 1 });
    expect(w.cursor()).toBe(w.now());
  });

  test('a browser save first seen more than a week after it was sent still waits a week for a signer out of sight (F3)', async () => {
    const w = world();
    let refusing = true;
    w.ports.signer = countingSigner(w.user, () => refusing).signer;
    // sent nine days ago, while the phone was off, and backdated as NIP-59 allows
    const { wrap } = await wrapSaveRequest(w.device, w.owner, 'late', w.request(), w.now() - 9 * 86_400, { now: w.now() - 9 * 86_400 });
    w.wraps.push(wrap);
    // the background drain, Amber refusing out of sight: the save waits rather than being filed as not ours
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    refusing = false;
    w.tick(3600);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
  });

  test('a flood of wraps nobody takes, newer than a browser save, can’t hide it: the drain reads back through the window', async () => {
    // spread over the hours since the save, from a relay that sends 50 an answer; and all dated to one second, more
    // than strfry's 500 an answer, which until alone can't page past
    for (const [cap, n, at] of [[50, 300, (i: number) => i], [500, 600, () => 0]] as const) {
      const w = world();
      w.ports.query = w.relayLike(cap);
      // the browser's wrap, backdated two hours as NIP-59 allows, then the flood
      const { wrap } = await wrapSaveRequest(w.device, w.owner, 'real', w.request({ url: 'https://example.com/real' }), w.now() - 7200, { now: w.now() - 7200 });
      w.wraps.push(wrap);
      for (let i = 0; i < n; i++) w.junk(1, w.now() - at(i));
      const out = await drainInbox(w.ports, w.owner);
      expect(out.created).toBe(1);
      expect(w.item(itemHash('https://example.com/real'))).toBeDefined();
    }
  });

  test('one drain opens at most INBOX_UNWRAPS wraps; the rest wait for the next, the cursor staying', async () => {
    const w = world();
    // older than the browser's wrap, however far NIP-59 backdates it, so opened first
    w.junk(INBOX_UNWRAPS, w.now() - 3 * 86_400);
    await w.send(w.request());
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_foreign: INBOX_UNWRAPS });
    expect(w.cursor()).toBeNull();
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.cursor()).toBe(w.now());
  });

  test('while the window is full, a drain reads back through it at most every quarter of an hour', async () => {
    const w = world();
    const relay = w.relayLike(500);
    let queries = 0;
    w.ports.query = (r, f) => (queries++, relay(r, f));
    w.junk(700);
    await drainInbox(w.ports, w.owner);
    expect(queries).toBeGreaterThan(1);
    // the live subscription sets off another drain at once: one answer
    queries = 0;
    w.tick(60);
    await drainInbox(w.ports, w.owner);
    expect(queries).toBe(1);
    queries = 0;
    w.tick(INBOX_DEEP_EVERY);
    await drainInbox(w.ports, w.owner);
    expect(queries).toBeGreaterThan(1);
  });

  test('a wrap whose rumor carries a d of kilobytes keeps none of it with its outcome', async () => {
    const w = world();
    // anyone can send it: a request with a token no browser holds, under a d of 8 KB
    const long = makeRumor(w.device.pubkey(), { kind: 30078, created_at: 1, tags: [['d', `kefli/save-request/${'x'.repeat(8_000)}`]], content: JSON.stringify(w.request({ token: 'ee'.repeat(32) })) });
    await w.sendRawRumor(JSON.stringify(long));
    await w.send(w.request({ token: 'ff'.repeat(32) }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_token: 2 });
    const kept = w.db.all<{ n: number | null }>('SELECT length(request_d) AS n FROM inbox_seen');
    expect(kept.every((r) => (r.n ?? 0) <= 128)).toBe(true);
  });

  test('outcomes of wraps nothing was taken from are forgotten after two weeks; a save’s are kept, so a replay stays a repeat', async () => {
    const w = world();
    w.junk(300);
    await w.send(w.request());
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_foreign: 300, created: 1 });
    w.tick(SEEN_KEEP + 3 * 86_400);
    // the flood's wraps have long left the relay's window, but the save's stays recorded
    w.wraps.length = 0;
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    expect(w.db.all('SELECT outcome FROM inbox_seen')).toEqual([{ outcome: 'created' }]);
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

  test('a blob server that trickles, or never ends, lets go at the deadline or the cap (F12)', async () => {
    const MB = 1_048_576;
    const w = world();
    const blob = await w.withHtml('<h1>Slow</h1>', false);
    const pulled = { n: 0 };
    const endless = () => new ReadableStream<Uint8Array>({ pull: (c) => void (pulled.n++, c.enqueue(new Uint8Array(MB))) }, { highWaterMark: 0 });
    w.ports.fetch = (async () => new Response(endless(), { status: 200 })) as never;
    await w.send(w.request({ html: blob.html }));
    // larger than any capture: given up at the cap, and the page fetched instead
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('queued');
    expect(pulled.n).toBeLessThanOrEqual(INBOX_MAX_BYTES / MB + 2);

    jest.useFakeTimers();
    try {
      w.ports.fetch = (async () => new Response(new ReadableStream({ pull: () => new Promise(() => undefined) }), { status: 200 })) as never;
      const got = readBlob(w.ports, blob.html);
      await jest.advanceTimersByTimeAsync(INBOX_TIMEOUT_MS * 2);
      expect(await Promise.race([got, Promise.resolve('still waiting')])).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a connected browser’s request with fields of another type is a save at once, with those fields left out', async () => {
    const w = world();
    await w.send({ ...w.request({ url: 'https://example.com/a/amp' }), title: { a: 1 }, lang: ['en'], canonical: 5, hero: 5, captured_at: 'yesterday' });
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.cursor()).toBe(w.now());
    expect(w.db.get('SELECT title, lang, canonical, hero, saved_at FROM items')).toEqual({ title: null, lang: null, canonical: null, hero: null, saved_at: w.now() });
  });

  test('a request whose address isn’t a link is failed_parse at once, rather than tried for a week', async () => {
    const w = world();
    for (const url of ['javascript:alert(1)', '', 'file:///etc/passwd']) await w.send(w.request({ url }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_parse: 3 });
    expect(w.cursor()).toBe(w.now());
    expect(w.db.get('SELECT COUNT(*) AS n FROM items')).toEqual({ n: 0 });
  });

  test('a captured_at years ahead can’t keep a missing blob tried for ever: it ends two weeks after the request was sent', async () => {
    const w = world();
    const blob = await w.withHtml('<h1>Never served</h1>', false);
    await w.send(w.request({ captured_at: 1e15, html: blob.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    w.tick(INBOX_BLOB_LIFE);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(itemHash('https://example.com/a'))).toMatchObject({ text_state: 'queued', saved_at: T0 });
    expect(w.ops()).toContain('delete_wrap');
  });

  test('a blob that can’t be this capture is given up at once and the page fetched instead, not fetched again for two weeks', async () => {
    for (const spoil of ['other bytes', 'too large', 'wrong key'] as const) {
      const w = world();
      const blob = await w.withHtml('<h1>Spoilt</h1>', false);
      let fetches = 0;
      const big = new Uint8Array(INBOX_MAX_BYTES + 1);
      const wrongKey = await encryptText('<h1>Spoilt</h1>', nodeCrypto);
      w.ports.fetch = (async () => {
        fetches++;
        return new Response((spoil === 'other bytes' ? new Uint8Array([1, 2, 3]) : spoil === 'too large' ? big : wrongKey.blob) as never);
      }) as never;
      // for the wrong key, the request names the served blob's sha256 but a key of its own
      const html = spoil === 'wrong key' ? { ...blob.html, sha256: wrongKey.text.sha256 } : blob.html;
      await w.send(w.request({ html }));
      expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
      expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('queued');
      expect(pendingParses(w.db, w.owner).map((p) => p.url)).toEqual(['https://example.com/a']);
      expect(w.ops()).toContain('delete_wrap');
      w.tick(86_400);
      expect(await drainInbox(w.ports, w.owner)).toEqual({});
      expect(fetches).toBe(1);
    }
  });

  test('a retried blob whose taking fails part way waits for the next drain, and the saves sent since still arrive', async () => {
    const w = world();
    const blob = await w.withHtml('<h1>Later</h1>', false);
    await w.send(w.request({ html: blob.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    blob.serve();
    const targets = w.ports.targets;
    let failing = true;
    w.ports.targets = async () => {
      if (failing) {
        failing = false;
        throw new Error('defaults unreachable');
      }
      return targets();
    };
    await w.send(w.request({ url: 'https://example.com/b' }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(itemHash('https://example.com/b'))).toBeDefined();
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('cached');
  });

  test('once the Blossom server doesn’t answer, the drain’s other blobs wait for the next drain rather than each timing out', async () => {
    const w = world();
    const blobs = [];
    for (let i = 0; i < 5; i++) {
      const b = await w.withHtml(`<h1>Page ${i}</h1>`);
      blobs.push(b);
      await w.send(w.request({ url: `https://example.com/${i}`, html: b.html }));
    }
    const fetch = w.ports.fetch;
    let fetches = 0;
    w.ports.fetch = (async () => {
      fetches++;
      throw new TypeError('Network request failed');
    }) as never;
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 5 });
    expect(fetches).toBe(1);
    w.ports.fetch = fetch;
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 5 });
  });

  test('a save whose browser is disconnected while its blob waits is fetched from its page, not left waiting', async () => {
    const w = world();
    const blob = await w.withHtml('<h1>Later</h1>', false);
    await w.send(w.request({ html: blob.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    w.db.run('UPDATE devices SET revoked_at = 5');
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_token: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('queued');
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
