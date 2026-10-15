import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalSigner, SAVE_REQUEST_MAX_BYTES, encryptText, giftWrap, itemHash, makeRumor, wrapSaveRequest, type NostrEvent, type SaveRequest } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { bytesToHex } from '@noble/hashes/utils.js';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { absorbRecord } from '../src/data/devices';
import { SEEN_KEEP, browserName, INBOX_BLOB_LIFE, inboxScan, queueDeleteInboxBlob } from '../src/data/inbox';
import { commitDelete, deleteItem, setArchived } from '../src/data/library';
import { enqueue, release } from '../src/data/outbox';
import { pendingParses } from '../src/data/pending';
import { removeItem } from '../src/data/sync';
import {
  INBOX_DEEP_EVERY, INBOX_MAX_BYTES, INBOX_TIMEOUT_MS, INBOX_UNWRAPS, drainInbox, fromBrowser, judge, readBlob, unjudged, type InboxPorts,
} from '../src/services/inbox';
import { FIELD_MAX, GUARD_WORDS, RENDERER_GONE, TEXT_MAX_BYTES, parseHtml, type ParserResult } from '../src/services/page';
import * as blocks from '../src/reader/blocks';
import { sendOne, type SendPorts } from '../src/services/send';
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
    return { html: { ...enc.text, server: D.operator.blossom }, size: enc.blob.length, serve: () => blobs.set(`${D.operator.blossom}/${enc.text.sha256}`, enc.blob) };
  };
  const ops = () => db.all<{ op: string; subject: string }>('SELECT op, subject FROM outbox ORDER BY id').map((r) => r.op);
  /** The blob deletes queued, one row per target. */
  const deletes = () => db.all<{ subject: string; payload: string; signer: string; lane: string; target: string }>(
    "SELECT o.subject, o.payload, o.signer, o.lane, t.target FROM outbox o JOIN outbox_targets t ON t.outbox_id = o.id WHERE o.op = 'delete_blob' ORDER BY o.id, t.target");
  const item = (hash: string) => db.get<{ text_state: string; title: string; origin: string; origin_device: string; state: string; saved_at: number }>(
    'SELECT text_state, title, origin, origin_device, state, saved_at FROM items WHERE owner = ? AND hash = ?', owner, hash);
  const cursor = () => db.get<{ since: number }>("SELECT since FROM sync_cursors WHERE stream = 'inbox'")?.since ?? null;
  return {
    db, owner, user, userSk, device, ports, wraps, blobs, texts, request, send, sendRawSeal, sendRawRumor, junk, relayLike, withHtml, ops, deletes,
    item, cursor, parses: () => parses, tick: (s: number) => (clock += s), now: () => clock, answerMissing: (status: number) => void (missing = status),
  };
}

/** Random bytes of zero, so a wrap is dated exactly when it says rather than up to two days earlier (NIP-59). */
const noBackdate = (n: number) => new Uint8Array(n);

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
    const read = { canonical: 'https://example.com/a', byline: 'A writer', hero: 'https://example.com/a.jpg' };
    await w.send(w.request(read));
    await w.send(w.request({ url: 'https://x.com/someone/status/123', html, ...read }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 2 });
    expect(pendingParses(w.db, w.owner).map((p) => [p.url, p.x_state]).sort()).toEqual([
      ['https://example.com/a', null],
      ['https://x.com/someone/status/123', 'pending'],
    ]);
    expect(w.parses()).toBe(0);
    // what the browser read stands until the parse, but an X post's is the post's, so none of it is kept
    expect(w.db.all('SELECT canonical, title, site, byline, lang, hero FROM items ORDER BY url')).toEqual([
      { ...read, title: 'From the browser', site: 'example.com', lang: 'en' },
      { canonical: null, title: null, site: null, byline: null, lang: null, hero: null },
    ]);
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

  test('a signer out of sight for more than a week costs one save, not one a drain: the same wrap is tried first each time', async () => {
    const w = world();
    let refusing = true;
    w.ports.signer = countingSigner(w.user, () => refusing).signer;
    for (let i = 0; i < 5; i++) await w.send(w.request({ url: `https://example.com/${i}` }));
    // eight days of drains, four a day, Amber declining out of sight
    for (let d = 0; d < 32; d++) {
      expect(await drainInbox(w.ports, w.owner)).toEqual(d < 28 ? {} : expect.anything());
      w.tick(6 * 3600);
    }
    refusing = false;
    const out = await drainInbox(w.ports, w.owner);
    // the first, tried at every drain, waited its week and was filed; the rest were never asked for, and arrive
    expect(out.created).toBe(4);
  });

  test('hundreds of wraps that keep failing for a signer that answers can’t spend the budget ahead of a new save', async () => {
    const w = world();
    w.ports.query = w.relayLike(500);
    const poison = new Set<string>();
    w.ports.signer = new Proxy(w.user, {
      get: (t, k) => (k === 'nip44Decrypt'
        ? (peer: string, c: string) => (poison.has(c) ? Promise.reject(Object.assign(new Error('timeout'), { code: 'timeout' })) : w.user.nip44Decrypt(peer, c))
        : Reflect.get(t, k)),
    });
    for (let i = 0; i < 600; i++) {
      const k = generateSecretKey();
      const wrap = finalizeEvent({ kind: 1059, created_at: w.now() - 86_400 - i, tags: [['p', w.owner]], content: nip44.encrypt('x', nip44.utils.getConversationKey(k, w.owner)) }, k);
      w.wraps.push(wrap as NostrEvent);
      poison.add(wrap.content);
    }
    // two drains try them all, and each waits its week
    await drainInbox(w.ports, w.owner);
    w.tick(INBOX_DEEP_EVERY);
    await drainInbox(w.ports, w.owner);
    expect(w.db.get("SELECT COUNT(*) AS n FROM inbox_seen WHERE outcome = 'waiting'")).toEqual({ n: 600 });
    await w.send(w.request({ url: 'https://example.com/new' }));
    w.tick(INBOX_DEEP_EVERY);
    expect(await drainInbox(w.ports, w.owner)).toMatchObject({ created: 1 });
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
    w.ports.query = w.relayLike(500);
    // older than the browser's wrap, however far NIP-59 backdates it, so opened first
    w.junk(INBOX_UNWRAPS, w.now() - 3 * 86_400);
    await w.send(w.request());
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_foreign: INBOX_UNWRAPS });
    expect(w.cursor()).toBeNull();
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    // that drain read the newest answer alone, full, so the window may hold more it didn't read: the cursor stays
    // until a read reaches the window's end
    expect(w.cursor()).toBeNull();
    w.tick(INBOX_DEEP_EVERY);
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    expect(w.cursor()).toBe(w.now());
  });

  test('a flood around a backdated browser save, read but not all opened, can’t move the cursor past it: the save arrives', async () => {
    const w = world();
    w.ports.query = w.relayLike(500);
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    const opened = w.now();
    // a day with the app closed: halfway through it the browser saves a page, its wrap dated 1.9 days earlier (NIP-59)
    w.tick(12 * 3600);
    const sent = w.now() - Math.round(1.9 * 86_400);
    const { wrap } = await wrapSaveRequest(w.device, w.owner, 'real', w.request({ url: 'https://example.com/real' }), sent, { now: sent, random: noBackdate });
    w.wraps.push(wrap);
    w.tick(12 * 3600);
    // and 1,500 junk wraps spread through the window, half older than the save and half newer
    for (let i = 0; i < 750; i++) {
      w.junk(1, sent - 1 - i * 60);
      w.junk(1, sent + 1 + i * 60);
    }
    // the drain at open reads them all and opens its budget; the live subscription's, a minute later, the newest answer
    await drainInbox(w.ports, w.owner);
    w.tick(60);
    await drainInbox(w.ports, w.owner);
    // neither read the whole window and opened all it read, so the cursor stays and the save stays in the window
    expect(w.cursor()).toBe(opened);
    w.tick(INBOX_DEEP_EVERY);
    await drainInbox(w.ports, w.owner);
    expect(w.item(itemHash('https://example.com/real'))).toBeDefined();
  });

  test('a window deeper than one deep read is read in turn, each deep read going on from where the last stopped', async () => {
    const w = world();
    w.ports.query = w.relayLike(500);
    // the browser's wrap backdated two days, beneath 6,000 newer: more than one deep read reaches
    const sent = w.now() - 2 * 86_400 + 600;
    const { wrap } = await wrapSaveRequest(w.device, w.owner, 'deep', w.request({ url: 'https://example.com/deep' }), sent, { now: sent, random: noBackdate });
    w.wraps.push(wrap);
    for (let i = 0; i < 6_000; i++) w.junk(1, w.now() - i * 20);
    for (let n = 0; n < 40 && !w.item(itemHash('https://example.com/deep')); n++) {
      await drainInbox(w.ports, w.owner);
      w.tick(INBOX_DEEP_EVERY);
    }
    expect(w.item(itemHash('https://example.com/deep'))).toBeDefined();
  });

  test('a scan goes on where it stopped when the app is opened again, rather than beginning again at the top', async () => {
    const w = world();
    w.ports.query = w.relayLike(500);
    const sent = w.now() - 2 * 86_400 + 600;
    const { wrap } = await wrapSaveRequest(w.device, w.owner, 'deep', w.request({ url: 'https://example.com/deep' }), sent, { now: sent, random: noBackdate });
    w.wraps.push(wrap);
    for (let i = 0; i < 6_000; i++) w.junk(1, w.now() - i * 20);
    await drainInbox(w.ports, w.owner);
    expect(inboxScan(w.db, D.operator.relay, w.owner)).not.toBeNull();
    // each open a new process, whose first drain reads deep: one deep read each, which alone never reaches the save
    for (let n = 0; n < 6 && !w.item(itemHash('https://example.com/deep')); n++) {
      w.tick(3600);
      let fresh: typeof import('../src/services/inbox') | undefined;
      jest.isolateModules(() => {
        fresh = require('../src/services/inbox');
      });
      await fresh!.drainInbox(w.ports, w.owner);
    }
    expect(w.item(itemHash('https://example.com/deep'))).toBeDefined();
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
    // anyone can send it: a request with a token no browser holds, under a d of 2.5 KB, its wrap still under 8 KB
    const long = makeRumor(w.device.pubkey(), { kind: 30078, created_at: 1, tags: [['d', `kefli/save-request/${'x'.repeat(2_500)}`]], content: JSON.stringify(w.request({ token: 'ee'.repeat(32) })) });
    const id = await w.sendRawRumor(JSON.stringify(long));
    expect(JSON.stringify(w.wraps.find((x) => x.id === id)).length).toBeLessThan(SAVE_REQUEST_MAX_BYTES);
    await w.send(w.request({ token: 'ff'.repeat(32) }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ ignored_token: 2 });
    const kept = w.db.all<{ n: number | null }>('SELECT length(request_d) AS n FROM inbox_seen');
    expect(kept.every((r) => (r.n ?? 0) <= 128)).toBe(true);
  });

  test('a deep read keeps no more wraps than two drains open, those opened first, and says when it let some go', async () => {
    const w = world();
    const read = unjudged(w.db);
    // ten answers of small wraps anyone can send, newest first, as a deep read gets them
    w.junk(5_000, w.now());
    w.wraps.forEach((x, i) => (x.created_at = w.now() - i));
    for (let page = 0; page < 10; page++) read.take(w.wraps.slice(page * 500, (page + 1) * 500));
    const kept = read.wraps();
    expect(kept.length).toBeLessThanOrEqual(2 * INBOX_UNWRAPS);
    expect(kept[0].created_at).toBe(w.now() - 4_999);
    expect(read.over()).toBe(true);
    // the drain counts those let go as left unopened: the cursor stays
    w.ports.query = w.relayLike(500);
    await drainInbox(w.ports, w.owner);
    expect(w.cursor()).toBeNull();
  });

  test('a wrap of a save request’s limit or more can’t hold one: never opened, nothing kept of it, the cursor moving on', async () => {
    const w = world();
    const { signer, asked } = countingSigner(w.user);
    w.ports.signer = signer;
    // a rumor under a d of 8 KB, as anyone can send, and wraps of 16 KB of anything
    const long = makeRumor(w.device.pubkey(), { kind: 30078, created_at: 1, tags: [['d', `kefli/save-request/${'x'.repeat(8_000)}`]], content: JSON.stringify(w.request()) });
    await w.sendRawRumor(JSON.stringify(long));
    w.sendRawSeal(JSON.stringify({ x: 'y'.repeat(12_000) }));
    await w.send(w.request());
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    // the browser's own wrap opened (two decrypts), the others not at all
    expect(asked.decrypts).toBe(2);
    expect(w.db.all('SELECT outcome FROM inbox_seen')).toEqual([{ outcome: 'created' }]);
    expect(w.cursor()).toBe(w.now());
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

  test('a capture whose text can’t be written, as on a full disk, leaves its save getting the text and its wrap to read again', async () => {
    // written after the row was marked, a failed write left the save cached with no text on the phone, its upload queued
    const w = world();
    const { html } = await w.withHtml('<html><h1>Read later</h1><p>…</p></html>');
    await w.send(w.request({ html }));
    const write = w.ports.writeText;
    w.ports.writeText = () => {
      throw new Error('ENOSPC (No space left on device)');
    };
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    const hash = itemHash('https://example.com/a');
    expect(w.item(hash)?.text_state).toBe('fetching');
    expect(w.texts.size).toBe(0);
    expect(w.ops()).not.toContain('upload_blob');
    expect(w.ops()).not.toContain('delete_wrap');
    // with room again, the next drain reads the capture again and the save takes its text
    w.ports.writeText = write;
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(hash)?.text_state).toBe('cached');
    expect([...w.texts.keys()]).toEqual([hash]);
    expect(w.ops()).toContain('upload_blob');
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

  test('only a 404 says the blob is gone, and only bytes that can’t be the capture give it up: every other failure is tried again', async () => {
    const w = world();
    const enc = await encryptText('<h1>Checked</h1>', nodeCrypto);
    const html = { ...enc.text, server: D.operator.blossom };
    const at = `${D.operator.blossom}/${enc.text.sha256}`;
    // the server answering without it, and the server down (a 5xx or 429), after which a drain asks it nothing more
    for (const status of [400, 401, 403, 410]) {
      w.answerMissing(status);
      expect([status, await readBlob(w.ports, html)]).toEqual([status, { kind: 'failed' }]);
    }
    for (const status of [429, 500, 502, 503, 507]) {
      w.answerMissing(status);
      expect([status, await readBlob(w.ports, html)]).toEqual([status, { kind: 'failed', down: true }]);
    }
    w.answerMissing(404);
    expect(await readBlob(w.ports, html)).toEqual({ kind: 'gone' });
    // a blob that doesn't check out, served under its address: no later try changes it, so it is given up
    w.blobs.set(at, (await encryptText('<h1>Another</h1>', nodeCrypto)).blob);
    expect(await readBlob(w.ports, html)).toEqual({ kind: 'bad' });
    w.blobs.set(at, enc.blob);
    expect(await readBlob(w.ports, html)).toEqual({ kind: 'html', html: '<h1>Checked</h1>', size: enc.blob.length });
    // the network failing
    const served = w.ports.fetch;
    w.ports.fetch = (async () => {
      throw new TypeError('Network request failed');
    }) as never;
    expect(await readBlob(w.ports, html)).toEqual({ kind: 'failed', down: true });
    // and through a drain: failed_blob, still fetching, no parse
    await w.send(w.request({ html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('fetching');
    expect(pendingParses(w.db, w.owner)).toEqual([]);
    w.ports.fetch = served;
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('cached');
  });

  /** A browser save whose capture the operator failed to serve: a save still getting its text, and a failed_blob wrap. */
  async function failedCapture() {
    const w = world();
    w.answerMissing(502);
    const blob = await w.withHtml('<h1>Later</h1>', false);
    await w.send(w.request({ html: blob.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    return { w, blob, hash: itemHash('https://example.com/a') };
  }

  test('a save deleted while its capture failed isn’t made again by the retry, here or from another phone (RULED)', async () => {
    type World = Awaited<ReturnType<typeof failedCapture>>;
    const deletions: [string, (f: World) => void][] = [
      ['deleted here', ({ w, hash }) => commitDelete(w.db, w.owner, hash, deleteItem(w.db, w.ports.now(), w.owner, hash).held)],
      // a kind 5 from another phone, as sync applies it
      ['deleted on another phone', ({ w, hash }) => removeItem(w.db, w.db.get<{ id: number }>('SELECT id FROM items')!.id, w.owner, hash)],
    ];
    const retries: [string, (f: World) => void][] = [
      ['its capture read', ({ blob }) => blob.serve()],
      ['its capture gone', ({ w }) => w.answerMissing(404)],
      ['its 14 days over', ({ w }) => w.tick(INBOX_BLOB_LIFE)],
    ];
    for (const [deleted, del] of deletions) {
      for (const [retried, retry] of retries) {
        const f = await failedCapture();
        const { w, blob } = f;
        del(f);
        retry(f);
        const at = `${deleted}, ${retried}`;
        // closed as the creation it was, its kind 5 and its capture's delete queued, and nothing made, read or sent
        expect([at, await drainInbox(w.ports, w.owner)]).toEqual([at, { created: 1 }]);
        expect([at, w.db.get('SELECT COUNT(*) AS n FROM items')]).toEqual([at, { n: 0 }]);
        expect([at, w.parses(), pendingParses(w.db, w.owner)]).toEqual([at, 0, []]);
        expect([at, w.ops().filter((o) => ['upload_blob', 'mirror_blob', 'publish_item'].includes(o))]).toEqual([at, []]);
        expect([at, w.ops().filter((o) => o === 'delete_wrap'), w.deletes().map((d) => d.subject)]).toEqual([at, ['delete_wrap'], [blob.html.sha256]]);
        expect([at, w.db.all('SELECT outcome, wrap_json FROM inbox_seen')]).toEqual([at, [{ outcome: 'created', wrap_json: null }]]);
        expect([at, await drainInbox(w.ports, w.owner)]).toEqual([at, {}]);
      }
    }
  });

  test('a save archived while its capture failed stays archived when the retry gives it its text', async () => {
    const { w, blob, hash } = await failedCapture();
    const archive = setArchived(w.db, w.ports.now(), w.owner, hash, true);
    release(w.db, archive.held);
    w.tick(60);
    blob.serve();
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    // the same save request, not a new one: no repeat save's un-archiving, and its time stays the capture's
    expect(w.item(hash)).toMatchObject({ state: 'archived', text_state: 'cached', saved_at: T0 - 60 });
    expect(w.texts.get(hash)).toContain('# Later');
  });

  test('a retry waits while its save’s delete waits on Undo: shown again, it gets its text; deleted, nothing is left to upload', async () => {
    const undone = await failedCapture();
    const del = deleteItem(undone.w.db, undone.w.ports.now(), undone.w.owner, undone.hash);
    undone.blob.serve();
    expect(await drainInbox(undone.w.ports, undone.w.owner)).toEqual({});
    expect(undone.w.ops()).not.toContain('upload_blob');
    expect(undone.w.db.all('SELECT outcome FROM inbox_seen')).toEqual([{ outcome: 'failed_blob' }]);
    del.revert();
    expect(await drainInbox(undone.w.ports, undone.w.owner)).toEqual({ created: 1 });
    expect(undone.w.item(undone.hash)?.text_state).toBe('cached');

    const { w, blob, hash } = await failedCapture();
    const gone = deleteItem(w.db, w.ports.now(), w.owner, hash);
    blob.serve();
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    commitDelete(w.db, w.owner, hash, gone.held);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    // no text was made for the save while its delete waited, so no upload or mirror is left that no save names (C§4.1)
    expect(w.db.get('SELECT COUNT(*) AS n FROM items')).toEqual({ n: 0 });
    expect(w.ops().filter((o) => ['upload_blob', 'mirror_blob', 'publish_item'].includes(o))).toEqual([]);
    expect(w.db.all('SELECT sha256 FROM blobs')).toEqual([]);
    expect(w.deletes().map((d) => d.subject)).toEqual([blob.html.sha256]);
  });

  test('a browser save of a save whose delete waits on Undo waits too: deleted, it is a new save; shown again, it matches (RULED)', async () => {
    const hash = itemHash('https://example.com/a');
    /** A save from the browser, deleted on the phone, then saved again from the browser inside the delete's Undo. */
    const again = async () => {
      const w = world();
      await w.send(w.request());
      expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
      const del = deleteItem(w.db, w.ports.now(), w.owner, hash);
      w.tick(5);
      const blob = await w.withHtml('<h1>Again</h1>');
      const id = await w.send(w.request({ captured_at: w.ports.now(), html: blob.html }));
      // held: no outcome recorded, only when it was first tried (F3), the cursor where it was, nothing read or deleted
      expect(await drainInbox(w.ports, w.owner)).toEqual({});
      expect(w.db.get('SELECT outcome FROM inbox_seen WHERE wrap_id = ?', id)).toEqual({ outcome: 'waiting' });
      expect(w.db.get("SELECT since FROM sync_cursors WHERE stream = 'inbox'")).toEqual({ since: T0 });
      expect([w.parses(), w.deletes()]).toEqual([0, []]);
      return { w, del, blob };
    };
    // the delete goes through: the save from the browser is a new one, its text read from its capture
    const done = await again();
    commitDelete(done.w.db, done.w.owner, hash, done.del.held);
    expect(await drainInbox(done.w.ports, done.w.owner)).toEqual({ created: 1 });
    expect(done.w.item(hash)).toMatchObject({ text_state: 'cached', saved_at: T0 + 5 });
    expect(done.w.texts.get(hash)).toContain('# Again');
    expect(done.w.deletes().map((d) => d.subject)).toEqual([done.blob.html.sha256]);
    // Undo: the save is shown again, and the browser's save is a repeat of it
    const undone = await again();
    undone.del.revert();
    expect(await drainInbox(undone.w.ports, undone.w.owner)).toEqual({ merged: 1 });
    expect(undone.w.item(hash)).toMatchObject({ text_state: 'queued', saved_at: T0 - 60 });
    expect(undone.w.deletes().map((d) => d.subject)).toEqual([undone.blob.html.sha256]);
    // a delete whose Undo is somehow still open a week on no longer holds the inbox's cursor (F3)
    const late = await again();
    late.w.tick(8 * 86_400);
    expect(await drainInbox(late.w.ports, late.w.owner)).toEqual({ merged: 1 });
    expect(late.w.db.get("SELECT since FROM sync_cursors WHERE stream = 'inbox'")).toEqual({ since: T0 + 5 + 8 * 86_400 });
  });

  test('a save deleted while its capture is read keeps its wrap, as a first drain or a retry reads it: shown again, it gets its text; deleted, the wrap closes', async () => {
    const hash = itemHash('https://example.com/a');
    /** A browser save deleted on the phone, its delete waiting on Undo, while its capture is read: by its first drain, or by a retry. */
    const raced = async (retry: boolean) => {
      const w = world();
      if (retry) w.answerMissing(502);
      const blob = await w.withHtml('<h1>Raced</h1>', !retry);
      await w.send(w.request({ html: blob.html }));
      if (retry) {
        expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
        blob.serve();
      }
      const fetch = w.ports.fetch;
      let del: ReturnType<typeof deleteItem> | undefined;
      w.ports.fetch = (async (url: string) => {
        del ??= deleteItem(w.db, w.ports.now(), w.owner, hash);
        return fetch(url);
      }) as never;
      // the save takes nothing while its delete waits (data/pending), so the wrap and its capture stay for the retry
      expect([retry, await drainInbox(w.ports, w.owner)]).toEqual([retry, { failed_blob: 1 }]);
      w.ports.fetch = fetch;
      expect([retry, w.item(hash)?.text_state, w.texts.size, w.ops().filter((o) => ['upload_blob', 'delete_wrap'].includes(o)), w.deletes()])
        .toEqual([retry, 'fetching', 0, [], []]);
      return { w, del: del!, blob };
    };
    for (const retry of [false, true]) {
      // shown again: the retry reads the capture, the save gets its text, and the wrap closes with its capture's delete
      const undone = await raced(retry);
      undone.del.revert();
      expect([retry, await drainInbox(undone.w.ports, undone.w.owner)]).toEqual([retry, { created: 1 }]);
      expect([retry, undone.w.item(hash)?.text_state, undone.w.texts.get(hash)?.startsWith('# Raced')]).toEqual([retry, 'cached', true]);
      expect([retry, undone.w.deletes().map((d) => d.subject)]).toEqual([retry, [undone.blob.html.sha256]]);
      // deleted: the wrap closes as the creation it was, nothing made again
      const gone = await raced(retry);
      commitDelete(gone.w.db, gone.w.owner, hash, gone.del.held);
      expect([retry, await drainInbox(gone.w.ports, gone.w.owner)]).toEqual([retry, { created: 1 }]);
      expect([retry, gone.w.db.get('SELECT COUNT(*) AS n FROM items'), gone.w.ops().filter((o) => o === 'delete_wrap')]).toEqual([retry, { n: 0 }, ['delete_wrap']]);
      expect([retry, gone.w.deletes().map((d) => d.subject)]).toEqual([retry, [gone.blob.html.sha256]]);
    }
  });

  test('a browser disconnected after its capture failed leaves its save to finish, not waiting for its text for ever', async () => {
    // Disconnect has Kefli's server delete the browser's captures (C§6), so the retry meets a 404
    const { w, hash } = await failedCapture();
    w.db.run('UPDATE devices SET revoked_at = ?', w.ports.now());
    w.answerMissing(404);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(hash)?.text_state).toBe('queued');
    expect(pendingParses(w.db, w.owner).map((p) => p.url)).toEqual(['https://example.com/a']);
    // and one whose capture is still there is read
    const still = await failedCapture();
    still.w.db.run('UPDATE devices SET revoked_at = ?', still.w.ports.now());
    still.blob.serve();
    expect(await drainInbox(still.w.ports, still.w.owner)).toEqual({ created: 1 });
    expect(still.w.item(still.hash)?.text_state).toBe('cached');
  });

  test('a retry that fails part way holds up neither the other retries nor the new wraps', async () => {
    const { w, blob } = await failedCapture();
    const other = await w.withHtml('<h1>Other</h1>', false);
    await w.send(w.request({ url: 'https://example.com/b', html: other.html }));
    // the first one's retry fails again, and the second fails
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 2 });
    blob.serve();
    other.serve();
    await w.send(w.request({ url: 'https://example.com/c' }));
    // the phone's disk refuses the first text it stages
    const stage = w.ports.stage;
    let refuse = 1;
    w.ports.stage = (sha, bytes) => {
      if (refuse-- > 0) throw new Error('disk full');
      return stage(sha, bytes);
    };
    // one retry is kept as a blob that failed, the other and the new wrap go on
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 2, failed_blob: 1 });
    const left = w.db.all<{ hash: string }>("SELECT hash FROM inbox_seen WHERE outcome = 'failed_blob'");
    expect(left).toHaveLength(1);
    expect(w.item(left[0].hash)?.text_state).toBe('fetching');
    expect(w.item(itemHash('https://example.com/c'))?.text_state).toBe('queued');
    // and it is tried again at the next drain
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(['a', 'b'].map((p) => w.item(itemHash(`https://example.com/${p}`))?.text_state)).toEqual(['cached', 'cached']);
  });

  test('a new wrap whose taking fails part way before its save is made waits for the next drain, and is filed as not ours after a week (F3)', async () => {
    const w = world();
    await w.send(w.request({ html: (await w.withHtml('<h1>No targets</h1>')).html }));
    const targets = w.ports.targets;
    w.ports.targets = async () => {
      throw new Error('database locked');
    };
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
    expect(w.db.get("SELECT 1 FROM inbox_seen WHERE outcome != 'waiting'")).toBeUndefined();
    expect(w.db.get("SELECT 1 FROM sync_cursors WHERE stream = 'inbox'")).toBeUndefined();
    expect(w.item(itemHash('https://example.com/a'))).toBeUndefined();
    w.ports.targets = targets;
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('cached');

    const late = world();
    await late.send(late.request({ html: (await late.withHtml('<h1>Never</h1>')).html }));
    late.ports.targets = async () => {
      throw new Error('database locked');
    };
    expect(await drainInbox(late.ports, late.owner)).toEqual({});
    late.tick(8 * 86_400);
    expect(await drainInbox(late.ports, late.owner)).toEqual({ ignored_foreign: 1 });
    expect(late.db.get("SELECT 1 AS n FROM sync_cursors WHERE stream = 'inbox'")).toEqual({ n: 1 });
  });

  test('a capture whose taking fails part way once its save is made is a blob that failed: read again, then its page fetched', async () => {
    const w = world();
    await w.send(w.request({ html: (await w.withHtml('<h1>Full disk</h1>')).html }));
    const stage = w.ports.stage;
    w.ports.stage = () => {
      throw new Error('disk full');
    };
    // the save is made and waits for its text; the capture is kept to be read again, so the cursor moves on
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('fetching');
    expect(w.db.get("SELECT 1 AS n FROM sync_cursors WHERE stream = 'inbox'")).toEqual({ n: 1 });
    w.ports.stage = stage;
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.item(itemHash('https://example.com/a'))?.text_state).toBe('cached');

    // a disk that keeps refusing: past the week a wrap may wait, it is still this save's capture, never someone else's
    // message, and once its 14 days are past the save fetches its page, rather than staying at "Getting the text…"
    const late = world();
    await late.send(late.request({ html: (await late.withHtml('<h1>Never</h1>')).html }));
    late.ports.stage = () => {
      throw new Error('disk full');
    };
    expect(await drainInbox(late.ports, late.owner)).toEqual({ failed_blob: 1 });
    late.tick(8 * 86_400);
    expect(await drainInbox(late.ports, late.owner)).toEqual({ failed_blob: 1 });
    expect(late.item(itemHash('https://example.com/a'))?.text_state).toBe('fetching');
    late.tick(7 * 86_400);
    expect(await drainInbox(late.ports, late.owner)).toEqual({ created: 1 });
    expect(late.item(itemHash('https://example.com/a'))?.text_state).toBe('queued');
    expect(pendingParses(late.db, late.owner).map((p) => p.url)).toEqual(['https://example.com/a']);
    expect(late.ops()).toContain('delete_wrap');
  });

  test("a relay that can't be reached leaves the cursor where it was, and the retries still run", async () => {
    const { w, blob } = await failedCapture();
    const cursor = w.db.get("SELECT since FROM sync_cursors WHERE stream = 'inbox'");
    blob.serve();
    w.tick(60);
    w.ports.query = async () => {
      throw new Error('connection refused');
    };
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.db.get("SELECT since FROM sync_cursors WHERE stream = 'inbox'")).toEqual(cursor);
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
      // a server that doesn't finish in time is down for the rest of the drain, and its blob tried again at the next
      expect(await Promise.race([got, Promise.resolve('still waiting')])).toEqual({ kind: 'failed', down: true });
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

  test('a request whose address holds a user name and password is saved without them, its text read at that address', async () => {
    const w = world();
    const at: string[] = [];
    const markdown = w.ports.markdown;
    w.ports.markdown = async (html, url) => (at.push(url), markdown(html, url));
    const { html } = await w.withHtml('<h1>Behind a login</h1>');
    await w.send(w.request({ url: 'https://user:hunter2@example.com/a', html }));
    await w.send(w.request({ url: 'https://me@example.com/b', html: null }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 2 });
    expect(w.db.all('SELECT url, shared_url, text_state FROM items ORDER BY url')).toEqual([
      { url: 'https://example.com/a', shared_url: 'https://example.com/a', text_state: 'cached' },
      { url: 'https://example.com/b', shared_url: 'https://example.com/b', text_state: 'queued' },
    ]);
    // the browser's HTML is converted at the address without them, so no link in its text resolves to one with them
    expect(at).toEqual(['https://example.com/a']);
    expect(pendingParses(w.db, w.owner).map((p) => p.url)).toEqual(['https://example.com/b']);
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
    // the operator failing, not saying the blob is gone, which would have the page fetched at once (v1.12)
    w.answerMissing(503);
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
    w.answerMissing(502);
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
    // the retry is kept as a blob that failed again, and the new save arrives
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1, failed_blob: 1 });
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

  test('the captures tried again from earlier drains wait unasked too, once the Blossom server doesn’t answer', async () => {
    const w = world();
    // a 502 is the server not answering, as a 5xx or 429 is: the first drain asks it once
    w.answerMissing(502);
    const blobs = [];
    for (let i = 0; i < 4; i++) {
      const b = await w.withHtml(`<h1>Page ${i}</h1>`, false);
      blobs.push(b);
      await w.send(w.request({ url: `https://example.com/${i}`, html: b.html }));
    }
    const fetch = w.ports.fetch;
    let fetches = 0;
    w.ports.fetch = (async (url: string) => (fetches++, fetch(url))) as never;
    expect([await drainInbox(w.ports, w.owner), fetches]).toEqual([{ failed_blob: 4 }, 1]);
    // the retries at the next drain's start, the server still down: it is asked once again, not once a capture
    expect([await drainInbox(w.ports, w.owner), fetches]).toEqual([{ failed_blob: 4 }, 2]);
    // answering again: every capture is read
    for (const b of blobs) b.serve();
    expect([await drainInbox(w.ports, w.owner), fetches]).toEqual([{ created: 4 }, 6]);
    expect(w.db.all("SELECT text_state FROM items WHERE text_state != 'cached'")).toEqual([]);
  });

  test('a retried capture’s request is read as acceptance reads one, its browser connected as it was: odd fields left out', async () => {
    const w = world();
    w.answerMissing(502);
    const blob = await w.withHtml('<h1>Later</h1>', false);
    // a connected browser's request with fields of another type, as anyone holding its token could send
    await w.send({ ...w.request({ html: blob.html }), title: { a: 1 }, lang: ['en'], canonical: 5, hero: 5, captured_at: 'yesterday' });
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    // disconnected meanwhile, its capture still there: the retry reads it, with those fields still left out
    w.db.run('UPDATE devices SET revoked_at = ?', w.ports.now());
    blob.serve();
    w.tick(60);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.db.get('SELECT text_state, title, lang, canonical, hero, saved_at FROM items')).toEqual({
      text_state: 'cached', title: null, lang: null, canonical: null, hero: null, saved_at: T0,
    });
    expect(w.texts.get(itemHash('https://example.com/a'))).toContain('# Later');
  });

  test('a kept wrap this phone no longer reads as a request, as after an update, leaves its save to fetch its page', async () => {
    const { w, blob, hash } = await failedCapture();
    // the kept rumor as a build with other rules took it: an address this one doesn't read as a link
    const { rumor, seal } = JSON.parse(w.db.get<{ wrap_json: string }>('SELECT wrap_json FROM inbox_seen')!.wrap_json);
    const content = JSON.stringify({ ...JSON.parse(rumor.content), url: 'javascript:alert(1)' });
    w.db.run('UPDATE inbox_seen SET wrap_json = ?', JSON.stringify({ rumor: { ...rumor, content }, seal }));
    blob.serve();
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_parse: 1 });
    expect(w.item(hash)?.text_state).toBe('queued');
    expect(pendingParses(w.db, w.owner).map((p) => p.url)).toEqual(['https://example.com/a']);
    expect([w.parses(), w.db.get('SELECT outcome, wrap_json FROM inbox_seen')]).toEqual([0, { outcome: 'failed_parse', wrap_json: null }]);
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
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
    const { html, size } = await w.withHtml('<html><h1>Read later</h1><p>…</p></html>');
    await w.send(w.request({ html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.deletes()).toEqual([{
      subject: html.sha256, payload: JSON.stringify({ sha256: html.sha256, size, up: T0 }), signer: w.owner, lane: 'bulk', target: D.operator.blossom,
    }]);
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

  test("a capture's delete carries its size and when the phone found it, only when the phone read it (RULED)", async () => {
    const w = world();
    const payloads = () => Object.fromEntries(w.deletes().map((d) => [d.subject, JSON.parse(d.payload)]));
    // read at its drain: the bytes the operator holds for it, and a time after the browser's upload
    w.tick(30);
    const read = await w.withHtml('<h1>Read</h1>');
    await w.send(w.request({ html: read.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(payloads()).toEqual({ [read.html.sha256]: { sha256: read.html.sha256, size: read.size, up: T0 + 30 } });
    // a repeat save's, an X post's and one gone are never read, so they give back no room the phone counts
    w.tick(100);
    const again = await w.withHtml('<h1>Again</h1>');
    await w.send(w.request({ captured_at: T0 + 100, html: again.html }));
    const x = await w.withHtml('<h1>x</h1>');
    await w.send(w.request({ url: 'https://x.com/someone/status/1', html: x.html }));
    const gone = await w.withHtml('<h1>Gone</h1>', false);
    await w.send(w.request({ url: 'https://example.com/b', html: gone.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ merged: 1, created: 2 });
    for (const b of [again, x, gone]) expect(payloads()[b.html.sha256]).toEqual({ sha256: b.html.sha256 });
    // read at a later drain's retry: found then
    w.answerMissing(502);
    const late = await w.withHtml('<h1>Late</h1>', false);
    await w.send(w.request({ url: 'https://example.com/c', html: late.html }));
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    w.tick(600);
    late.serve();
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(payloads()[late.html.sha256]).toEqual({ sha256: late.html.sha256, size: late.size, up: T0 + 730 });
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

describe('the browser’s HTML takes the guards a parsed page’s text takes (C§4.2, C§4.4)', () => {
  const hash = itemHash('https://example.com/a');
  const parsedAs = (markdown: string, readerable = true): ParserResult =>
    ({ ok: true, title: null, byline: null, site: null, lang: null, hero: null, canonical: null, readerable, markdown });
  const textOf = (w: ReturnType<typeof world>) => w.db.get('SELECT text_state, fail_reason FROM items WHERE hash = ?', hash);

  async function capture(w: ReturnType<typeof world>, over: Partial<SaveRequest> = {}) {
    const { html } = await w.withHtml('<html><h1>Captured</h1><p>…</p></html>');
    return w.send(w.request({ html, ...over }));
  }

  test('a text past what a save keeps is too large: the save keeps its link without it, and nothing waits to upload', async () => {
    const w = world();
    w.ports.markdown = async () => parsedAs('x'.repeat(TEXT_MAX_BYTES + 1));
    await capture(w);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(textOf(w)).toEqual({ text_state: 'failed', fail_reason: 'too_large' });
    expect(w.texts.size).toBe(0);
    expect(w.ops()).not.toContain('upload_blob');
  });

  test('a conversion the parser stopped for its size is too large, as a page’s is', async () => {
    const w = world();
    w.ports.markdown = async () => ({ ok: false, reason: 'too_large' });
    await capture(w);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(textOf(w)).toEqual({ text_state: 'failed', fail_reason: 'too_large' });
  });

  test('a derivation that throws leaves the save its link without text, and the wrap closes, rather than waiting a week', async () => {
    const w = world();
    const derive = jest.spyOn(blocks, 'deriveArticle').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    try {
      await capture(w);
      expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    } finally {
      derive.mockRestore();
    }
    expect(textOf(w)).toEqual({ text_state: 'failed', fail_reason: 'not_readable' });
    expect(w.ops()).toContain('delete_wrap');
  });

  test('the browser’s fields past their lengths are fitted, as a parsed page’s are; its guard stands for a short text', async () => {
    const w = world();
    w.ports.markdown = async () => parsedAs('A short note.', false);
    await capture(w, { title: 'T'.repeat(1_000), byline: 'B'.repeat(500), lang: 'x'.repeat(50) });
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(w.db.get('SELECT text_state, length(title) AS title, length(byline) AS byline, lang FROM items WHERE hash = ?', hash))
      .toEqual({ text_state: 'cached', title: FIELD_MAX.title, byline: FIELD_MAX.byline, lang: null });
  });

  test('a parser whose renderer the system killed leaves the capture to be read again at the next drain', async () => {
    const w = world();
    let gone = true;
    const markdown = w.ports.markdown;
    w.ports.markdown = async (html, url) => (gone ? { ok: false, reason: 'renderer_gone' } : markdown(html, url));
    await capture(w);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    expect(textOf(w)).toEqual({ text_state: 'fetching', fail_reason: null });
    gone = false;
    w.tick(60);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(textOf(w)).toEqual({ text_state: 'cached', fail_reason: null });
    expect(w.texts.get(hash)).toContain('# Captured');
    expect(w.ops()).toContain('delete_wrap');
  });

  test('a renderer gone at every drain keeps the capture as a blob that failed, then fetches the page once its 14 days are past', async () => {
    const w = world();
    w.ports.markdown = async () => ({ ok: false, reason: 'renderer_gone' });
    const wrap = await capture(w);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 1 });
    // past the week a wrap may wait for, it is still this save's capture, never filed as someone else's message
    for (let day = 1; day <= 13; day++) {
      w.tick(86_400);
      expect([day, await drainInbox(w.ports, w.owner)]).toEqual([day, { failed_blob: 1 }]);
    }
    expect(w.db.get('SELECT outcome FROM inbox_seen WHERE wrap_id = ?', wrap)).toEqual({ outcome: 'failed_blob' });
    expect(textOf(w)).toEqual({ text_state: 'fetching', fail_reason: null });
    expect(pendingParses(w.db, w.owner)).toEqual([]);
    // the capture's 14 days past: the save fetches its page as a request without HTML does, and the wrap closes
    w.tick(86_400);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 1 });
    expect(textOf(w)).toEqual({ text_state: 'queued', fail_reason: null });
    expect(pendingParses(w.db, w.owner).map((p) => p.url)).toEqual(['https://example.com/a']);
    expect(w.ops()).toContain('delete_wrap');
    expect(await drainInbox(w.ports, w.owner)).toEqual({});
  });

  test('a gone renderer is one word, page.ts’s, which the native parser sends and a capture and a page read alike', async () => {
    // the inbox kept a copy of its own, so a change to either left the other reading a gone renderer as a failed parse
    const gone = { ok: false, reason: RENDERER_GONE } as const;
    expect(await fromBrowser({ markdown: async () => gone }, world().request(), '<p>x</p>')).toEqual({ kind: 'offline', timedOut: true });
    expect(await parseHtml({ parse: async () => gone }, new Uint8Array([60]), 'text/html', 'https://example.com/a')).toEqual({ kind: 'offline', timedOut: true });
    const parser = readFileSync(join(__dirname, '..', 'modules', 'kefli-parser', 'android', 'src', 'main', 'java', 'app', 'kefli', 'parser', 'Parser.kt'), 'utf8');
    expect(parser).toContain(`"${RENDERER_GONE}"`);
    expect(readFileSync(join(__dirname, '..', 'src', 'services', 'inbox.ts'), 'utf8')).not.toContain(`'${RENDERER_GONE}'`);
  });

  test('once the renderer has gone, the drain’s other captures wait for the next drain unread, and arrive once it is back', async () => {
    const w = world();
    let gone = true;
    const markdown = w.ports.markdown;
    let asked = 0;
    w.ports.markdown = async (html, url) => (asked++, gone ? { ok: false, reason: 'renderer_gone' } : markdown(html, url));
    let reads = 0;
    const served = w.ports.fetch;
    w.ports.fetch = (async (url: string, init?: RequestInit) => (reads++, served(url, init))) as never;
    for (const path of ['a', 'b', 'c']) {
      const { html } = await w.withHtml(`<h1>${path}</h1>`);
      await w.send(w.request({ url: `https://example.com/${path}`, html }));
    }
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 3 });
    expect([asked, reads]).toEqual([1, 1]);
    // the retries wait the same way, the first asking the parser again
    w.tick(60);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ failed_blob: 3 });
    expect([asked, reads]).toEqual([2, 2]);
    gone = false;
    w.tick(60);
    expect(await drainInbox(w.ports, w.owner)).toEqual({ created: 3 });
    expect(['a', 'b', 'c'].map((path) => w.item(itemHash(`https://example.com/${path}`))?.text_state)).toEqual(['cached', 'cached', 'cached']);
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
