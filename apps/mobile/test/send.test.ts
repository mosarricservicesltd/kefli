import { LocalSigner, encryptText, normaliseMarkdown, readItemEvent, textHash } from '@kefli/protocol';
import type { NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, queueSave } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { enqueue, nextDue, nextWakeAt, release } from '../src/data/outbox';
import { drain, outboxWaker, relayResult, sendOne, type RelayAnswer, type SendPorts } from '../src/services/send';
import { commitDelete, deleteItem } from '../src/data/library';
import type { Defaults } from '../src/services/config';
import { notBackedUp } from '../src/data/backup';
import { memoryDb } from './sqlite';

const D: Defaults = {
  v: 1, operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' },
  relays: ['ws://a', 'ws://b'], indexer: ['ws://a'], mirrors: ['http://m1', 'http://m2'],
};
const HASH = 'cd'.repeat(32);

type Answer = { status: number; body?: unknown };
function world(answers: Partial<Record<string, Answer | ((n: number) => Answer | undefined)>> = {}, relay: (url: string) => RelayAnswer = () => ({ ok: true })) {
  const db = memoryDb();
  migrate(db);
  const signer = new LocalSigner(nodeCrypto.randomBytes(32));
  let clock = 1_000;
  const calls: string[] = [];
  const all: { relay: string; event: NostrEvent }[] = [];
  const published = { get length() { return items().length; } } as unknown as { relay: string; event: NostrEvent }[];
  const items = () => all.filter((p) => p.event.kind === 30078 && p.event.tags.some((t) => t[0] === 'd' && t[1].startsWith('kefli/item/')));
  const blobs = new Map<string, Uint8Array>();
  const counts = new Map<string, number>();
  const fetch = (async (url: string, init: RequestInit) => {
    const key = `${init.method} ${url}`;
    calls.push(key);
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const a = answers[key];
    const ans = typeof a === 'function' ? a(n) : a;
    if (ans) return new Response(JSON.stringify(ans.body ?? {}), { status: ans.status });
    if (url.endsWith('/upload') || url.endsWith('/mirror')) {
      const sha = url.endsWith('/upload') ? (init.headers as Record<string, string>)['X-SHA-256'] : String(JSON.parse(String(init.body)).url).split('/').pop();
      return new Response(JSON.stringify({ sha256: sha }), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const ports: SendPorts = {
    db, now: () => clock, signer: async (pk) => (pk === signer.pubkey() ? signer : null), fetch, crypto: nodeCrypto,
    defaults: () => D,
    publish: async (url, event) => {
      all.push({ relay: url, event });
      return relay(url);
    },
    readBlob: async (sha) => blobs.get(sha) ?? null,
  };
  return { db, signer, ports, calls, published: items, all, blobs, tick: (s: number) => (clock += s), now: () => clock };
}

/** The row the last attempt touched: its state, and its target's next time and error. */
const tried = (w: ReturnType<typeof world>) => w.db.get(
  "SELECT o.state, t.next_at, t.last_error FROM outbox o JOIN outbox_targets t ON t.outbox_id = o.id WHERE t.attempts > 0 AND t.state = 'pending'",
);

async function save(w: ReturnType<typeof world>, withText = true) {
  ensureIdentityRow(w.db, w.now(), w.signer.pubkey(), 'early_share', true);
  seedGeneratedLists(w.db, w.signer.pubkey(), D);
  const md = normaliseMarkdown('# Title\n\nSome words.');
  const enc = withText ? await encryptText(md, nodeCrypto) : null;
  if (enc) w.blobs.set(enc.text.sha256, enc.blob);
  const held = queueSave(w.db, w.now(), {
    owner: w.signer.pubkey(), hash: HASH, url: 'https://example.com/a', canonical: null, title: 'Title', site: 'example.com',
    byline: null, savedAt: w.now(), words: 2, lang: 'en', hero: null, text: enc?.text ?? null,
    textHash: enc ? textHash(md, nodeCrypto) : null, textState: enc ? 'cached' : 'failed', origin: 'share',
  }, enc ? { sha256: enc.text.sha256, size: enc.blob.length, path: '/staged' } : null,
  { api: D.operator.api, blossom: D.operator.blossom, mirror: D.mirrors[0] });
  return { held, sha: enc?.text.sha256 };
}

describe('sending a save (mobile spec 4.3)', () => {
  test('held until released, then register, upload, mirror and publish, in that order', async () => {
    const w = world();
    const { held, sha } = await save(w);
    expect(held).toHaveLength(3);
    // register is not Undo-able and goes at once; the rest wait for the sheet to close.
    await drain(w.ports);
    expect(w.calls).toEqual(['POST http://api/register']);
    release(w.db, held);
    await drain(w.ports);
    expect(w.calls.slice(1)).toEqual(['PUT http://blossom/upload', 'PUT http://m1/mirror']);
    expect(w.published().map((p) => p.relay).sort()).toEqual(['ws://a', 'ws://b', 'ws://op']);
    const { item, hash } = await readItemEvent(w.signer, w.published()[0].event);
    expect(hash).toBe(HASH);
    expect(item.item.text?.servers).toEqual(['http://blossom', 'http://m1']);
    expect(item.item.text?.sha256).toBe(sha);
    expect(w.db.get('SELECT published, event_id FROM items')).toEqual({ published: 1, event_id: w.published()[0].event.id });
    expect(w.db.get<{ n: number }>('SELECT COUNT(*) n FROM outbox')?.n).toBe(0);
    expect(w.db.get<{ registered_at: number }>('SELECT registered_at FROM identities')?.registered_at).toBe(w.now());
  });

  test('the first save also publishes the lists: the 10002 everywhere, the 10063 to the write relays only', async () => {
    const w = world();
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    const sent = (kind: number) => w.all.filter((p) => p.event.kind === kind).map((p) => p.relay).sort();
    // The indexer here (ws://a) is also a write relay, so it gets both.
    expect(sent(10002)).toEqual(['ws://a', 'ws://b', 'ws://op']);
    expect(sent(10063)).toEqual(['ws://a', 'ws://b', 'ws://op']);
    const relayList = w.all.find((p) => p.event.kind === 10002)!.event;
    expect(relayList.tags).toEqual([['r', 'ws://op'], ['r', 'ws://a'], ['r', 'ws://b']]);
    expect(w.all.find((p) => p.event.kind === 10063)!.event.tags).toEqual([['server', 'http://blossom'], ['server', 'http://m1']]);
    expect(w.db.all<{ kind: number }>('SELECT kind FROM lists ORDER BY kind').map((r) => r.kind)).toEqual([10002, 10063]);
  });

  test('a repeat save of an unread item changes nothing and queues nothing, lists included', async () => {
    const w = world();
    release(w.db, (await save(w)).held);
    await drain(w.ports);
    const again = await save(w);
    expect(again.held).toEqual([]);
    expect(w.db.get<{ n: number }>('SELECT COUNT(*) n FROM outbox')?.n).toBe(0);
  });

  test('a repeat save of an archived item un-archives it with the new time and republishes', async () => {
    const w = world();
    release(w.db, (await save(w)).held);
    await drain(w.ports);
    w.db.run("UPDATE items SET state = 'archived'");
    w.tick(500);
    const again = await save(w);
    expect(again.held).toHaveLength(1);
    expect(w.db.get('SELECT state, saved_at FROM items')).toEqual({ state: 'unread', saved_at: w.now() });
    release(w.db, again.held);
    await drain(w.ports);
    const last = w.published()[w.published().length - 1].event;
    const { item } = await readItemEvent(w.signer, last);
    expect([item.item.state, item.item.saved_at, item.item.text?.servers]).toEqual(['unread', w.now(), ['http://blossom', 'http://m1']]);
  });

  test('an indexer that is not a write relay gets the 10002 only', async () => {
    const w = world();
    ensureIdentityRow(w.db, w.now(), w.signer.pubkey(), 'early_share', true);
    seedGeneratedLists(w.db, w.signer.pubkey(), { ...D, indexer: ['ws://idx'] });
    const { held } = await save(w, false);
    release(w.db, held);
    await drain(w.ports);
    expect(w.all.filter((p) => p.relay === 'ws://idx').map((p) => p.event.kind)).toEqual([10002]);
  });

  test('a save with no text publishes after register, with text null', async () => {
    const w = world();
    const { held } = await save(w, false);
    release(w.db, held);
    await drain(w.ports);
    const { item } = await readItemEvent(w.signer, w.published()[0].event);
    expect(item.item.text).toBeNull();
    expect(w.calls).toEqual(['POST http://api/register']);
  });

  test('a mirror that refuses gives way to the next; when all refuse, the first again after a day', async () => {
    const w = world({ 'PUT http://m1/mirror': { status: 400 }, 'PUT http://m2/mirror': { status: 403 } });
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect(w.calls.filter((c) => c.includes('mirror'))).toEqual(['PUT http://m1/mirror', 'PUT http://m2/mirror']);
    // The publish still goes: it depends on the upload only, and names the mirror being tried.
    expect(w.published()).toHaveLength(3);
    const row = nextDue(w.db, w.now() + 86_400);
    expect(row?.row.op).toBe('mirror_blob');
    expect(row?.targets.map((t) => t.target)).toEqual(['http://m1']);
    expect(nextDue(w.db, w.now() + 86_399)).toBeNull();
  });

  test('a full quota (413) on the operator retries daily', async () => {
    const w = world({ 'PUT http://blossom/upload': (n) => (n === 1 ? { status: 413 } : { status: 0 }) });
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect(w.published()).toHaveLength(0);
    expect(nextDue(w.db, w.now() + 86_399)).toBeNull();
    expect(nextDue(w.db, w.now() + 86_400)?.row.op).toBe('upload_blob');
  });

  test('a republish takes created_at past the last one', async () => {
    const w = world();
    const { held } = await save(w, false);
    release(w.db, held);
    await drain(w.ports);
    const first = w.published()[0].event.created_at;
    const { enqueue } = await import('../src/data/outbox');
    enqueue(w.db, w.now(), { op: 'publish_item', signer: w.signer.pubkey(), subject: HASH, targets: ['ws://op'] });
    await sendOne(w.ports);
    expect(w.published()[w.published().length - 1].event.created_at).toBe(first + 1);
  });

  test('without its signer a row waits', async () => {
    const w = world();
    const { held } = await save(w, false);
    release(w.db, held);
    w.ports.signer = async () => null;
    await sendOne(w.ports);
    expect(w.calls).toEqual([]);
    expect(nextDue(w.db, w.now())).toBeNull();
  });

  test('a signer lookup that throws puts the row back in the queue with a backoff, where the retry timer sees it', async () => {
    const w = world();
    const { held } = await save(w, false);
    release(w.db, held);
    const signer = w.ports.signer;
    w.ports.signer = async () => {
      throw new Error('Keystore not ready');
    };
    expect(await sendOne(w.ports)).toBe(true);
    expect(w.db.all("SELECT 1 FROM outbox WHERE state = 'sending'")).toEqual([]);
    expect(tried(w)).toEqual({ state: 'queued', next_at: w.now() + 30, last_error: 'Keystore not ready' });
    expect(nextWakeAt(w.db)).not.toBeNull();
    w.ports.signer = signer;
    w.tick(30);
    await drain(w.ports);
    expect(w.calls).toContain('POST http://api/register');
  });

  test('a signing that fails as the signer not answering waits at least a minute (F47)', async () => {
    const w = world();
    const { held } = await save(w, false);
    release(w.db, held);
    await sendOne(w.ports);
    expect(w.calls).toEqual(['POST http://api/register']);
    // the save's event or the lists are signed outside any send's own catch
    w.signer.zero();
    await sendOne(w.ports);
    expect(w.db.all("SELECT 1 FROM outbox WHERE state = 'sending'")).toEqual([]);
    expect(tried(w)).toMatchObject({ state: 'queued', next_at: w.now() + 60 });
  });

  test("a consumed inbox wrap is deleted with a kind 5 naming it on the operator relay, retried when it can't be reached (C§4.4)", async () => {
    let down = true;
    const w = world();
    const id = 'ef'.repeat(32);
    enqueue(w.db, w.now(), { op: 'delete_wrap', signer: w.signer.pubkey(), subject: id, payload: { id }, targets: ['ws://op'] });
    w.ports.publish = async (url, event) => {
      w.all.push({ relay: url, event });
      if (down) throw new Error('unreachable');
      return { ok: true };
    };
    await sendOne(w.ports);
    expect(tried(w)).toMatchObject({ state: 'queued', last_error: 'unreachable' });
    down = false;
    w.tick(60);
    await drain(w.ports);
    const fives = w.all.filter((p) => p.event.kind === 5);
    expect(fives.at(-1)).toMatchObject({ relay: 'ws://op', event: { tags: [['e', id], ['k', '1059']] } });
    expect(w.db.get("SELECT 1 FROM outbox WHERE op = 'delete_wrap'")).toBeUndefined();
  });

  test.each([
    [{ ok: true } as RelayAnswer, 'ok'],
    [{ ok: false, reason: 'duplicate: have it' } as RelayAnswer, 'ok'],
    [{ ok: false, reason: 'rate-limited: slow down' } as RelayAnswer, 'retry'],
    [{ ok: false, reason: 'blocked: not on the list' } as RelayAnswer, 'rejected'],
    [{ ok: false, reason: 'invalid: bad' } as RelayAnswer, 'rejected'],
    [{ ok: false, reason: 'auth-required: who are you' } as RelayAnswer, 'retry'],
  ])('relay answer %j is %s', (a, kind) => {
    expect(relayResult('r', a, 'id').kind).toBe(kind);
  });

  test('backed up only once a relay the operator doesn’t run holds the newest event and a mirror holds the text (FD 93)', async () => {
    const pk = () => w.signer.pubkey();
    // the backups refuse: only the operator holds it
    let refuse = true;
    const w = world({}, (url) => (refuse && url !== 'ws://op' ? { ok: false, reason: 'blocked: no' } : { ok: true }));
    const { held } = await save(w);
    expect(notBackedUp(w.db, pk())).toBe(1);
    release(w.db, held);
    await drain(w.ports);
    expect(w.db.get('SELECT published FROM items')).toEqual({ published: 1 });
    expect(notBackedUp(w.db, pk())).toBe(1);
    // a later change reaches a backup: backed up
    refuse = false;
    w.db.run('UPDATE items SET dirty = 1');
    w.db.run("INSERT INTO outbox (op, signer, subject, lane, created_at, state, was_queued) VALUES ('publish_item', ?, ?, 'interactive', 1, 'queued', 0)", pk(), HASH);
    const id = w.db.get<{ id: number }>("SELECT id FROM outbox WHERE op = 'publish_item'")!.id;
    for (const r of ['ws://a', 'ws://b']) w.db.run("INSERT INTO outbox_targets (outbox_id, target, state, attempts, next_at) VALUES (?, ?, 'pending', 0, 0)", id, r);
    await drain(w.ports);
    expect(notBackedUp(w.db, pk())).toBe(0);
    // text whose mirror hasn't got it isn't backed up
    w.db.run('UPDATE blobs SET mirror_at = NULL');
    expect(notBackedUp(w.db, pk())).toBe(1);
  });

  test('a mirror that took the blob after the save went out naming another gets the save republished naming it (F18)', async () => {
    // m1 is down at first, then refuses; m2 takes it
    const w = world({ 'PUT http://m1/mirror': (n) => ({ status: n === 1 ? 503 : 400 }) });
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    const servers = async (e: NostrEvent) => (await readItemEvent(w.signer, e)).item.item.text?.servers;
    expect(await servers(w.published()[0].event)).toEqual(['http://blossom', 'http://m1']);
    w.tick(120);
    await sendOne(w.ports); // m1 refuses: m2 next
    await sendOne(w.ports); // m2 takes it
    expect(w.db.get('SELECT mirror_url FROM blobs')).toEqual({ mirror_url: 'http://m2' });
    // the published save still names m1: not backed up until it names m2
    expect(notBackedUp(w.db, w.signer.pubkey())).toBe(1);
    expect(nextDue(w.db, w.now())?.row.op).toBe('publish_item');
    await drain(w.ports);
    const last = w.published()[w.published().length - 1].event;
    expect(await servers(last)).toEqual(['http://blossom', 'http://m2']);
    expect(notBackedUp(w.db, w.signer.pubkey())).toBe(0);
    expect(w.db.get<{ n: number }>('SELECT COUNT(*) n FROM outbox')?.n).toBe(0);
  });

  test('a mirror that takes the blob the published save already names queues nothing', async () => {
    // m1 is down at first, then takes it (the default answer)
    const w = world({ 'PUT http://m1/mirror': (n) => (n === 1 ? { status: 503 } : undefined) });
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    const before = w.published().length;
    w.tick(120);
    await drain(w.ports);
    expect(w.published()).toHaveLength(before);
    expect(notBackedUp(w.db, w.signer.pubkey())).toBe(0);
  });

  const blobTargets = (w: ReturnType<typeof world>) => w.db.all<{ target: string }>(
    "SELECT target FROM outbox_targets t JOIN outbox o ON o.id = t.outbox_id WHERE o.op = 'delete_blob' ORDER BY target").map((t) => t.target);

  test('deleting a save made here deletes its blob from the servers its event names (F33)', async () => {
    const w = world();
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    const d = deleteItem(w.db, w.now(), w.signer.pubkey(), HASH);
    commitDelete(w.db, w.signer.pubkey(), HASH, d.held);
    expect(blobTargets(w)).toEqual(['http://blossom', 'http://m1']);
    await drain(w.ports);
    expect(w.calls.filter((c) => c.startsWith('DELETE')).sort()).toEqual([`DELETE http://blossom/${(await readItemEvent(w.signer, w.published()[0].event)).item.item.text?.sha256}`, expect.stringMatching(/^DELETE http:\/\/m1\//)]);
  });

  test('a save deleted before any relay took it still has its blob deleted where it went (F33)', async () => {
    const w = world({}, () => ({ ok: false, reason: 'blocked: no' }));
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect(w.db.get('SELECT published FROM items')).toEqual({ published: 0 });
    const d = deleteItem(w.db, w.now(), w.signer.pubkey(), HASH);
    commitDelete(w.db, w.signer.pubkey(), HASH, d.held);
    expect(blobTargets(w)).toEqual(['http://blossom', 'http://m1']);
  });
});

describe('the foreground retry (4.3, F11)', () => {
  afterEach(() => jest.useRealTimers());

  test('a failed send is tried again when it falls due, while Kefli is in front', async () => {
    let down = true;
    const w = world();
    w.ports.publish = async (url) => {
      if (down && url === 'ws://a') throw new Error('timeout');
      return { ok: true };
    };
    const { held } = await save(w, false);
    release(w.db, held);
    await drain(w.ports);
    jest.useFakeTimers();
    let active = true;
    const runs: number[] = [];
    const waker = outboxWaker({ db: () => w.db, now: w.now, active: () => active, run: () => runs.push(w.now()) });
    waker.arm();
    jest.advanceTimersByTime(29_000);
    expect(runs).toEqual([]);
    jest.advanceTimersByTime(1_000);
    expect(runs).toHaveLength(1);
    // arm replaces the timer; stop clears it; nothing is armed in the background
    waker.arm();
    waker.stop();
    expect(jest.getTimerCount()).toBe(0);
    active = false;
    waker.arm();
    expect(jest.getTimerCount()).toBe(0);
    // once nothing waits, nothing is armed
    active = true;
    down = false;
    w.tick(30);
    jest.useRealTimers();
    await drain(w.ports);
    jest.useFakeTimers();
    waker.arm();
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a long wait is reached in steps of at most an hour, and a row already due runs within a second', async () => {
    const w = world({ 'PUT http://blossom/upload': { status: 413 } });
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    jest.useFakeTimers();
    const runs: number[] = [];
    const waker = outboxWaker({ db: () => w.db, now: w.now, active: () => true, run: () => runs.push(1) });
    waker.arm();
    jest.advanceTimersByTime(3_599_000);
    expect(runs).toEqual([]);
    jest.advanceTimersByTime(1_000);
    expect(runs).toHaveLength(1);
    w.tick(86_400);
    waker.arm();
    jest.advanceTimersByTime(1_000);
    expect(runs).toHaveLength(2);
  });
});
