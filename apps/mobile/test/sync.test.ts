import {
  LocalSigner, SignerSlot, buildDeletions, buildDevicesEvent, buildRelayList, buildItemEvent, buildServerList, encryptText, LIST_MAX, normaliseMarkdown, savedD, textHash,
} from '@kefli/protocol';
import type { Item, NostrEvent, ParsedItem, Signer } from '@kefli/protocol';
import { commitDelete, deleteItem } from '../src/data/library';
import { nodeCrypto } from '@kefli/protocol/node';
import { bytesToHex } from '@noble/hashes/utils.js';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { addRelay, listServers, nextListTime, seedGeneratedLists, writeRelays } from '../src/data/lists';
import { TEXT_SERVERS_MAX, applyItem, getCursor, itemColumns, type TextJob } from '../src/data/sync';
import { SKEW, TEXT_MAX_BYTES, TEXT_TIMEOUT_MS, fetchText, pageStream, streamFilter, syncInbound, takeNewerLists, type Filter, type SyncPorts } from '../src/services/sync';
import { drain, sendOne, type SendPorts } from '../src/services/send';
import { memoryDb } from './sqlite';

const D = {
  v: 1, operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' },
  relays: ['ws://a', 'ws://b'], indexer: ['ws://idx'], mirrors: ['http://m1'],
};
const h = (n: number) => n.toString(16).padStart(64, '0');

/** A relay as NIP-01 describes it: newest first, at most limit, and some send fewer (cap). */
function matches(e: NostrEvent, f: Filter) {
  const tag = (k: string, vs?: string[]) => !vs || e.tags.some((t) => t[0] === k && vs.includes(t[1]));
  return f.kinds.includes(e.kind) && (f.authors ?? []).includes(e.pubkey) && tag('t', f['#t']) && tag('k', f['#k'])
    && (f.since === undefined || e.created_at >= f.since) && (f.until === undefined || e.created_at <= f.until);
}

function world() {
  const db = memoryDb();
  migrate(db);
  const sk = nodeCrypto.randomBytes(32);
  const signer = new LocalSigner(sk.slice());
  const pk = signer.pubkey();
  ensureIdentityRow(db, 1, pk, 'block_store', true);
  seedGeneratedLists(db, pk, D);
  let clock = 1_000;
  const relays = new Map<string, NostrEvent[]>([['ws://op', []], ['ws://a', []], ['ws://b', []], ['ws://idx', []], ['ws://x', []]]);
  const caps = new Map<string, number>();
  const down = new Set<string>();
  const queries: { relay: string; filter: Filter }[] = [];
  const blobs = new Map<string, Map<string, Uint8Array | number>>([['http://blossom', new Map()], ['http://m1', new Map()]]);
  const files = new Map<string, string>();
  const removed: string[] = [];
  const held: [string, number][] = [];
  let open: string | null = null;
  const fetch = (async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const server = blobs.get(u.origin);
    if (!server) throw new Error(`no route to ${u.origin}`);
    const sha = u.pathname.slice(1);
    if (init?.method === 'DELETE') return new Response('', { status: server.delete(sha) ? 200 : 404 });
    const b = server.get(sha);
    if (typeof b === 'number') return new Response('', { status: b });
    return b ? new Response(b as unknown as BodyInit, { status: 200 }) : new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const ports: SyncPorts = {
    db, now: () => clock, signer: async (k) => (k === pk ? signer : null), fetch, crypto: nodeCrypto, defaults: async () => D,
    query: async (relay, filters) => {
      if (down.has(relay)) throw new Error('unreachable');
      const f = filters[0];
      queries.push({ relay, filter: f });
      const all = (relays.get(relay) ?? []).filter((e) => matches(e, f)).sort((a, b) => b.created_at - a.created_at);
      return all.slice(0, Math.min(f.limit ?? Infinity, caps.get(relay) ?? Infinity));
    },
    files: {
      writeText: (hash, md) => files.set(hash, md),
      removeText: (hash) => { files.delete(hash); removed.push(`text:${hash}`); },
      removeAll: (hash) => { files.delete(hash); removed.push(`all:${hash}`); },
    },
    openHash: () => open,
    onHeldWord: (hash, w) => held.push([hash, w]),
  };
  return {
    db, signer, sk, pk, ports, relays, caps, down, queries, blobs, files, removed, held, fetch,
    tick: (s: number) => (clock += s), setOpen: (x: string | null) => (open = x),
    publish(e: NostrEvent, to = ['ws://op', 'ws://a', 'ws://b']) {
      for (const r of to) relays.get(r)!.push(e);
    },
  };
}

type W = ReturnType<typeof world>;

function item(over: Partial<Item> = {}): ParsedItem {
  return {
    item: {
      v: 1, url: 'https://example.com/a', canonical: null, title: 'A title', site: 'example.com', byline: null, saved_at: 5000,
      state: 'unread', progress: 0.5, words: 10, lang: 'en', text: null, text_hash: null, hero: null, source_kind: 'web', audio_pref: null,
      ...over,
    },
    extra: {},
  };
}

/** A save from "the other phone": its text uploaded to the operator and mirror, its event built. */
async function remoteSave(w: W, hash: string, createdAt: number, markdown: string | null, over: Partial<Item> = {}) {
  let text = null;
  if (markdown !== null) {
    const md = normaliseMarkdown(markdown);
    const enc = await encryptText(md, nodeCrypto);
    for (const s of w.blobs.values()) s.set(enc.text.sha256, enc.blob);
    text = { ...enc.text, servers: ['http://blossom', 'http://m1'] };
    over = { text_hash: textHash(md, nodeCrypto), ...over };
  }
  const { event } = await buildItemEvent(w.signer, hash, item({ text, ...over }), createdAt);
  return event;
}

const row = (w: W, hash: string) => w.db.get<Record<string, unknown>>('SELECT * FROM items WHERE hash = ?', hash);

describe('inbound sync (mobile spec 4.5)', () => {
  test("another phone's save arrives, its text is fetched, and it is searchable", async () => {
    const w = world();
    w.tick(2 * SKEW);
    w.publish(await remoteSave(w, h(1), 6000, '# A title\n\nQuiet words about reading later.'));
    const r = await syncInbound(w.ports);
    expect(r).toEqual({ items: 1, deletions: 0, texts: 1, missing: 0, waiting: 0 });
    expect(row(w, h(1))).toMatchObject({ title: 'A title', state: 'unread', text_state: 'cached', position_word: 5, published: 1, dirty: 0, origin: 'sync' });
    expect(w.files.get(h(1))).toBe('# A title\n\nQuiet words about reading later.\n');
    const hit = w.db.all<{ rowid: number }>("SELECT rowid FROM items_fts WHERE items_fts MATCH 'readi*'");
    expect(hit).toEqual([{ rowid: row(w, h(1))!.id }]);
    // A second run asks from the cursor less a day, and changes nothing.
    w.tick(60);
    expect(await syncInbound(w.ports)).toEqual({ items: 0, deletions: 0, texts: 0, missing: 0, waiting: 0 });
    expect(w.queries.at(-1)!.filter.since).toBe(1_000 + 2 * SKEW - SKEW);
  });

  test('paging reaches every save from a relay that sends fewer than the limit', async () => {
    const w = world();
    const events: NostrEvent[] = [];
    for (let i = 0; 30 > i; i++) events.push(await remoteSave(w, h(100 + i), 6000 + Math.floor(i / 4), null));
    for (const e of events) w.relays.get('ws://a')!.push(e);
    w.caps.set('ws://a', 7);
    const got = await pageStream(w.ports.query, 'ws://a', streamFilter('items', w.pk, null));
    expect(new Set(got.map((e) => e.id)).size).toBe(30);
  });

  test('a newer save replaces a clean row, an older one is ignored, and a tie goes to the lower id', async () => {
    const w = world();
    w.publish(await remoteSave(w, h(2), 6000, null, { title: 'first' }));
    await syncInbound(w.ports);
    w.publish(await remoteSave(w, h(2), 5000, null, { title: 'older' }));
    await syncInbound(w.ports);
    expect(row(w, h(2))!.title).toBe('first');
    const a = await remoteSave(w, h(2), 7000, null, { title: 'x' });
    const b = await remoteSave(w, h(2), 7000, null, { title: 'y' });
    w.publish(a);
    w.publish(b);
    await syncInbound(w.ports);
    expect(row(w, h(2))!.event_id).toBe(a.id < b.id ? a.id : b.id);
  });

  test('a local change newer than the remote is republished above it', async () => {
    const w = world();
    w.publish(await remoteSave(w, h(3), 6000, null));
    await syncInbound(w.ports);
    w.db.run("UPDATE items SET state = 'archived', dirty = 1, modified_at = 9000 WHERE hash = ?", h(3));
    w.publish(await remoteSave(w, h(3), 8000, null, { title: 'other phone' }));
    w.tick(10);
    await syncInbound(w.ports);
    expect(row(w, h(3))).toMatchObject({ state: 'archived', dirty: 1, event_created_at: 8000 });
    expect(w.db.get("SELECT op FROM outbox WHERE subject = ? AND state = 'queued'", h(3))).toEqual({ op: 'publish_item' });
    // A remote newer than the change wins.
    w.publish(await remoteSave(w, h(3), 9500, null, { title: 'newest' }));
    await syncInbound(w.ports);
    expect(row(w, h(3))).toMatchObject({ title: 'newest', state: 'unread', dirty: 0 });
  });

  test('a deletion removes the save and its files, even with a relay that still holds the save', async () => {
    const w = world();
    const save = await remoteSave(w, h(4), 6000, 'Words to be deleted.');
    w.publish(save);
    await syncInbound(w.ports);
    expect(w.files.has(h(4))).toBe(true);
    const [del] = await buildDeletions(w.signer, [`kefli/item/${h(4)}`], 6100);
    w.publish(del, ['ws://op', 'ws://a']);
    w.relays.get('ws://op')!.splice(w.relays.get('ws://op')!.indexOf(save), 1);
    w.tick(60);
    const r = await syncInbound(w.ports);
    expect(r.deletions).toBe(1);
    expect(row(w, h(4))).toBeUndefined();
    expect(w.removed).toContain(`all:${h(4)}`);
    expect(w.db.all("SELECT rowid FROM items_fts WHERE items_fts MATCH 'deleted'")).toEqual([]);
  });

  test('a deletion older than the save leaves it', async () => {
    const w = world();
    w.publish(await remoteSave(w, h(5), 6000, null));
    const [del] = await buildDeletions(w.signer, [`kefli/item/${h(5)}`], 5999);
    w.publish(del);
    await syncInbound(w.ports);
    expect(row(w, h(5))).toBeDefined();
  });

  test('a save from a newer version is held apart and the local copy stops being written', async () => {
    const w = world();
    w.publish(await remoteSave(w, h(6), 6000, null));
    await syncInbound(w.ports);
    w.db.run("INSERT INTO outbox (op, signer, subject, created_at, state, lane) VALUES ('publish_item', ?, ?, 1, 'queued', 'interactive')", w.pk, h(6));
    // The protocol refuses to write v 2, so the newer client's event is built by hand.
    const content = await w.signer.nip44Encrypt(w.pk, JSON.stringify({ ...item().item, v: 2 }));
    w.publish(await w.signer.signEvent({ kind: 30078, created_at: 7000, tags: [['d', `kefli/item/${h(6)}`], ['t', 'kefli']], content }));
    await syncInbound(w.ports);
    expect(row(w, h(6))).toBeUndefined();
    expect(w.db.get('SELECT created_at FROM items_future WHERE d = ?', `kefli/item/${h(6)}`)).toEqual({ created_at: 7000 });
    expect(w.db.get('SELECT 1 FROM outbox WHERE subject = ?', h(6))).toBeUndefined();
  });

  test('the article open in the Reader keeps its place, and the remote one is handed back', async () => {
    const w = world();
    w.publish(await remoteSave(w, h(7), 6000, null, { progress: 0.1 }));
    await syncInbound(w.ports);
    w.setOpen(h(7));
    w.publish(await remoteSave(w, h(7), 7000, null, { progress: 0.9 }));
    await syncInbound(w.ports);
    expect(row(w, h(7))!.position_word).toBe(1);
    expect(w.held).toEqual([[h(7), 9]]);
  });

  test("a replaced text drops the old file and, if this phone uploaded the old blob, deletes it", async () => {
    const w = world();
    const first = await remoteSave(w, h(8), 6000, 'First text.');
    w.publish(first);
    await syncInbound(w.ports);
    const oldSha = row(w, h(8))!.text_sha256 as string;
    w.db.run("INSERT INTO blobs (sha256, hash, kind, owner, operator_at) VALUES (?, ?, 'text', ?, 1)", oldSha, h(8), w.pk);
    w.publish(await remoteSave(w, h(8), 7000, 'Second text.'));
    await syncInbound(w.ports);
    expect(w.removed).toContain(`text:${h(8)}`);
    expect(w.files.get(h(8))).toBe('Second text.\n');
    const job = w.db.get<{ op: string; payload: string }>("SELECT op, payload FROM outbox WHERE op = 'delete_blob'");
    // with when the operator took it, for the room its deletion gives back (C§5)
    expect(job).toEqual({ op: 'delete_blob', payload: JSON.stringify({ sha256: oldSha, up: 1 }) });
    // The sender deletes it from both servers; a server that no longer has it counts as done.
    w.blobs.get('http://m1')!.delete(oldSha);
    const send: SendPorts = {
      db: w.db, now: () => 20_000, signer: w.ports.signer, fetch: w.fetch, crypto: nodeCrypto, defaults: () => D as never,
      publish: async () => ({ ok: true }), readBlob: async () => null,
    };
    // everything due goes, the library key's record (made at this sync, F5) among it
    await drain(send);
    expect(w.blobs.get('http://blossom')!.has(oldSha)).toBe(false);
    expect(w.db.get("SELECT 1 FROM outbox WHERE op = 'delete_blob'")).toBeUndefined();
  });

  test("a text no server has is missing; one behind a failing server waits", async () => {
    const w = world();
    const e = await remoteSave(w, h(9), 6000, 'Text that vanished.');
    w.publish(e);
    for (const s of w.blobs.values()) s.clear();
    await syncInbound(w.ports);
    expect(row(w, h(9))).toMatchObject({ text_state: 'failed', fail_reason: 'blob_missing' });

    const w2 = world();
    w2.publish(await remoteSave(w2, h(9), 6000, 'Text behind a 503.'));
    const sha = [...w2.blobs.get('http://blossom')!.keys()][0];
    w2.blobs.get('http://blossom')!.set(sha, 503);
    w2.blobs.get('http://m1')!.delete(sha);
    await syncInbound(w2.ports);
    expect(row(w2, h(9))!.text_state).toBe('remote');
    // The 10063 servers are tried too, and wrong bytes count as missing there.
    w2.blobs.get('http://blossom')!.set(sha, new Uint8Array([1, 2, 3]));
    const job = w2.db.get<TextJob>("SELECT id, owner, hash, title, site, url, text_sha256, text_key, text_nonce, text_servers FROM items WHERE hash = ?", h(9))!;
    expect(await fetchText(w2.ports, job)).toBe('missing');
  });

  test("an unreachable relay keeps its cursor; others move; strangers' events are dropped", async () => {
    const w = world();
    w.down.add('ws://b');
    const stranger = new LocalSigner(nodeCrypto.randomBytes(32));
    const { event: theirs } = await buildItemEvent(stranger, h(10), item(), 6000);
    w.publish({ ...theirs, pubkey: w.pk });
    const untagged = await remoteSave(w, h(11), 6000, null);
    w.publish({ ...untagged, tags: untagged.tags.filter((t) => t[0] !== 't') });
    await syncInbound(w.ports);
    expect(w.db.get('SELECT COUNT(*) AS n FROM items')).toEqual({ n: 0 });
    expect(getCursor(w.db, 'ws://a', 'items', w.pk)).toEqual({ since: 1_000, backfilled: true });
    expect(getCursor(w.db, 'ws://b', 'items', w.pk)).toBeNull();
  });

  test('a reinstalled identity with no relay rows reads its published lists, and the relays they add', async () => {
    const w = world();
    w.db.run('DELETE FROM relays');
    w.db.run('DELETE FROM servers');
    const list = await buildRelayList(w.signer, [{ url: 'ws://op', read: true, write: true }, { url: 'ws://x', read: true, write: false }], 900);
    w.publish(list, ['ws://idx']);
    w.publish(await remoteSave(w, h(12), 6000, null), ['ws://x']);
    expect((await syncInbound(w.ports)).items).toBe(1);
    expect(w.db.get('SELECT read, write, source FROM relays WHERE url = ?', 'ws://x')).toEqual({ read: 1, write: 0, source: 'user' });
    expect(w.db.get('SELECT event_id FROM lists WHERE kind = 10002')).toEqual({ event_id: list.id });
    // An older copy seen later changes nothing.
    w.publish(await buildRelayList(w.signer, [{ url: 'ws://op', read: true, write: true }], 800), ['ws://a']);
    await syncInbound(w.ports);
    expect(w.db.get('SELECT event_id FROM lists WHERE kind = 10002')).toEqual({ event_id: list.id });
  });

  test('a relay of the person’s own that a newer list drops was removed on another phone, unless added here since (FD 113)', async () => {
    const w = world();
    const base = [{ url: 'ws://op', read: true, write: true }, { url: 'ws://a', read: true, write: true }, { url: 'ws://b', read: true, write: true }];
    w.db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app) VALUES ('ws://x', ?, 1, 1, 'user', 0)", w.pk);
    w.db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app, added_at) VALUES ('ws://y', ?, 1, 1, 'user', 0, 2000)", w.pk);
    w.publish(await buildRelayList(w.signer, base, 1500), ['ws://idx']);
    await syncInbound(w.ports);
    expect(w.db.all<{ url: string }>("SELECT url FROM relays WHERE source = 'user' ORDER BY url")).toEqual([{ url: 'ws://y' }]);
    // Kefli's own entries stay whatever a list says
    expect(w.db.get("SELECT 1 AS n FROM relays WHERE url = 'ws://op'")).toEqual({ n: 1 });
  });

  const RW = { read: true, write: true };
  const BASE = [{ url: 'ws://op', ...RW }, { url: 'ws://a', ...RW }, { url: 'ws://b', ...RW }];
  const relayRow = (w: W, url: string) => w.db.get('SELECT read, write, source, added_by_app, prior FROM relays WHERE url = ?', url);

  test('a newer 10002 naming a relay Kefli holds only as an indexer makes it the person’s own; a later one without it gives the indexer back', async () => {
    const w = world();
    w.publish(await buildRelayList(w.signer, [...BASE, { url: 'ws://idx', read: true, write: false }], 1500), ['ws://idx']);
    w.publish(await remoteSave(w, h(13), 1400, null), ['ws://idx']);
    // read from as the list says, as any relay of theirs is, and its saves arrive
    expect((await syncInbound(w.ports)).items).toBe(1);
    expect(relayRow(w, 'ws://idx')).toEqual({ read: 1, write: 0, source: 'user', added_by_app: 0, prior: JSON.stringify({ read: 0, write: 0, source: 'indexer', added_by_app: 1 }) });
    w.publish(await buildRelayList(w.signer, BASE, 1600), ['ws://a']);
    await syncInbound(w.ports);
    expect(relayRow(w, 'ws://idx')).toEqual({ read: 0, write: 0, source: 'indexer', added_by_app: 1, prior: null });
    // one added in Advanced over the indexer, which another phone then removed, gives the indexer back too
    addRelay(w.db, 1700, w.pk, 'ws://idx', D);
    w.publish(await buildRelayList(w.signer, BASE, 1800), ['ws://a']);
    await syncInbound(w.ports);
    expect(relayRow(w, 'ws://idx')).toEqual({ read: 0, write: 0, source: 'indexer', added_by_app: 1, prior: null });
  });

  test('a newer 10002 changing the marker of a relay of the person’s own is taken in, unless this phone added it since', async () => {
    const w = world();
    const mine = (url: string, read: boolean, write: boolean, addedAt: number | null) =>
      w.db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app, added_at) VALUES (?, ?, ?, ?, 'user', 0, ?)", url, w.pk, +read, +write, addedAt);
    mine('ws://x', true, true, null);
    mine('ws://y', true, true, 2000);
    // z this phone made read and write in Advanced; the list held, and the newer one, still say it is read only
    mine('ws://z', true, true, 900);
    const held = await buildRelayList(w.signer, [...BASE, { url: 'ws://x', ...RW }, { url: 'ws://y', ...RW }, { url: 'ws://z', read: true, write: false }], 1000);
    w.db.run("INSERT INTO lists (owner, kind, d, event_id, created_at, raw) VALUES (?, 10002, '', ?, 1000, ?)", w.pk, held.id, JSON.stringify(held));
    const newer = [{ url: 'ws://x', read: true, write: false }, { url: 'ws://y', read: false, write: true }, { url: 'ws://z', read: true, write: false }];
    // Kefli's own relays keep their markers, whatever a list says
    w.publish(await buildRelayList(w.signer, [{ url: 'ws://op', read: true, write: false }, ...BASE.slice(1), ...newer], 1500), ['ws://idx']);
    await syncInbound(w.ports);
    expect(['ws://op', 'ws://x', 'ws://y', 'ws://z'].map((u) => w.db.get('SELECT read, write FROM relays WHERE url = ?', u)))
      .toEqual([{ read: 1, write: 1 }, { read: 1, write: 0 }, { read: 1, write: 1 }, { read: 1, write: 1 }]);
    expect(writeRelays(w.db, w.pk)).not.toContain('ws://x');
  });

  test('every entry of the list held counts: a relay removed here, past its 50th entry, stays removed when a newer list moves it up', async () => {
    const w = world();
    const others = Array.from({ length: 60 }, (_, i) => ({ url: `ws://r${i}`, ...RW }));
    // the table holds what Kefli uses of the held list, its first LIST_MAX entries; ws://gone, last, was removed here
    for (const r of others.slice(0, LIST_MAX - BASE.length)) w.db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app) VALUES (?, ?, 1, 1, 'user', 0)", r.url, w.pk);
    const held = await buildRelayList(w.signer, [...BASE, ...others, { url: 'ws://gone', ...RW }], 1000);
    w.db.run("INSERT INTO lists (owner, kind, d, event_id, created_at, raw) VALUES (?, 10002, '', ?, 1000, ?)", w.pk, held.id, JSON.stringify(held));
    w.publish(await buildRelayList(w.signer, [...BASE, { url: 'ws://gone', ...RW }, ...others], 1500), ['ws://idx']);
    await syncInbound(w.ports);
    expect(relayRow(w, 'ws://gone')).toBeUndefined();
    expect(writeRelays(w.db, w.pk)).toEqual(expect.arrayContaining(others.slice(0, LIST_MAX - BASE.length - 1).map((r) => r.url)));
  });

  test('a relay added in Advanced stays while a newer list names it, past the most Kefli reads of a list too', async () => {
    const w = world();
    const theirs = Array.from({ length: LIST_MAX + 5 }, (_, i) => ({ url: `ws://r${i}`, ...RW }));
    // a list longer than Kefli reads, the table holding what it reads of it
    const held = await buildRelayList(w.signer, [...BASE, ...theirs], 1000);
    w.db.run("INSERT INTO lists (owner, kind, d, event_id, created_at, raw) VALUES (?, 10002, '', ?, 1000, ?)", w.pk, held.id, JSON.stringify(held));
    for (const r of theirs.slice(0, LIST_MAX - BASE.length)) w.db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app) VALUES (?, ?, 1, 1, 'user', 0)", r.url, w.pk);
    expect(addRelay(w.db, 1100, w.pk, 'ws://mine', D)).toBe(true);
    // the list sent from here names it after theirs, and another app republishes that list as it was
    takeNewerLists(w.db, w.pk, [await buildRelayList(w.signer, [...BASE, ...theirs, { url: 'ws://mine', ...RW }], 1200)], [10002], 1300);
    expect(writeRelays(w.db, w.pk)).toContain('ws://mine');
    expect(relayRow(w, 'ws://mine')).toMatchObject({ read: 1, write: 1, source: 'user' });
    // a relay of theirs past what Kefli reads still isn't one it writes to
    expect(writeRelays(w.db, w.pk)).not.toContain(`ws://r${LIST_MAX}`);
    // one that no longer names it, made after it was added, takes it away
    takeNewerLists(w.db, w.pk, [await buildRelayList(w.signer, [...BASE, ...theirs], 1400)], [10002], 1500);
    expect(writeRelays(w.db, w.pk)).not.toContain('ws://mine');
  });

  test('every server of the 10063 held counts: one removed here, past its 50th, stays removed when a newer 10063 moves it up', async () => {
    const w = world();
    const others = Array.from({ length: 60 }, (_, i) => `http://s${i}`);
    const held = await buildServerList(w.signer, ['http://blossom', 'http://m1', ...others, 'http://gone'], 1000);
    w.db.run("INSERT INTO lists (owner, kind, d, event_id, created_at, raw) VALUES (?, 10063, '', ?, 1000, ?)", w.pk, held.id, JSON.stringify(held));
    w.publish(await buildServerList(w.signer, ['http://blossom', 'http://gone', 'http://new'], 1500), ['ws://idx']);
    await syncInbound(w.ports);
    expect(w.db.all<{ url: string }>('SELECT url FROM servers ORDER BY rowid').map((r) => r.url)).toEqual(['http://blossom', 'http://m1', 'http://new']);
  });

  test('a relay read from the start can’t bring back a save the others deleted long ago (F35)', async () => {
    const w = world();
    // both well before the cursors' day of slack, so only a full read of deletions finds the kind 5 again
    const old = await remoteSave(w, h(20), 200, null, { title: 'Deleted one', saved_at: 200 });
    const [del] = await buildDeletions(w.signer, [`kefli/item/${h(20)}`], 300);
    w.publish(old, ['ws://op', 'ws://a', 'ws://b']);
    w.publish(del, ['ws://op', 'ws://a', 'ws://b']);
    await syncInbound(w.ports);
    expect(row(w, h(20))).toBeUndefined();
    // much later, a relay that missed the deletion joins the list
    w.tick(10 * SKEW);
    w.relays.get('ws://x')!.push(old);
    w.db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app, added_at) VALUES ('ws://x', ?, 1, 1, 'user', 0, ?)", w.pk, w.ports.now());
    await syncInbound(w.ports);
    expect(row(w, h(20))).toBeUndefined();
  });

  test("a badly formed item from another client is read safely", () => {
    const bad = { item: { url: 'https://e.com', title: '', site: 7, state: 'weird', words: -3, progress: 'x', saved_at: null,
      text: { sha256: 'aa', key: 'bb', nonce: 3 }, text_hash: 'th', source_kind: null, hero: 'https://e.com/h.jpg' }, extra: { later: 1 } } as never;
    const c = itemColumns(bad, { created_at: 77 } as NostrEvent);
    expect(c).toMatchObject({ title: null, site: null, state: 'unread', words: null, progress: 0, saved_at: 77, text_sha256: null,
      text_hash: null, source_kind: 'web', hero: 'https://e.com/h.jpg', extra: '{"later":1}', position_word: 0 });
    const good = itemColumns({ item: { ...item().item, words: 9.6, text: { sha256: 'aa'.repeat(32), key: 'bb', nonce: 'cc', servers: ['https://s.example/', 4, 'javascript:x'] } } as never, extra: {} }, { created_at: 1 } as NostrEvent);
    expect(good).toMatchObject({ words: 10, text_servers: '["https://s.example"]', extra: null, position_word: 5 });
  });

  test("another phone's addresses are kept without a user name and password (contract 4.3, ruling 8)", async () => {
    // another client may publish them with one, as a browser's request or an older row held them: the save's link is
    // what Original, Open in browser and the save published again from here are given, and its picture is fetched
    const w = world();
    const named = { url: 'https://reader:hunter2@example.com/a', canonical: 'https://reader:hunter2@example.com/c', hero: 'https://cdn:secret@img.example.com/h.jpg' };
    w.publish(await remoteSave(w, h(1), 6000, null, named));
    await syncInbound(w.ports);
    const kept = () => w.db.get('SELECT url, canonical, hero, title FROM items WHERE hash = ?', h(1));
    expect(kept()).toEqual({ url: 'https://example.com/a', canonical: 'https://example.com/c', hero: 'https://img.example.com/h.jpg', title: 'A title' });
    // so is a newer copy taken over the row
    w.publish(await remoteSave(w, h(1), 7000, null, { ...named, url: 'https://admin:pw@example.com/b', title: 'Newer' }));
    await syncInbound(w.ports);
    expect(kept()).toEqual({ url: 'https://example.com/b', canonical: 'https://example.com/c', hero: 'https://img.example.com/h.jpg', title: 'Newer' });
    // and an address without them is kept exactly as written
    const plain = itemColumns(item({ url: 'https://example.com/a?q=1#x', canonical: 'https://example.com/c', hero: 'https://img.example.com/h.jpg' }), { created_at: 1 } as NostrEvent);
    expect(plain).toMatchObject({ url: 'https://example.com/a?q=1#x', canonical: 'https://example.com/c', hero: 'https://img.example.com/h.jpg' });
  });

  test('a save queued again by a newer copy without text waits afresh, as one never tried (F12)', () => {
    // the pending queue reads timed_out_at as a try before, the 14-day rule's "again" (services/pending.ts): one left
    // from an earlier wait let a save past its 14 days fail at the first time-out after a newer copy queued it again
    const w = world();
    const at = (id: string, created_at: number) => ({ id, created_at, tags: [['d', `kefli/item/${h(1)}`]] }) as unknown as NostrEvent;
    const text = { sha256: 'ab'.repeat(32), key: 'k'.repeat(44), nonce: 'n'.repeat(16), servers: ['http://blossom', 'http://m1'] };
    applyItem(w.db, 100, w.pk, h(1), at('e1', 6000), item());
    expect(row(w, h(1))).toMatchObject({ text_state: 'queued', timed_out_at: null });
    // tried here and couldn't be had; then another phone sends its text, and a newer copy without it before this phone
    // had fetched it
    w.db.run('UPDATE items SET timed_out_at = 6500 WHERE hash = ?', h(1));
    applyItem(w.db, 100, w.pk, h(1), at('e2', 7000), item({ text }));
    expect(row(w, h(1))).toMatchObject({ text_state: 'remote', timed_out_at: null });
    w.db.run('UPDATE items SET timed_out_at = 7500 WHERE hash = ?', h(1));
    applyItem(w.db, 100, w.pk, h(1), at('e3', 8000), item());
    expect(row(w, h(1))).toMatchObject({ text_state: 'queued', timed_out_at: null });
    // a copy that changes nothing of its text leaves the wait as it was
    w.db.run('UPDATE items SET timed_out_at = 8500 WHERE hash = ?', h(1));
    applyItem(w.db, 100, w.pk, h(1), at('e4', 9000), item({ state: 'archived' }));
    expect(row(w, h(1))).toMatchObject({ text_state: 'queued', state: 'archived', timed_out_at: 8500 });
  });

  test('no active identity or no signer: nothing to do', async () => {
    const w = world();
    expect(await syncInbound({ ...w.ports, signer: async () => null })).toEqual({ items: 0, deletions: 0, texts: 0, missing: 0, waiting: 0 });
  });
});

/** The world's signer, whose decrypts fail as an out-of-sight NIP-55 signer's do while `refusing` is set. */
function refusing(w: W) {
  const s = { refusing: 'background' as string | null, asked: 0 };
  const signer: Signer = {
    pubkey: () => w.pk,
    capabilities: async () => ({ nip44: true }),
    signEvent: (e) => w.signer.signEvent(e),
    nip44Encrypt: (peer, text) => w.signer.nip44Encrypt(peer, text),
    nip44Decrypt: async (peer, text) => {
      s.asked++;
      if (s.refusing) throw Object.assign(new Error(s.refusing), { code: s.refusing });
      return w.signer.nip44Decrypt(peer, text);
    },
  };
  w.ports.signer = async (k) => (k === w.pk ? signer : null);
  return s;
}

const cursors = (w: W) => w.db.all('SELECT relay, stream, since FROM sync_cursors ORDER BY relay, stream');

describe('cursors wait for what was collected (F14)', () => {
  test('saves the signer refuses out of sight wait, unasked after the first, and arrive once it answers', async () => {
    const w = world();
    for (let i = 0; 3 > i; i++) w.publish(await remoteSave(w, h(30 + i), 6000 + i, 'Words that wait.'));
    const s = refusing(w);
    const first = await syncInbound(w.ports);
    expect(cursors(w)).toEqual([]);
    expect(s.asked).toBe(1);
    // granted later, far past every save's date: they still come back
    s.refusing = null;
    w.tick(10 * SKEW);
    expect(await syncInbound(w.ports)).toMatchObject({ items: 3, texts: 3, waiting: 0 });
    expect(getCursor(w.db, 'ws://op', 'items', w.pk)).toEqual({ since: 1_000 + 10 * SKEW, backfilled: true });
    expect(first).toMatchObject({ items: 0, waiting: 3 });
  });

  test('a bunker that times out holds the cursors, and the deletions read meanwhile still apply', async () => {
    const w = world();
    w.publish(await remoteSave(w, h(33), 6000, null));
    await syncInbound(w.ports);
    const [del] = await buildDeletions(w.signer, [`kefli/item/${h(33)}`], 7000);
    w.publish(del);
    w.publish(await remoteSave(w, h(34), 7000, null));
    const before = cursors(w);
    const s = refusing(w);
    s.refusing = 'timeout';
    w.tick(60);
    const r = await syncInbound(w.ports);
    expect(cursors(w)).toEqual(before);
    expect(row(w, h(33))).toBeUndefined();
    expect(r).toMatchObject({ items: 0, deletions: 1, waiting: 1 });
  });

  test('a connected-browsers record the signer refuses waits too', async () => {
    const w = world();
    const entry = { device_pubkey: h(1), label: 'Firefox', token: 'd'.repeat(64), connected_at: 6, revoked_at: null };
    w.publish(await buildDevicesEvent(w.signer, { v: 1, devices: [entry] }, 900));
    refusing(w);
    const r = await syncInbound(w.ports);
    expect(cursors(w)).toEqual([]);
    expect(r.waiting).toBe(1);
  });

  test('a key the slot zeroes while the run holds it waits, and a fresh key reads the rest next run', async () => {
    const w = world();
    for (let i = 0; 3 > i; i++) w.publish(await remoteSave(w, h(50 + i), 6000 + i, null));
    // the phone's slot, which builds a fresh key from the key file when it is empty (identity.currentSigner)
    const slot = new SignerSlot(10);
    w.ports.signer = async (k) => {
      if (k !== w.pk) return null;
      if (!slot.get()) slot.set(new LocalSigner(w.sk.slice()));
      return slot.get();
    };
    let calls = 0;
    w.ports.openHash = () => {
      // after the first save: six minutes away, and the return zeroes the key the run still holds (F47)
      if (++calls === 1) {
        slot.background(0);
        slot.foreground(10_000);
      }
      return null;
    };
    const r = await syncInbound(w.ports);
    expect(r).toMatchObject({ items: 1, waiting: 2 });
    expect(cursors(w)).toEqual([]);
    expect(slot.get()).toBeNull();
    w.tick(60);
    expect((await syncInbound(w.ports)).items).toBe(2);
    expect(w.db.get('SELECT COUNT(*) AS n FROM items')).toEqual({ n: 3 });
  });

  test('a run that dies part way through applying moves no cursor', async () => {
    const w = world();
    for (let i = 0; 3 > i; i++) w.publish(await remoteSave(w, h(40 + i), 6000 + i, null));
    let calls = 0;
    w.ports.openHash = () => {
      if (++calls === 2) throw new Error('killed');
      return null;
    };
    await expect(syncInbound(w.ports)).rejects.toThrow('killed');
    expect(cursors(w)).toEqual([]);
    w.ports.openHash = () => null;
    expect((await syncInbound(w.ports)).items).toBe(2);
    expect(w.db.get('SELECT COUNT(*) AS n FROM items')).toEqual({ n: 3 });
  });
});

describe('clocks that disagree (F36)', () => {
  test('a save dated by a clock ten minutes behind this one still arrives', async () => {
    const w = world();
    w.tick(10_000);
    w.publish(await remoteSave(w, h(50), 9_000, null));
    await syncInbound(w.ports);
    // the other phone saves a minute after this sync, by a clock 600 s behind this phone's
    w.publish(await remoteSave(w, h(51), 11_000 + 60 - 600, null));
    w.tick(120);
    const s = refusing(w);
    s.refusing = null;
    expect((await syncInbound(w.ports)).items).toBe(1);
    expect(row(w, h(51))).toBeDefined();
    // the save already here was read again with the overlap, without asking the signer
    expect(s.asked).toBe(1);
  });

  test('a save deleted here stays deleted while its kind 5 waits to go out', async () => {
    const w = world();
    w.publish(await remoteSave(w, h(52), 6000, null));
    await syncInbound(w.ports);
    const change = deleteItem(w.db, 1_010, w.pk, h(52));
    commitDelete(w.db, w.pk, h(52), change.held);
    expect(w.db.get("SELECT state FROM outbox WHERE op = 'delete_item'")).toEqual({ state: 'queued' });
    w.tick(600);
    await syncInbound(w.ports);
    expect(row(w, h(52))).toBeUndefined();
  });
});

describe("the user's 10063 (F37)", () => {
  test('restore reads a text from a server only the published 10063 names, and keeps that server', async () => {
    const w = world();
    w.db.run('DELETE FROM relays');
    w.db.run('DELETE FROM servers');
    w.blobs.set('http://m2', new Map());
    const save = await remoteSave(w, h(60), 6000, 'Kept on the second mirror.');
    const sha = [...w.blobs.get('http://blossom')!.keys()][0];
    const blob = w.blobs.get('http://blossom')!.get(sha)!;
    for (const s of w.blobs.values()) s.clear();
    w.blobs.get('http://m2')!.set(sha, blob);
    w.publish(save);
    w.publish(await buildServerList(w.signer, ['http://blossom', 'http://m2/'], 900), ['ws://idx', 'ws://op']);
    expect(await syncInbound(w.ports)).toMatchObject({ items: 1, texts: 1, missing: 0 });
    expect(w.files.get(h(60))).toBe('Kept on the second mirror.\n');
    expect(w.db.all('SELECT url, role FROM servers ORDER BY rowid')).toEqual([
      { url: 'http://blossom', role: 'operator' }, { url: 'http://m1', role: 'mirror' }, { url: 'http://m2/', role: 'user' },
    ]);
  });

  test("a newer 10063 that drops a server of the person's own removes it; Kefli's own stay", async () => {
    const w = world();
    w.db.run("INSERT INTO servers (url, owner, role, in_10063, added_by_app) VALUES ('http://mine', ?, 'user', 1, 0)", w.pk);
    w.publish(await buildServerList(w.signer, ['http://other'], 900), ['ws://idx']);
    await syncInbound(w.ports);
    expect(w.db.all<{ url: string }>('SELECT url FROM servers ORDER BY rowid').map((r) => r.url)).toEqual(['http://blossom', 'http://m1', 'http://other']);
  });

  test('a server removed here stays removed when a newer 10063 from another app still names it, as a relay does (C§3.1)', async () => {
    const w = world();
    // the held 10063 named http://gone, which this phone has since removed from its table
    const held = await buildServerList(w.signer, ['http://blossom', 'http://m1', 'http://gone'], 900);
    w.db.run("INSERT INTO lists (owner, kind, d, event_id, created_at, raw) VALUES (?, 10063, '', ?, 900, ?)", w.pk, held.id, JSON.stringify(held));
    w.publish(await buildServerList(w.signer, ['http://gone', 'http://new'], 950), ['ws://idx']);
    await syncInbound(w.ports);
    expect(w.db.all<{ url: string }>('SELECT url FROM servers ORDER BY rowid').map((r) => r.url)).toEqual(['http://blossom', 'http://m1', 'http://new']);
  });

  test('a 10063 held from before, whose servers no row has, is asked for a text too', async () => {
    const w = world();
    w.blobs.set('http://m2', new Map());
    w.publish(await remoteSave(w, h(61), 6000, 'Only on m2.'));
    const sha = [...w.blobs.get('http://blossom')!.keys()][0];
    w.blobs.get('http://m2')!.set(sha, w.blobs.get('http://blossom')!.get(sha)!);
    for (const s of ['http://blossom', 'http://m1']) w.blobs.get(s)!.clear();
    const list = await buildServerList(w.signer, ['http://m2'], 900);
    w.db.run("INSERT INTO lists (owner, kind, d, event_id, created_at, raw) VALUES (?, 10063, '', ?, 900, ?)", w.pk, list.id, JSON.stringify(list));
    expect((await syncInbound(w.ports)).texts).toBe(1);
  });
});

describe('text fetches are bounded (F12)', () => {
  const job = (w: W, hash: string) =>
    w.db.get<TextJob>('SELECT id, owner, hash, title, site, url, text_sha256, text_key, text_nonce, text_servers FROM items WHERE hash = ?', hash)!;

  /** Every server answers 200 with the body the stream gives. */
  function serving(w: W, body: () => ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
    w.ports.fetch = (async () => new Response(body(), { status: 200, headers })) as unknown as typeof fetch;
  }

  test('a server that sends headers and then trickles counts as unreachable after the timeout', async () => {
    const w = world();
    w.publish(await remoteSave(w, h(70), 6000, null, { text: { sha256: 'aa', key: 'bb', nonce: 'cc', servers: ['http://slow'] } as never }));
    await syncInbound(w.ports);
    jest.useFakeTimers();
    try {
      serving(w, () => new ReadableStream({ pull: () => new Promise(() => undefined) }));
      const got = fetchText(w.ports, job(w, h(70)));
      await jest.advanceTimersByTimeAsync(TEXT_TIMEOUT_MS * 4);
      expect(await Promise.race([got, Promise.resolve('still waiting')])).toBe('offline');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a body past the cap stops being read, declared or not', async () => {
    const w = world();
    w.publish(await remoteSave(w, h(71), 6000, null, { text: { sha256: 'aa', key: 'bb', nonce: 'cc', servers: ['http://big'] } as never }));
    await syncInbound(w.ports);
    const MB = 1024 * 1024;
    let pulled = 0;
    const endless = () => new ReadableStream<Uint8Array>({ pull: (c) => void (pulled++, c.enqueue(new Uint8Array(MB))) }, { highWaterMark: 0 });
    serving(w, endless);
    expect(await fetchText(w.ports, job(w, h(71)))).toBe('missing');
    // three servers are asked (the save's own and the two in the 10063), each read only to the cap
    expect(pulled).toBeLessThanOrEqual(3 * (TEXT_MAX_BYTES / MB + 2));
    pulled = 0;
    serving(w, endless, { 'content-length': String(TEXT_MAX_BYTES + 1) });
    expect(await fetchText(w.ports, job(w, h(71)))).toBe('missing');
    expect(pulled).toBeLessThanOrEqual(3);
  });

  test('a server that never answers holds one sync a minute once, not a minute a text', async () => {
    const w = world();
    w.tick(2 * SKEW);
    for (let i = 1; i <= 30; i++) w.publish(await remoteSave(w, h(i), 6000 + i, `# T${i}\n\nwords ${i}`, { url: `https://example.com/${i}` }));
    // the operator's server down, and the mirror one that accepts and never answers
    let silent = 0;
    w.ports.fetch = ((url: string, init?: RequestInit) => {
      if (url.startsWith('http://blossom/')) return Promise.reject(new TypeError('Network request failed'));
      silent++;
      return new Promise((_, fail) => init?.signal?.addEventListener('abort', () => fail(new DOMException('aborted', 'AbortError'))));
    }) as unknown as typeof fetch;
    jest.useFakeTimers();
    try {
      const started = Date.now();
      let done = false;
      const run = syncInbound(w.ports).then((r) => ((done = true), r));
      while (!done && Date.now() - started < 2 * 3600_000) await jest.advanceTimersByTimeAsync(1_000);
      expect(await run).toMatchObject({ items: 30, texts: 0, missing: 0 });
      expect(Date.now() - started).toBeLessThanOrEqual(TEXT_TIMEOUT_MS + 5_000);
      expect(silent).toBe(1);
    } finally {
      jest.useRealTimers();
    }
    // every text waits for the next sync, when the servers are asked again
    expect(w.db.get("SELECT COUNT(*) AS n FROM items WHERE text_state = 'remote'")).toEqual({ n: 30 });
    w.ports.fetch = w.fetch;
    expect(await syncInbound(w.ports)).toMatchObject({ texts: 30 });
  });

  test('a server sending other bytes for every blob is asked twice a sync, not once a text', async () => {
    const w = world();
    w.tick(2 * SKEW);
    for (let i = 1; i <= 20; i++) w.publish(await remoteSave(w, h(i), 6000 + i, `# T${i}\n\nwords ${i}`, { url: `https://example.com/${i}` }));
    // the operator's server down, and the mirror answering each blob with a megabyte of something else
    let sent = 0;
    w.ports.fetch = (async (url: string) => {
      if (url.startsWith('http://blossom/')) throw new TypeError('Network request failed');
      sent++;
      return new Response(new Uint8Array(1024 * 1024) as never, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await syncInbound(w.ports)).toMatchObject({ items: 20, texts: 0, missing: 0 });
    expect(sent).toBe(2);
    // with the operator down, every text is asked for again at the next sync
    expect(w.db.get("SELECT COUNT(*) AS n FROM items WHERE text_state = 'remote'")).toEqual({ n: 20 });
    w.ports.fetch = w.fetch;
    expect(await syncInbound(w.ports)).toMatchObject({ texts: 20 });
  });

  test('a text whose key doesn’t open its blob is missing at once, its blob fetched from one server, not every one', async () => {
    const w = world();
    w.tick(2 * SKEW);
    const e = await remoteSave(w, h(1), 6000, '# A\n\nwords', { url: 'https://example.com/a' });
    w.publish(e);
    await syncInbound(w.ports);
    // the row's key spoilt, as another client could write it
    w.db.run("UPDATE items SET text_key = ?, text_state = 'remote' WHERE hash = ?", Buffer.from(new Uint8Array(32).fill(9)).toString('base64'), h(1));
    let asked = 0;
    const f = w.fetch;
    w.ports.fetch = (async (u: string, i?: RequestInit) => (asked++, f(u, i))) as typeof fetch;
    expect(await fetchText(w.ports, job(w, h(1)))).toBe('missing');
    expect(asked).toBe(1);
    expect(row(w, h(1))).toMatchObject({ text_state: 'failed', fail_reason: 'blob_missing' });
  });
});

/** A kind 30078 at d as another client of the person's might publish it: any JSON, self-encrypted, signed by them. */
async function rawEvent(w: W, d: string, json: string, createdAt: number, tags: string[][] = []) {
  const content = await w.signer.nip44Encrypt(w.pk, json);
  return w.signer.signEvent({ kind: 30078, created_at: createdAt, tags: [['d', d], ['t', 'kefli'], ...tags], content });
}

const itemJson = (hash: string, over: Record<string, unknown> = {}) => JSON.stringify({ ...item().item, hash, ...over });

describe('events another client spoilt, or a relay sends to wear the phone out', () => {
  test('a connected-browsers record with entries of the wrong shape can’t stop sync: its good entries are taken, the saves arrive', async () => {
    const w = world();
    const good = { device_pubkey: 'ab'.repeat(32), label: 'Chrome on a laptop', token: 'cd'.repeat(32), connected_at: 5, revoked_at: null };
    w.publish(await rawEvent(w, 'kefli/devices', JSON.stringify({ v: 1, devices: [null, 5, { token: 1 }, { ...good, label: { a: 1 } }, good] }), 10));
    w.publish(await remoteSave(w, h(1), 6000, null));
    expect(await syncInbound(w.ports)).toMatchObject({ items: 1 });
    expect(w.db.all('SELECT token, label FROM devices')).toEqual([{ token: good.token, label: good.label }]);
    expect(cursors(w).length).toBeGreaterThan(0);
  });

  test('a flood of kind 5s works out the library’s addresses once, not once a kind 5 (an HMAC a save each time)', async () => {
    const w = world();
    const key = new Uint8Array(32).fill(7);
    w.db.run('UPDATE identities SET library_key = ?, library_key_at = 1 WHERE pubkey = ?', bytesToHex(key), w.pk);
    w.db.tx(() => {
      for (let i = 0; i < 500; i++) {
        w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, event_id, event_created_at, published, remote_d) VALUES (?, ?, ?, 1, 'unread', 'queued', 'sync', ?, 100, 1, ?)",
          w.pk, h(i), `https://e.com/${i}`, `ev${i}`, savedD(key, h(i)));
      }
    });
    // 20 kind 5s of 50 addresses each, for saves long gone, and one naming a save the phone holds
    const gone = Array.from({ length: 1_000 }, (_, i) => `kefli/item/${h(1_000_000 + i)}`);
    for (const e of [...await buildDeletions(w.signer, gone, 500), ...await buildDeletions(w.signer, [savedD(key, h(7))], 500)]) w.publish(e, ['ws://a']);
    // 400 kind 5s against 3,000 saves took over three minutes when each kind 5 keyed every save's address again
    let reads = 0;
    const all = w.db.all;
    w.db.all = ((sql: string, ...params: never[]) => (sql === 'SELECT hash, remote_d FROM items WHERE owner = ?' && reads++, all(sql, ...params))) as typeof all;
    expect(await syncInbound(w.ports)).toMatchObject({ deletions: 1 });
    expect(reads).toBe(1);
    expect(row(w, h(7))).toBeUndefined();
    expect(w.db.get('SELECT COUNT(*) AS n FROM items')).toEqual({ n: 499 });
  }, 120_000);

  test('an archival relay’s every version of every save: paging keeps the newest at each address, and every kind 5', async () => {
    const w = world();
    // 20 saves of 25 versions each, each version a second apart, a page of 7 at a time, and their kind 5s
    for (let v = 0; v < 25; v++) for (let s = 1; s <= 20; s++) w.relays.get('ws://a')!.push(await remoteSave(w, h(s), 6000 + v * 20 + s, null, { progress: v / 25 }));
    for (const e of await buildDeletions(w.signer, Array.from({ length: 120 }, (_, i) => `kefli/item/${h(1000 + i)}`), 7000)) w.relays.get('ws://a')!.push(e);
    w.caps.set('ws://a', 7);
    const items = await pageStream(w.ports.query, 'ws://a', streamFilter('items', w.pk, null));
    expect(items.map((e) => e.created_at).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, s) => 6000 + 24 * 20 + s + 1));
    expect(await pageStream(w.ports.query, 'ws://a', streamFilter('deletions', w.pk, null))).toHaveLength(3);
  });

  test('a version dated more than a day ahead doesn’t hide the one before it from a restore', async () => {
    const w = world();
    w.tick(2 * SKEW);
    w.publish(await remoteSave(w, h(1), 6000, null, { title: 'now' }));
    w.publish(await remoteSave(w, h(1), w.ports.now() + 3 * SKEW, null, { title: 'from a clock days ahead' }));
    expect(await syncInbound(w.ports)).toMatchObject({ items: 1 });
    expect(row(w, h(1))).toMatchObject({ title: 'now', event_created_at: 6000 });
  });

  test('an archival relay replaying every version of a save asks the signer once, not once a version', async () => {
    const w = world();
    const r = refusing(w);
    r.refusing = null;
    for (let i = 0; i < 50; i++) w.publish(await remoteSave(w, h(1), 6000 + i, null, { progress: i / 50 }), ['ws://a']);
    expect(await syncInbound(w.ports)).toMatchObject({ items: 1 });
    expect(r.asked).toBe(1);
    expect(row(w, h(1))).toMatchObject({ event_created_at: 6049, progress: 49 / 50 });
  });

  test('two saves another client put at one address: only the newest becomes a row, as for any address (C§8)', async () => {
    const w = world();
    const d = `kefli/item/${h(9)}`;
    w.publish(await rawEvent(w, d, itemJson(h(1), { url: 'https://one.example' }), 6000), ['ws://a']);
    w.publish(await rawEvent(w, d, itemJson(h(2), { url: 'https://two.example' }), 6001), ['ws://b']);
    expect(await syncInbound(w.ports)).toMatchObject({ items: 1 });
    expect(w.db.all('SELECT hash, url FROM items')).toEqual([{ hash: h(2), url: 'https://two.example' }]);
  });

  test('a 10002 of 10,000 relays and a 10063 of 10,000 servers from another app: sync asks at most LIST_MAX more of them', async () => {
    const w = world();
    const relays = Array.from({ length: 10_000 }, (_, i) => ({ url: `wss://r${i}.example`, read: true, write: true }));
    const big = { ...(await buildRelayList(w.signer, relays.slice(0, 2), 9_000)), tags: relays.map((r) => ['r', r.url]) };
    const servers = { ...(await buildServerList(w.signer, ['https://s.example'], 9_000)), tags: Array.from({ length: 10_000 }, (_, i) => ['server', `https://s${i}.example`]) };
    takeNewerLists(w.db, w.pk, [big, servers], [10002, 10063]);
    const asked = new Set<string>();
    const query = w.ports.query;
    w.ports.query = (r, f) => (asked.add(r), query(r, f));
    await syncInbound(w.ports);
    expect(asked.size).toBeLessThanOrEqual(4 + LIST_MAX);
    expect(writeRelays(w.db, w.pk).length).toBeLessThanOrEqual(3 + LIST_MAX);
    expect(listServers(w.db, w.pk).length).toBeLessThanOrEqual(2 + LIST_MAX);
  });

  test('numbers out of range are brought within it: progress 0 to 1, words to MAX_WORDS, saved_at no later than its event allows', async () => {
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ progress: 1e300, words: 10 }, { progress: 1, position_word: 10 }],
      [{ progress: -5 }, { progress: 0, position_word: 0 }],
      [{ words: 1e300, progress: 0.5 }, { words: null, position_word: 0 }],
      [{ saved_at: 1e300 }, { saved_at: 6000 }],
      [{ saved_at: -1e300 }, { saved_at: 6000 }],
      [{ saved_at: 5000.7 }, { saved_at: 5000 }],
      [{ hero: 'javascript:alert(1)' }, { hero: null }],
    ];
    for (const [over, want] of cases) {
      const w = world();
      w.publish(await rawEvent(w, `kefli/item/${h(1)}`, itemJson(h(1), over), 6000));
      await syncInbound(w.ports);
      expect(row(w, h(1))).toMatchObject(want);
    }
  });

  test('a save whose address isn’t a page on the web isn’t taken', async () => {
    const w = world();
    for (const [n, url] of [[1, 'javascript:alert(1)'], [2, 'file:///data/data/app.kefli/files/key'], [3, 'content://x'], [4, 'https://example.com/ok']] as const) {
      w.publish(await rawEvent(w, `kefli/item/${h(n)}`, itemJson(h(n), { url }), 6000 + n));
    }
    expect(await syncInbound(w.ports)).toMatchObject({ items: 1 });
    expect(w.db.all('SELECT url FROM items')).toEqual([{ url: 'https://example.com/ok' }]);
  });

  test('events dated decades ahead wait for their time: a kind 5 dated 2100 deletes nothing, a version dated 2100 freezes nothing', async () => {
    const w = world();
    const AD2100 = 4_102_444_800;
    w.publish(await remoteSave(w, h(1), 6000, null, { title: 'by now' }));
    w.publish(await remoteSave(w, h(2), 6000, null, { url: 'https://example.com/b' }));
    await syncInbound(w.ports);
    // a version of one dated 2100, and a kind 5 of the other dated 2100, from a client whose clock was wrong
    w.publish(await remoteSave(w, h(1), AD2100, null, { title: 'from 2100' }));
    for (const e of await buildDeletions(w.signer, [`kefli/item/${h(2)}`], AD2100)) w.publish(e);
    w.tick(60);
    expect(await syncInbound(w.ports)).toMatchObject({ items: 0, deletions: 0 });
    expect(row(w, h(1))).toMatchObject({ title: 'by now', event_created_at: 6000 });
    expect(row(w, h(2))).toBeDefined();
  });

  test('a 10002 or a connected-browsers record dated decades ahead isn’t taken, so the lists don’t freeze', async () => {
    const w = world();
    const AD2100 = 4_102_444_800;
    w.publish(await buildRelayList(w.signer, [{ url: 'wss://old.example', read: true, write: true }], AD2100), ['ws://idx']);
    const record = { v: 1 as const, devices: [{ device_pubkey: 'ab'.repeat(32), label: 'Chrome', token: 'cd'.repeat(32), connected_at: 5, revoked_at: null }] };
    w.publish(await buildDevicesEvent(w.signer, record, AD2100));
    await syncInbound(w.ports);
    w.publish(await buildRelayList(w.signer, [{ url: 'wss://new.example', read: true, write: true }], w.ports.now()), ['ws://idx']);
    w.tick(60);
    await syncInbound(w.ports);
    expect(w.db.all<{ url: string }>("SELECT url FROM relays WHERE source = 'user'").map((r) => r.url)).toEqual(['wss://new.example']);
    expect(nextListTime(w.db, w.pk, w.ports.now())).toBeLessThan(AD2100);
    expect(w.db.get('SELECT COUNT(*) AS n FROM devices')).toEqual({ n: 0 });
  });

  test('a save naming hundreds of text servers is fetched from at most TEXT_SERVERS_MAX of them, each up to a minute', async () => {
    const w = world();
    const enc = await encryptText(normaliseMarkdown('# A\n\nwords'), nodeCrypto);
    const servers = Array.from({ length: 300 }, (_, i) => `https://d${i}.example`);
    w.publish(await rawEvent(w, `kefli/item/${h(1)}`, itemJson(h(1), { text: { ...enc.text, servers } }), 6000));
    let fetches = 0;
    const f = w.ports.fetch;
    w.ports.fetch = (async (u: string, i?: RequestInit) => (fetches++, f(u, i))) as typeof fetch;
    await syncInbound(w.ports);
    expect(row(w, h(1))).toMatchObject({ text_state: 'remote' });
    expect(fetches).toBe(TEXT_SERVERS_MAX);
  });

  test('a text whose sha256 isn’t one is never asked for, and servers that aren’t http(s) never asked', async () => {
    const w = world();
    const enc = await encryptText(normaliseMarkdown('# A\n\nwords'), nodeCrypto);
    const urls: string[] = [];
    const f = w.ports.fetch;
    w.ports.fetch = (async (u: string, i?: RequestInit) => (urls.push(u), f(u, i))) as typeof fetch;
    w.publish(await rawEvent(w, `kefli/item/${h(1)}`, itemJson(h(1), { text: { ...enc.text, sha256: '../../admin?x=', servers: ['http://blossom'] } }), 6000));
    const odd = ['javascript:alert(1)', 'file:///data/data/app.kefli/x', 'content://x', 'http://blossom'];
    w.publish(await rawEvent(w, `kefli/item/${h(2)}`, itemJson(h(2), { url: 'https://example.com/b', text: { ...enc.text, servers: odd } }), 6001));
    await syncInbound(w.ports);
    // with no text to fetch, its page is parsed here, as for a save that has none
    expect(row(w, h(1))).toMatchObject({ text_sha256: null, text_state: 'queued' });
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.filter((u) => !u.startsWith('http://blossom/') && !u.startsWith('http://m1/'))).toEqual([]);
  });

  test('a save nested 4,500 deep, inside the 16 KB ceiling, is dropped, and the sync goes on to the rest', async () => {
    const w = world();
    // deep enough that writing it back (extra) overflows the stack here, small enough to pass the ceiling
    const deep = `${'['.repeat(4_500)}${']'.repeat(4_500)}`;
    w.publish(await rawEvent(w, `kefli/item/${h(2)}`, itemJson(h(2)).replace(/}$/, `,"later":${deep}}`), 6000));
    w.publish(await remoteSave(w, h(3), 6001, null, { url: 'https://example.com/ok' }));
    expect(await syncInbound(w.ports)).toMatchObject({ items: 1 });
    expect(row(w, h(2))).toBeUndefined();
    expect(row(w, h(3))).toMatchObject({ url: 'https://example.com/ok' });
    expect(cursors(w).length).toBeGreaterThan(0);
  });
});
