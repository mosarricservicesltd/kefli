import { LocalSigner, buildDeletions, buildRelayList, buildItemEvent, encryptText, normaliseMarkdown, textHash } from '@shelf/protocol';
import type { Item, NostrEvent, ParsedItem } from '@shelf/protocol';
import { nodeCrypto } from '@shelf/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { getCursor, itemColumns, type TextJob } from '../src/data/sync';
import { fetchText, pageStream, streamFilter, syncInbound, type Filter, type SyncPorts } from '../src/services/sync';
import { sendOne, type SendPorts } from '../src/services/send';
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
  const signer = new LocalSigner(nodeCrypto.randomBytes(32));
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
    db, signer, pk, ports, relays, caps, down, queries, blobs, files, removed, held, fetch,
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
    w.publish(await remoteSave(w, h(1), 6000, '# A title\n\nQuiet words about reading later.'));
    const r = await syncInbound(w.ports);
    expect(r).toEqual({ items: 1, deletions: 0, texts: 1, missing: 0 });
    expect(row(w, h(1))).toMatchObject({ title: 'A title', state: 'unread', text_state: 'cached', position_word: 5, published: 1, dirty: 0, origin: 'sync' });
    expect(w.files.get(h(1))).toBe('# A title\n\nQuiet words about reading later.\n');
    const hit = w.db.all<{ rowid: number }>("SELECT rowid FROM items_fts WHERE items_fts MATCH 'readi*'");
    expect(hit).toEqual([{ rowid: row(w, h(1))!.id }]);
    // A second run asks from the cursor less five minutes, and changes nothing.
    w.tick(60);
    expect(await syncInbound(w.ports)).toEqual({ items: 0, deletions: 0, texts: 0, missing: 0 });
    expect(w.queries.at(-1)!.filter.since).toBe(1_000 - 300);
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
    expect(job).toEqual({ op: 'delete_blob', payload: JSON.stringify({ sha256: oldSha }) });
    // The sender deletes it from both servers; a server that no longer has it counts as done.
    w.blobs.get('http://m1')!.delete(oldSha);
    const send: SendPorts = {
      db: w.db, now: () => 20_000, signer: w.ports.signer, fetch: w.fetch, crypto: nodeCrypto, defaults: () => D as never,
      publish: async () => ({ ok: true }), readBlob: async () => null,
    };
    expect(await sendOne(send)).toBe(true);
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

  test("a badly formed item from another client is read safely", () => {
    const bad = { item: { url: 'https://e.com', title: '', site: 7, state: 'weird', words: -3, progress: 'x', saved_at: null,
      text: { sha256: 'aa', key: 'bb', nonce: 3 }, text_hash: 'th', source_kind: null, hero: 'https://e.com/h.jpg' }, extra: { later: 1 } } as never;
    const c = itemColumns(bad, { created_at: 77 } as NostrEvent);
    expect(c).toMatchObject({ title: null, site: null, state: 'unread', words: null, progress: 0, saved_at: 77, text_sha256: null,
      text_hash: null, source_kind: 'web', hero: 'https://e.com/h.jpg', extra: '{"later":1}', position_word: 0 });
    const good = itemColumns({ item: { ...item().item, words: 9.6, text: { sha256: 'aa', key: 'bb', nonce: 'cc', servers: ['s', 4] } } as never, extra: {} }, { created_at: 1 } as NostrEvent);
    expect(good).toMatchObject({ words: 10, text_servers: '["s"]', extra: null, position_word: 5 });
  });

  test('no active identity or no signer: nothing to do', async () => {
    const w = world();
    expect(await syncInbound({ ...w.ports, signer: async () => null })).toEqual({ items: 0, deletions: 0, texts: 0, missing: 0 });
  });
});
