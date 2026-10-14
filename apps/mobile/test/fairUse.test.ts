// Fair use on the phone (contract 1.12 sections 4.1, 4.2, 5; flow decision 117): phones on one library whose
// operator refuses texts for room. The relays, the operator's Blossom server and a mirror are one shared world; each
// phone has its own database, outbox, staged blobs and text files, and runs as the app does: the outbox, a sync, the
// pending parses, the outbox again.
import { LocalSigner, buildDeletions, buildItemEvent, encryptText, itemHash, normaliseMarkdown, readItemEvent, replaces, textHash } from '@kefli/protocol';
import type { NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { bytesToHex } from '@noble/hashes/utils.js';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, queueSave } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { release } from '../src/data/outbox';
import { setArchived } from '../src/data/library';
import { notBackedUp } from '../src/data/backup';
import { drain, type SendPorts } from '../src/services/send';
import { syncInbound, type Filter, type SyncPorts } from '../src/services/sync';
import { runPendingParses, type PendingPorts } from '../src/services/pending';
import { memoryDb } from './sqlite';

const D = {
  v: 1 as const, operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' },
  relays: ['ws://a', 'ws://b'], indexer: ['ws://idx'], mirrors: ['http://m1'],
};
const T = { api: D.operator.api, blossom: D.operator.blossom, mirror: D.mirrors[0] };
const DAY = 86_400;
const URL_A = 'https://example.com/a';
const HASH = itemHash(URL_A);
const LONG = Array.from({ length: 130 }, (_, i) => `word${i}`).join(' ');
const FIGURES = { quota: 52_428_800, used: 52_428_000, daily: 20_971_520, today: 0 };

function matches(e: NostrEvent, f: Filter): boolean {
  const tag = (k: string, vs?: string[]) => !vs || e.tags.some((t) => t[0] === k && vs.includes(t[1]));
  return f.kinds.includes(e.kind) && (!f.authors || f.authors.includes(e.pubkey)) && tag('t', f['#t']) && tag('k', f['#k']) && tag('d', f['#d'])
    && (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until);
}

/** The relays, the operator's server (full while `full` is set) and the mirror, shared by every phone. */
function cloud() {
  let clock = 10_000;
  const relays = new Map<string, NostrEvent[]>();
  const sent: { phone: string; event: NostrEvent }[] = [];
  const operator = new Map<string, Uint8Array>();
  const mirror = new Map<string, Uint8Array>();
  const uploads: { phone: string; sha: string; ok: boolean }[] = [];
  const state = { full: true as boolean };
  const stores: Record<string, Map<string, Uint8Array>> = { 'http://blossom': operator, 'http://m1': mirror };
  const fetchFor = (phone: string) => (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(url);
    if (url === `${D.operator.api}/register`) return new Response('{}', { status: 200 });
    if (method === 'PUT' && u.pathname === '/upload') {
      const bytes = new Uint8Array(init.body as ArrayBuffer);
      const sha = bytesToHex(nodeCrypto.sha256(bytes));
      uploads.push({ phone, sha, ok: !state.full });
      if (state.full) return new Response(JSON.stringify({ v: 1, error: 'quota', ...FIGURES }), { status: 413, headers: { 'X-Reason': 'quota' } });
      operator.set(sha, bytes);
      return new Response(JSON.stringify({ sha256: sha }), { status: 200 });
    }
    if (method === 'PUT' && u.pathname === '/mirror') {
      const sha = String(JSON.parse(String(init.body)).url).split('/').pop()!;
      const bytes = operator.get(sha);
      if (!bytes) return new Response('{"v":1,"error":"not found upstream"}', { status: 404 });
      mirror.set(sha, bytes);
      return new Response(JSON.stringify({ sha256: sha }), { status: 200 });
    }
    const store = stores[u.origin];
    const sha = u.pathname.slice(1);
    if (method === 'DELETE') return new Response('', { status: store?.delete(sha) ? 200 : 404 });
    const b = store?.get(sha);
    return b ? new Response(b as unknown as BodyInit, { status: 200 }) : new Response('', { status: 404 });
  }) as unknown as typeof fetch;
  const publishFor = (phone: string) => async (relay: string, event: NostrEvent) => {
    const list = relays.get(relay) ?? [];
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    const same = (e: NostrEvent) => e.kind === event.kind && e.pubkey === event.pubkey && e.tags.some((t) => t[0] === 'd' && t[1] === d);
    // addressable (NIP-01): a copy replaces the held one only when it is newer, a tie going to the lower id
    const held = event.kind === 30078 && d ? list.find(same) : undefined;
    if (held && !replaces(event, held)) return { ok: true as const };
    relays.set(relay, [...(held ? list.filter((e) => !same(e)) : list), event]);
    if (event.kind === 30078 && d?.startsWith('kefli/item/') && relay === 'ws://a') sent.push({ phone, event });
    return { ok: true as const };
  };
  const query = async (relay: string, filters: Filter[]) => (relays.get(relay) ?? []).filter((e) => filters.some((f) => matches(e, f)));
  return { relays, sent, operator, mirror, uploads, state, fetchFor, publishFor, query, now: () => clock, tick: (s: number) => (clock += s) };
}

type Cloud = ReturnType<typeof cloud>;
const KEY = '0b'.repeat(32);

/** A phone on the library held by sk, its text of URL_A parsed from the same page as any other phone's. */
function phone(c: Cloud, sk: Uint8Array, name: string) {
  const db = memoryDb();
  migrate(db);
  const signer = new LocalSigner(sk.slice());
  const pk = signer.pubkey();
  ensureIdentityRow(db, 1, pk, 'recovery_code', true);
  seedGeneratedLists(db, pk, D);
  // both phones learnt the library's key and registration long ago (C§4.3)
  db.run('UPDATE identities SET registered_at = 1, library_key = ?, library_key_at = 1 WHERE pubkey = ?', KEY, pk);
  const staged = new Map<string, Uint8Array>();
  const files = new Map<string, string>();
  const signerOf = async (k: string) => (k === pk ? signer : null);
  const send: SendPorts = {
    db, now: c.now, signer: signerOf, fetch: c.fetchFor(name), crypto: nodeCrypto, defaults: () => D, publish: c.publishFor(name),
    readBlob: async (s) => staged.get(s) ?? null, query: c.query,
  };
  const sync: SyncPorts = {
    db, now: c.now, signer: signerOf, query: c.query, fetch: c.fetchFor(name), crypto: nodeCrypto, defaults: async () => D,
    files: { writeText: (h, md) => files.set(h, md), removeText: (h) => files.delete(h), removeAll: (h) => files.delete(h) },
  };
  const pageFetch = (async (url: string) => {
    const res = new Response('<html><body>the page</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    Object.defineProperty(res, 'url', { value: url });
    return res;
  }) as unknown as typeof fetch;
  const pending: PendingPorts = {
    db, now: c.now,
    page: { fetch: pageFetch, parse: async () => ({ ok: true, title: 'A page', byline: null, site: 'example.com', lang: 'en', hero: null, canonical: null, readerable: true, markdown: `${LONG}\n` }) },
    x: { fetch: (async () => { throw new Error('offline'); }) as never },
    crypto: nodeCrypto,
    stage: (sha, bytes) => (staged.set(sha, bytes), `/staging/${sha}`),
    unstage: (path) => void staged.delete(path.split('/').pop()!),
    writeText: (h, md) => files.set(h, md),
    targets: async () => T,
  };
  /** A share of the page, parsed here: its text staged, its rows released as the Saved sheet closes. */
  async function share(): Promise<string> {
    const md = normaliseMarkdown(`${LONG}\n`);
    const enc = await encryptText(md, nodeCrypto);
    staged.set(enc.text.sha256, enc.blob);
    const held = queueSave(db, c.now(), {
      owner: pk, hash: HASH, url: URL_A, canonical: null, title: 'A page', site: 'example.com', byline: null, savedAt: c.now(), words: 130,
      lang: 'en', hero: null, text: enc.text, textHash: textHash(md, nodeCrypto), textState: 'cached', origin: 'share',
    }, { sha256: enc.text.sha256, size: enc.blob.length, path: `/staging/${enc.text.sha256}` }, T);
    release(db, held);
    files.set(HASH, md);
    return enc.text.sha256;
  }
  /** What the app does when it comes to the front: the outbox, a sync, the pending parses, the outbox again. */
  async function cycle(): Promise<void> {
    await drain(send);
    await syncInbound(sync);
    await runPendingParses(pending, pk);
    await drain(send);
  }
  const row = () => db.get<{ text_sha256: string | null; text_state: string; state: string; dirty: number; words: number | null }>(
    'SELECT text_sha256, text_state, state, dirty, words FROM items WHERE hash = ?', HASH);
  const blobOps = () => db.all<{ op: string; subject: string }>("SELECT op, subject FROM outbox WHERE op IN ('upload_blob', 'mirror_blob') ORDER BY id");
  return { db, signer, pk, staged, files, send, sync, pending, share, cycle, row, blobOps, name };
}

/** The newest copy of the save on a relay the operator doesn't run, as another phone reads it. */
async function newest(c: Cloud, signer: LocalSigner) {
  const e = (c.relays.get('ws://a') ?? []).filter((x) => x.kind === 30078 && x.tags.some((t) => t[0] === 'd' && t[1].startsWith('kefli/item/'))).at(-1)!;
  return (await readItemEvent(signer, e)).item.item;
}

describe('a text the operator refuses (C§4.2, v1.12)', () => {
  test('a save from another phone without its text is parsed here, and goes out again only once its text is taken', async () => {
    const c = cloud();
    const sk = nodeCrypto.randomBytes(32);
    const a = phone(c, sk, 'A');
    const b = phone(c, sk, 'B');
    await a.share();
    await a.cycle();
    expect((await newest(c, a.signer)).text).toBeNull();
    // B parses the page itself; the operator refuses its text too, and B sends nothing: the text was all it had new
    await b.cycle();
    expect(b.row()).toMatchObject({ text_state: 'cached', dirty: 0 });
    expect(c.uploads.map((u) => [u.phone, u.ok])).toEqual([['A', false], ['B', false]]);
    expect(c.sent.map((s) => s.phone)).toEqual(['A']);
    expect(notBackedUp(b.db, b.pk)).toBe(1);
    // room is made before A's day is up: B's upload goes on its day, and the save goes again naming B's text on both
    c.state.full = false;
    a.db.run("UPDATE outbox_targets SET next_at = 1e12 WHERE outbox_id IN (SELECT id FROM outbox WHERE op = 'upload_blob')");
    c.tick(DAY + 60);
    await b.cycle();
    const item = await newest(c, a.signer);
    expect(item.text).toMatchObject({ sha256: b.row()!.text_sha256, servers: ['http://blossom', 'http://m1'] });
    expect(c.sent.map((s) => s.phone)).toEqual(['A', 'B']);
    expect(notBackedUp(b.db, b.pk)).toBe(0);
  });

  test('two phones on one full library take no turns sending the save without its text, and leave no upload behind', async () => {
    const c = cloud();
    const sk = nodeCrypto.randomBytes(32);
    const a = phone(c, sk, 'A');
    const b = phone(c, sk, 'B');
    const textA = await a.share();
    await a.cycle();
    c.tick(100);
    await b.cycle();
    // many returns to the front later, still full: nothing more goes out, and each text was offered once
    for (let i = 0; 5 > i; i++) {
      c.tick(600);
      await a.cycle();
      await b.cycle();
    }
    expect(c.sent.map((s) => s.phone)).toEqual(['A']);
    expect(c.uploads.map((u) => u.phone)).toEqual(['A', 'B']);
    expect(a.row()!.text_sha256).toBe(textA);
    expect(b.row()!.text_sha256).not.toBe(textA);
    // room comes back: A's day comes first, its text goes, and the save goes out again naming it
    c.state.full = false;
    c.tick(DAY - 3100 + 10);
    await a.cycle();
    expect((await newest(c, a.signer)).text?.sha256).toBe(textA);
    // B, its own day not yet come, takes A's copy: its waiting upload is cancelled, never sent, and it fetches A's text
    await b.cycle();
    expect(b.row()).toMatchObject({ text_sha256: textA, text_state: 'cached' });
    expect(b.blobOps()).toEqual([]);
    c.tick(DAY);
    await b.cycle();
    await a.cycle();
    expect(c.uploads.filter((u) => u.ok).map((u) => [u.phone, u.sha])).toEqual([['A', textA]]);
    expect([...c.operator.keys()]).toEqual([textA]);
    expect(c.sent.map((s) => s.phone)).toEqual(['A', 'A']);
    expect([notBackedUp(a.db, a.pk), notBackedUp(b.db, b.pk)]).toEqual([0, 0]);
  });

  test("two phones that both upload once room is back settle on the newer copy's text, the other's blob deleted", async () => {
    const c = cloud();
    const sk = nodeCrypto.randomBytes(32);
    const a = phone(c, sk, 'A');
    const b = phone(c, sk, 'B');
    await a.share();
    await a.cycle();
    await b.cycle();
    c.state.full = false;
    c.tick(DAY + 10);
    // both days have come: each phone's own text goes before it reads the other's
    await a.cycle();
    await b.cycle();
    await a.cycle();
    await b.cycle();
    expect(a.row()!.text_sha256).toBe(b.row()!.text_sha256);
    const kept = a.row()!.text_sha256!;
    expect([...c.operator.keys()]).toEqual([kept]);
    expect([...c.mirror.keys()].filter((s) => s !== kept)).toEqual([]);
    expect([a.blobOps(), b.blobOps()]).toEqual([[], []]);
    expect(a.db.get("SELECT 1 FROM outbox WHERE op = 'delete_blob'")).toBeUndefined();
    expect(b.db.get("SELECT 1 FROM outbox WHERE op = 'delete_blob'")).toBeUndefined();
  });

  test('a change made on the other phone meanwhile goes out without the text, and the phone holding the text keeps it', async () => {
    const c = cloud();
    const sk = nodeCrypto.randomBytes(32);
    const a = phone(c, sk, 'A');
    const b = phone(c, sk, 'B');
    const textA = await a.share();
    await a.cycle();
    c.tick(100);
    await b.cycle();
    // B archives the save: its text isn't the operator's either, so the archive goes out without one
    c.tick(100);
    release(b.db, setArchived(b.db, c.now(), b.pk, HASH, true).held);
    await drain(b.send);
    expect(await newest(c, a.signer)).toMatchObject({ state: 'archived', text: null });
    // A takes the archive and keeps its own text, which still waits: nothing goes out from A yet
    await a.cycle();
    expect(a.row()).toMatchObject({ state: 'archived', text_sha256: textA, text_state: 'cached', words: 130, dirty: 0 });
    expect(c.sent.map((s) => s.phone)).toEqual(['A', 'B']);
    // A's text goes on its day, and the save goes out archived and naming it; B takes that and drops its own
    c.state.full = false;
    c.tick(DAY - 200 + 10);
    await a.cycle();
    expect(await newest(c, a.signer)).toMatchObject({ state: 'archived', text: { sha256: textA } });
    await b.cycle();
    expect(b.row()).toMatchObject({ state: 'archived', text_sha256: textA });
    expect(b.blobOps()).toEqual([]);
  });
});

describe('a save deleted on another phone while its text waits here (C§4.1, v1.12)', () => {
  test('the waiting upload is cancelled and never sent; an upload that got there is deleted from where it went', async () => {
    const c = cloud();
    const sk = nodeCrypto.randomBytes(32);
    const a = phone(c, sk, 'A');
    const b = phone(c, sk, 'B');
    await a.share();
    await a.cycle();
    await b.cycle();
    expect(b.blobOps().map((o) => o.op)).toEqual(['upload_blob', 'mirror_blob']);
    // A deletes it: its kind 5 reaches the relays (A's own waiting upload is A's business)
    const [del] = await buildDeletions(a.signer, [a.db.get<{ remote_d: string }>('SELECT remote_d FROM items')!.remote_d], c.now() + 1);
    for (const r of ['ws://op', 'ws://a', 'ws://b']) await c.publishFor('A')(r, del);
    c.tick(10);
    await b.cycle();
    expect(b.row()).toBeUndefined();
    expect(b.blobOps()).toEqual([]);
    c.state.full = false;
    c.tick(DAY + 10);
    await b.cycle();
    expect(c.uploads.filter((u) => u.phone === 'B')).toHaveLength(1);

    // the same, once B's upload had got to the operator before the deletion came: B deletes its own copy there
    const c2 = cloud();
    const a2 = phone(c2, sk, 'A');
    const b2 = phone(c2, sk, 'B');
    await a2.share();
    await a2.cycle();
    // room comes while A's text waits for its day: B's text gets there and the save names it
    c2.state.full = false;
    await b2.cycle();
    const mine = b2.row()!.text_sha256!;
    expect(c2.operator.has(mine)).toBe(true);
    const [del2] = await buildDeletions(a2.signer, [a2.db.get<{ remote_d: string }>('SELECT remote_d FROM items')!.remote_d], c2.now() + 1000);
    for (const r of ['ws://op', 'ws://a', 'ws://b']) await c2.publishFor('A')(r, del2);
    c2.tick(2000);
    await b2.cycle();
    await drain(b2.send);
    expect(b2.row()).toBeUndefined();
    expect(c2.operator.has(mine)).toBe(false);
    expect(c2.mirror.has(mine)).toBe(false);
  });
});

describe('a phone that holds the text and a newer copy without it (C§4.1, v1.12)', () => {
  /** A newer copy of the save without its text, as a phone whose own text was refused sends it. */
  async function textless(c: Cloud, sk: Uint8Array, createdAt: number, progress = 0.5, state: 'unread' | 'archived' = 'unread', to = ['ws://op', 'ws://a', 'ws://b']) {
    const signer = new LocalSigner(sk.slice());
    const item = {
      v: 1 as const, url: URL_A, canonical: null, title: 'Retitled', site: 'example.com', byline: null, saved_at: 10_000, state,
      progress, words: 200, lang: 'en', text: null, text_hash: null, hero: null, source_kind: 'web' as const, audio_pref: null,
    };
    const { event } = await buildItemEvent(signer, HASH, { item, extra: {} }, createdAt, new Uint8Array(Buffer.from(KEY, 'hex')));
    for (const r of to) await c.publishFor('other')(r, event);
  }

  test('a copy without text read beside the deletion that followed it leaves the save deleted, the text kept from no one', async () => {
    const c = cloud();
    c.state.full = false;
    const sk = nodeCrypto.randomBytes(32);
    const a = phone(c, sk, 'A');
    const text = await a.share();
    await a.cycle();
    // another phone, without the text, archives the save and then deletes it; a relay keeps the copy beside the kind 5
    c.tick(100);
    await textless(c, sk, c.now(), 0.5, 'archived');
    c.tick(5);
    const [del] = await buildDeletions(a.signer, [a.db.get<{ remote_d: string }>('SELECT remote_d FROM items')!.remote_d], c.now());
    for (const r of ['ws://op', 'ws://a', 'ws://b']) await c.publishFor('other')(r, del);
    c.tick(60);
    await a.cycle();
    // the deletion wins: A sends nothing that would bring the save back, and its copy of the text goes from the servers
    expect(a.row()).toBeUndefined();
    expect(c.sent.filter((s) => s.phone === 'A')).toHaveLength(1);
    expect([c.operator.has(text), c.mirror.has(text)]).toEqual([false, false]);
  });

  test('two copies without text from relays that differ: the newer one is taken, and the text named with its changes', async () => {
    const c = cloud();
    c.state.full = false;
    const sk = nodeCrypto.randomBytes(32);
    const a = phone(c, sk, 'A');
    const text = await a.share();
    await a.cycle();
    // a relay that lags still has the older copy; the others have the newer, archived and read further
    c.tick(100);
    await textless(c, sk, c.now(), 0.2, 'unread', ['ws://b']);
    c.tick(50);
    await textless(c, sk, c.now(), 0.7, 'archived', ['ws://op', 'ws://a']);
    c.tick(60);
    await a.cycle();
    expect(a.db.get('SELECT state, progress, text_sha256 FROM items')).toEqual({ state: 'archived', progress: 0.7, text_sha256: text });
    expect(await newest(c, a.signer)).toMatchObject({ state: 'archived', progress: 0.7, text: { sha256: text } });
  });

  test('a text already backed up is kept and named again at once', async () => {
    const c = cloud();
    c.state.full = false;
    const sk = nodeCrypto.randomBytes(32);
    const a = phone(c, sk, 'A');
    const text = await a.share();
    await a.cycle();
    c.tick(100);
    await textless(c, sk, c.now());
    c.tick(10);
    await a.cycle();
    // the other phone's title and place are taken, the text and its words stay, and the save names the text again
    expect(a.row()).toMatchObject({ text_sha256: text, text_state: 'cached', words: 130, dirty: 0 });
    expect(a.db.get('SELECT title, position_word FROM items')).toEqual({ title: 'Retitled', position_word: 65 });
    expect(await newest(c, a.signer)).toMatchObject({ title: 'Retitled', text: { sha256: text, servers: ['http://blossom', 'http://m1'] } });
    expect(notBackedUp(a.db, a.pk)).toBe(0);
  });

  test('a text whose upload waits is kept, counted as not backed up, and named once the operator and the mirror hold it', async () => {
    const c = cloud();
    const sk = nodeCrypto.randomBytes(32);
    const a = phone(c, sk, 'A');
    const text = await a.share();
    await a.cycle();
    c.tick(100);
    await textless(c, sk, c.now());
    c.tick(10);
    await a.cycle();
    expect(a.row()).toMatchObject({ text_sha256: text, dirty: 0 });
    expect(c.sent.filter((s) => s.phone === 'A')).toHaveLength(1);
    expect(notBackedUp(a.db, a.pk)).toBe(1);
    c.state.full = false;
    c.tick(DAY);
    await a.cycle();
    expect(await newest(c, a.signer)).toMatchObject({ title: 'Retitled', text: { sha256: text, servers: ['http://blossom', 'http://m1'] } });
    expect(notBackedUp(a.db, a.pk)).toBe(0);
  });

  test('a text a mirror holds while the operator refuses it, as after a move, is named again at once, on the mirror', async () => {
    const c = cloud();
    const sk = nodeCrypto.randomBytes(32);
    const a = phone(c, sk, 'A');
    const text = await a.share();
    // as a move leaves a text the old identity had backed up: the operator refuses it, a mirror holds it
    c.mirror.set(text, a.staged.get(text)!);
    a.db.run("UPDATE blobs SET mirror_at = 1, mirror_url = 'http://m1'");
    await a.cycle();
    expect(await newest(c, a.signer)).toMatchObject({ text: { sha256: text, servers: ['http://m1'] } });
    c.tick(100);
    await textless(c, sk, c.now());
    c.tick(10);
    await a.cycle();
    expect(await newest(c, a.signer)).toMatchObject({ title: 'Retitled', text: { sha256: text, servers: ['http://m1'] } });
    expect(notBackedUp(a.db, a.pk)).toBe(0);
  });

  test("a text this phone only had from the servers, not yet fetched, isn't held: the copy is taken and the page parsed", async () => {
    const c = cloud();
    c.state.full = false;
    const sk = nodeCrypto.randomBytes(32);
    const a = phone(c, sk, 'A');
    const b = phone(c, sk, 'B');
    await a.share();
    await a.cycle();
    // B learns of the save with its text, but the text's servers are down for it
    const down = b.sync.fetch;
    b.sync.fetch = (async () => { throw new Error('down'); }) as never;
    await syncInbound(b.sync);
    expect(b.row()).toMatchObject({ text_state: 'remote' });
    b.sync.fetch = down;
    c.tick(100);
    await textless(c, sk, c.now());
    await syncInbound(b.sync);
    expect(b.row()).toMatchObject({ text_sha256: null, text_state: 'queued' });
  });
});
