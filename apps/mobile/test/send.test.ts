import { LocalSigner, encryptText, normaliseMarkdown, readItemEvent, textHash } from '@kefli/protocol';
import type { NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, fitSave, orphanBlobs, queueSave, reviveRefused, type PageFields } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { enqueue, nextDue, nextWakeAt, release } from '../src/data/outbox';
import { drain, outboxWaker, refusalOf, relayResult, sendOne, type RelayAnswer, type SendPorts } from '../src/services/send';
import { commitDelete, deleteItem, setArchived } from '../src/data/library';
import type { Defaults } from '../src/services/config';
import { heldFor, notBackedUp } from '../src/data/backup';
import { textsWaiting } from '../src/data/account';
import { getSetting } from '../src/data/settings';
import { memoryDb } from './sqlite';

const D: Defaults = {
  v: 1, operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' },
  relays: ['ws://a', 'ws://b'], indexer: ['ws://a'], mirrors: ['http://m1', 'http://m2'],
};
const HASH = 'cd'.repeat(32);

type Answer = { status: number; body?: unknown; headers?: Record<string, string> };
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
    if (ans) return new Response(JSON.stringify(ans.body ?? {}), { status: ans.status, headers: ans.headers });
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

const FIGURES = { quota: 52_428_800, used: 52_428_000, daily: 20_971_520, today: 2_000 };

/** The operator's refusal (C§5): 413 with its reason in X-Reason and the body, and the figures for room or the day. */
const refuse = (reason: string, status = 413): Answer => ({
  status, headers: { 'X-Reason': reason },
  body: { v: 1, error: reason, ...(reason === 'quota' || reason === 'daily' ? FIGURES : {}) },
});

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

  test('a full quota (413 quota) on the operator retries the text daily, and the save goes without it (C§4.2)', async () => {
    const w = world({ 'PUT http://blossom/upload': refuse('quota') });
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect(w.published()).toHaveLength(3);
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
    // strfry's OK false for an older version of a replaceable or addressable event than the one it holds: nothing
    // more to send it, where a retry sent the same event for ever when it went as already signed
    [{ ok: false, reason: 'replaced: have newer event' } as RelayAnswer, 'ok'],
    [{ ok: false, reason: 'rate-limited: slow down' } as RelayAnswer, 'retry'],
    [{ ok: false, reason: 'blocked: not on the list' } as RelayAnswer, 'rejected'],
    [{ ok: false, reason: 'invalid: bad' } as RelayAnswer, 'rejected'],
    [{ ok: false, reason: 'auth-required: who are you' } as RelayAnswer, 'retry'],
    // the phone's clock ahead of the relay's: strfry's words, khatru's and nostr-rs-relay's
    [{ ok: false, reason: 'invalid: created_at too late' } as RelayAnswer, 'retry'],
    [{ ok: false, reason: 'blocked: event too much in the future' } as RelayAnswer, 'retry'],
    [{ ok: false, reason: 'invalid: The event created_at field is out of the acceptable range (+900sec) for this relay.' } as RelayAnswer, 'retry'],
    [{ ok: false, reason: 'invalid: created_at too early' } as RelayAnswer, 'rejected'],
  ])('relay answer %j is %s', (a, kind) => {
    expect(relayResult('r', a, 'id').kind).toBe(kind);
  });

  test('a clock 20 minutes fast: strfry’s “created_at too late” waits on the backoff, and the change goes once the clock is right', async () => {
    const w = world();
    // every relay here is strfry, which takes an event dated no more than 15 minutes past its own clock
    let relayNow = w.now();
    w.ports.publish = async (url, event) => {
      w.all.push({ relay: url, event });
      return event.created_at > relayNow + 900 ? { ok: false, reason: 'invalid: created_at too late' } : { ok: true };
    };
    release(w.db, (await save(w, false)).held);
    await drain(w.ports);
    expect(w.published()).toHaveLength(3);
    // the phone's clock jumps 20 minutes ahead, and the save is archived
    w.tick(1200);
    release(w.db, setArchived(w.db, w.now(), w.signer.pubkey(), HASH, true).held);
    await drain(w.ports);
    const waiting = () => w.db.all<{ state: string; target: string; next_at: number; last_error: string }>(
      "SELECT o.state, t.target, t.next_at, t.last_error FROM outbox o JOIN outbox_targets t ON t.outbox_id = o.id WHERE o.op = 'publish_item' ORDER BY t.target");
    expect(waiting()).toEqual(['ws://a', 'ws://b', 'ws://op'].map((target) => ({ state: 'queued', target, next_at: w.now() + 30, last_error: 'invalid: created_at too late' })));
    // still fast half a minute later: the next wait is longer
    relayNow += 30;
    w.tick(30);
    await drain(w.ports);
    expect(waiting().map((t) => t.next_at)).toEqual([w.now() + 60, w.now() + 60, w.now() + 60]);
    // the phone's clock is put right; the retry, timed by the clock as it was, comes due 20 minutes and its wait on
    w.tick(-1200);
    await drain(w.ports);
    expect(waiting()).toHaveLength(3);
    w.tick(1200 + 60);
    relayNow += 1200 + 60;
    await drain(w.ports);
    expect(waiting()).toEqual([]);
    const last = w.published().slice(-3);
    expect(last.map((p) => p.relay).sort()).toEqual(['ws://a', 'ws://b', 'ws://op']);
    expect((await readItemEvent(w.signer, last[0].event)).item.item.state).toBe('archived');
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

type W = ReturnType<typeof world>;
const blob = (w: W) => w.db.get<{ operator_at: number | null; mirror_at: number | null; last_error: string | null }>('SELECT operator_at, mirror_at, last_error FROM blobs');
const lastItem = async (w: W) => (await readItemEvent(w.signer, w.published().at(-1)!.event)).item.item;
const ops = (w: W) => w.db.all<{ op: string; state: string }>("SELECT op, state FROM outbox WHERE op NOT IN ('register', 'publish_lists') ORDER BY id");
const puts = (w: W) => w.calls.filter((c) => c.startsWith('PUT'));

describe('fair use: a refused text holds back only itself (C§4.2, C§5, v1.12)', () => {
  test.each([['quota'], ['daily']])('refused for %s: the save goes at once without its text, the figures are kept, the text waits a day', async (reason) => {
    const w = world({ 'PUT http://blossom/upload': refuse(reason) });
    const kept: unknown[] = [];
    w.ports.onFigures = (owner, f) => kept.push([owner, f]);
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    // to every write relay, its link, title and state, but no text
    expect(w.published().map((p) => p.relay).sort()).toEqual(['ws://a', 'ws://b', 'ws://op']);
    const item = await lastItem(w);
    expect([item.url, item.title, item.text, item.text_hash]).toEqual(['https://example.com/a', 'Title', null, null]);
    expect(blob(w)).toEqual({ operator_at: null, mirror_at: null, last_error: reason });
    expect(kept).toEqual([[w.signer.pubkey(), FIGURES]]);
    // the mirror copies from the operator, so it waits too; nothing is due until a day has passed
    expect(puts(w)).toEqual(['PUT http://blossom/upload']);
    expect(nextDue(w.db, w.now() + 86_399)).toBeNull();
    expect(nextDue(w.db, w.now() + 86_400)?.row.op).toBe('upload_blob');
    // the text stays on the phone, and the save counts as not backed up
    expect(w.db.get('SELECT text_state, text_sha256 IS NOT NULL AS kept FROM items')).toEqual({ text_state: 'cached', kept: 1 });
    expect(notBackedUp(w.db, w.signer.pubkey())).toBe(1);
  });

  test("figures that can't be kept don't hold the save back: it goes without its text, which waits its day", async () => {
    const w = world({ 'PUT http://blossom/upload': refuse('quota') });
    w.ports.onFigures = () => {
      throw new Error('no figures table');
    };
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect(w.published().map((p) => p.relay).sort()).toEqual(['ws://a', 'ws://b', 'ws://op']);
    expect((await lastItem(w)).text).toBeNull();
    expect(blob(w)?.last_error).toBe('quota');
    expect(nextDue(w.db, w.now() + 86_399)).toBeNull();
  });

  test('a text over 8 MB (too_large) is never sent again; the save goes without it, and the text stays here', async () => {
    const w = world({ 'PUT http://blossom/upload': refuse('too_large') });
    const kept: unknown[] = [];
    w.ports.onFigures = (owner, f) => kept.push([owner, f]);
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect((await lastItem(w)).text).toBeNull();
    expect(blob(w)?.last_error).toBe('too_large');
    expect(kept).toEqual([]);
    expect(ops(w)).toEqual([{ op: 'upload_blob', state: 'dead' }, { op: 'mirror_blob', state: 'dead' }]);
    expect(nextWakeAt(w.db)).toBeNull();
    w.tick(30 * 86_400);
    await drain(w.ports);
    expect(puts(w)).toEqual(['PUT http://blossom/upload']);
    expect(notBackedUp(w.db, w.signer.pubkey())).toBe(1);
  });

  test.each([
    [{ status: 403, body: { v: 1, error: 'forbidden' } }, 'http 403'],
    // a 413 without a reason of the operator's, as a proxy's own page, is no refusal for good
    [{ status: 413 }, 'http 413'],
    [{ status: 400 }, 'http 400'],
  ])('any other 4xx but 401 and 429 (%j) is tried again a day later, the save going without its text', async (answer, error) => {
    const w = world({ 'PUT http://blossom/upload': answer as Answer });
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect(blob(w)?.last_error).toBe(error);
    expect((await lastItem(w)).text).toBeNull();
    expect(nextDue(w.db, w.now() + 86_399)).toBeNull();
    expect(nextDue(w.db, w.now() + 86_400)?.row.op).toBe('upload_blob');
  });

  test('a disk past its floor (507) sends the save without its text and retries the upload as any server error', async () => {
    const w = world({ 'PUT http://blossom/upload': (n) => (n === 1 ? { status: 507, body: { v: 1, error: 'storage' } } : undefined) });
    const { held, sha } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect((await lastItem(w)).text).toBeNull();
    expect(blob(w)?.last_error).toBe('http 507');
    expect(tried(w)).toMatchObject({ next_at: w.now() + 30 });
    w.tick(30);
    await drain(w.ports);
    expect((await lastItem(w)).text).toMatchObject({ sha256: sha, servers: ['http://blossom', 'http://m1'] });
    expect(blob(w)).toMatchObject({ last_error: null });
  });

  test.each([[401], [429], [503]])('a %i is no refusal: the save waits for its text, as before', async (status) => {
    const w = world({ 'PUT http://blossom/upload': (n) => (n === 1 ? { status } : undefined) });
    const { held, sha } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect(w.published()).toHaveLength(0);
    expect(blob(w)?.last_error).toBeNull();
    w.tick(60);
    await drain(w.ports);
    expect((await lastItem(w)).text?.sha256).toBe(sha);
  });

  test('the text taken later: the mirror follows, and the save goes out again naming both (C§4.2, FD 117)', async () => {
    const w = world({ 'PUT http://blossom/upload': (n) => (n === 1 ? refuse('quota') : n === 2 ? { status: 503 } : undefined) });
    const { held, sha } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    const first = w.published().length;
    // a server error the next day leaves the refusal's reason as it was
    w.tick(86_400);
    await drain(w.ports);
    expect(blob(w)?.last_error).toBe('quota');
    w.tick(60);
    await drain(w.ports);
    expect(puts(w)).toEqual(['PUT http://blossom/upload', 'PUT http://blossom/upload', 'PUT http://blossom/upload', 'PUT http://m1/mirror']);
    const item = await lastItem(w);
    expect(item.text).toMatchObject({ sha256: sha, servers: ['http://blossom', 'http://m1'] });
    expect(item.text_hash).not.toBeNull();
    expect(w.published()).toHaveLength(first + 3);
    expect(blob(w)).toMatchObject({ last_error: null });
    expect(notBackedUp(w.db, w.signer.pubkey())).toBe(0);
    expect(w.db.get<{ n: number }>('SELECT COUNT(*) n FROM outbox')?.n).toBe(0);
  });

  test.each([
    [JSON.stringify(['http://blossom', 'http://m2']), ['http://blossom', 'http://m2']],
    [JSON.stringify(['http://m2']), ['http://m2']],
    // a list that names no mirror, or won't read, gets the operator and the default mirror, as text.servers must
    [JSON.stringify(['http://blossom']), ['http://blossom', 'http://m1']],
    ['{not json', ['http://blossom', 'http://m1']],
    [null, ['http://blossom', 'http://m1']],
  ])("a save whose text another phone uploaded (%s), sent again from here, names the servers its newest event named", async (named, servers) => {
    const w = world();
    ensureIdentityRow(w.db, w.now(), w.signer.pubkey(), 'early_share', true);
    seedGeneratedLists(w.db, w.signer.pubkey(), D);
    w.db.run(
      `INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, text_sha256, text_key, text_nonce, text_hash, text_servers, published, event_id, event_created_at)
       VALUES (?, ?, 'https://example.com/a', 5, 'unread', 'cached', 'sync', ?, 'k', 'n', 'th', ?, 1, 'e1', 5)`,
      w.signer.pubkey(), HASH, 'ab'.repeat(32), named,
    );
    w.db.run("UPDATE identities SET registered_at = 1");
    release(w.db, setArchived(w.db, w.now(), w.signer.pubkey(), HASH, true).held);
    await drain(w.ports);
    expect((await lastItem(w)).text?.servers).toEqual(servers);
  });

  test('a staged text that has gone can never be sent: the save goes without it', async () => {
    const w = world();
    const { held, sha } = await save(w);
    w.blobs.delete(sha!);
    release(w.db, held);
    await drain(w.ports);
    expect((await lastItem(w)).text).toBeNull();
    expect(ops(w)).toEqual([{ op: 'upload_blob', state: 'dead' }, { op: 'mirror_blob', state: 'dead' }]);
  });

  test('a save a 4xx held back for good before v1.12 goes out at once, and its text is tried again (11.1, item 2)', async () => {
    const w = world({ 'PUT http://blossom/upload': (n) => (n === 1 ? { status: 403, body: { v: 1, error: 'forbidden' } } : undefined) });
    const { held, sha } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    // as the code before v1.12 left it: the upload dead, and its mirror and publish dead with it
    w.db.run("UPDATE outbox SET state = 'dead' WHERE op IN ('upload_blob', 'mirror_blob')");
    w.db.run("UPDATE outbox_targets SET state = 'rejected' WHERE outbox_id = (SELECT id FROM outbox WHERE op = 'upload_blob')");
    w.db.run('UPDATE blobs SET last_error = NULL');
    w.db.run("UPDATE items SET event_id = NULL, published = 0, dirty = 1, text_servers = NULL");
    const upload = w.db.get<{ id: number }>("SELECT id FROM outbox WHERE op = 'upload_blob'")!.id;
    w.db.run("INSERT INTO outbox (op, signer, subject, depends_on, lane, created_at, state, was_queued) VALUES ('publish_item', ?, ?, ?, 'interactive', 1, 'dead', 0)", w.signer.pubkey(), HASH, upload);
    const id = w.db.get<{ id: number }>("SELECT id FROM outbox WHERE op = 'publish_item'")!.id;
    for (const r of ['ws://op', 'ws://a', 'ws://b']) w.db.run("INSERT INTO outbox_targets (outbox_id, target, state, attempts, next_at) VALUES (?, ?, 'pending', 0, 0)", id, r);
    const sent = w.published().length;
    expect(reviveRefused(w.db, w.now())).toBe(1);
    expect(reviveRefused(w.db, w.now())).toBe(0);
    await drain(w.ports);
    // the save went out, and then its text, uploaded and mirrored, went out again with it
    expect(w.published().length).toBe(sent + 6);
    expect((await lastItem(w)).text?.sha256).toBe(sha);
    expect(ops(w)).toEqual([]);
  });

  test('a save a 413 held back before v1.12 goes out once the update starts, its text refused again as now (11.1, item 2)', async () => {
    const w = world({ 'PUT http://blossom/upload': refuse('quota') });
    const { held } = await save(w);
    release(w.db, held);
    w.db.run('UPDATE identities SET registered_at = 1');
    w.db.run("DELETE FROM outbox WHERE op = 'register'");
    // as 0.0.8 left a 413: the upload a day off with the bare reason and nothing on the blob, the publish waiting on it
    const up = w.db.get<{ id: number }>("SELECT id FROM outbox WHERE op = 'upload_blob'")!.id;
    w.db.run("UPDATE outbox_targets SET attempts = 1, next_at = ?, last_error = 'quota' WHERE outbox_id = ?", w.now() + 80_000, up);
    expect(reviveRefused(w.db, w.now())).toBe(1);
    await drain(w.ports);
    expect(puts(w)).toEqual(['PUT http://blossom/upload']);
    expect((await lastItem(w)).text).toBeNull();
    expect(blob(w)?.last_error).toBe('quota');
    // a day off again from this refusal, and nothing more to put back
    expect(nextDue(w.db, w.now() + 86_399)).toBeNull();
    expect(reviveRefused(w.db, w.now())).toBe(0);
  });

  test('a save whose staged text had gone before v1.12 died with its upload: it goes now without the text', async () => {
    const w = world();
    const { held, sha } = await save(w);
    release(w.db, held);
    w.db.run('UPDATE identities SET registered_at = 1');
    w.db.run("DELETE FROM outbox WHERE op = 'register'");
    // 0.0.8: the missing staged text rejected the upload, and the mirror and the publish died with it
    w.db.run("UPDATE outbox SET state = 'dead' WHERE op IN ('upload_blob', 'mirror_blob', 'publish_item')");
    w.db.run("UPDATE outbox_targets SET state = 'rejected', last_error = 'staged blob missing' WHERE outbox_id = (SELECT id FROM outbox WHERE op = 'upload_blob')");
    w.blobs.delete(sha!);
    expect(reviveRefused(w.db, w.now())).toBe(1);
    await drain(w.ports);
    expect(w.published().map((p) => p.relay).sort()).toEqual(['ws://a', 'ws://b', 'ws://op']);
    expect((await lastItem(w)).text).toBeNull();
    expect(puts(w)).toEqual([]);
    expect(reviveRefused(w.db, w.now())).toBe(0);
  });

  test("reviving a dead upload already queued again leaves the queued one, and a too-large text dead", () => {
    const w = world();
    ensureIdentityRow(w.db, w.now(), w.signer.pubkey(), 'early_share', true);
    const pk = w.signer.pubkey();
    const add = (sha: string, lastError: string | null) => {
      w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, text_sha256) VALUES (?, ?, 'https://e.com', 1, 'unread', 'cached', 'share', ?)", pk, sha, sha);
      w.db.run("INSERT INTO blobs (sha256, hash, kind, owner, last_error) VALUES (?, ?, 'text', ?, ?)", sha, sha, pk, lastError);
      const dead = enqueue(w.db, 1, { op: 'upload_blob', signer: pk, subject: sha, payload: { sha256: sha }, targets: ['http://blossom'] });
      w.db.run("UPDATE outbox SET state = 'dead' WHERE id = ?", dead);
      w.db.run("UPDATE outbox_targets SET state = 'rejected', last_error = 'HTTP 413 too_large' WHERE outbox_id = ?", dead);
      w.db.run("INSERT INTO outbox (op, signer, subject, depends_on, lane, created_at, state, was_queued) VALUES ('mirror_blob', ?, ?, ?, 'interactive', 1, 'dead', 0)", pk, sha, dead);
      return dead;
    };
    add('aa'.repeat(32), 'too_large');
    add('bb'.repeat(32), null);
    const queued = enqueue(w.db, 2, { op: 'upload_blob', signer: pk, subject: 'bb'.repeat(32), payload: { sha256: 'bb'.repeat(32) }, targets: ['http://blossom'] });
    expect(reviveRefused(w.db, 5)).toBe(1);
    expect(w.db.all('SELECT id, op, subject, state FROM outbox ORDER BY id')).toEqual([
      { id: 1, op: 'upload_blob', subject: 'aa'.repeat(32), state: 'dead' }, { id: 2, op: 'mirror_blob', subject: 'aa'.repeat(32), state: 'dead' },
      { id: queued, op: 'upload_blob', subject: 'bb'.repeat(32), state: 'queued' },
    ]);
  });

  test('an upload whose save no longer names the text leaves the outbox unsent, its mirror with it', async () => {
    const w = world();
    const { held } = await save(w);
    release(w.db, held);
    // another phone's text took the save's place before the upload went
    w.db.run("UPDATE items SET text_sha256 = 'ee' || substr(text_sha256, 3)");
    await drain(w.ports);
    expect(puts(w)).toEqual([]);
    expect(ops(w)).toEqual([]);
  });

  test.each([
    [{ status: 413, headers: { 'X-Reason': 'quota' } }, 'quota'],
    [{ status: 413, headers: { 'X-Reason': 'daily' }, body: { v: 1, error: 'daily', quota: 'lots' } }, 'daily'],
  ])('a refusal for room without figures (%j) still refuses the text, keeping no figures', async (answer, reason) => {
    const w = world({ 'PUT http://blossom/upload': answer as Answer });
    const kept: unknown[] = [];
    w.ports.onFigures = (owner, f) => kept.push([owner, f]);
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect(blob(w)?.last_error).toBe(reason);
    expect(kept).toEqual([]);
  });

  test.each([
    [{ status: 413, reason: 'quota', permanent: true }, 'quota'],
    [{ status: 413, reason: 'daily', permanent: true }, 'daily'],
    [{ status: 413, reason: 'too_large', permanent: true }, 'too_large'],
    [{ status: 413, reason: 'nginx', permanent: true }, 'http 413'],
    [{ status: 404, reason: '', permanent: true }, 'http 404'],
    [{ status: 507, reason: 'storage', permanent: false }, 'http 507'],
    [{ status: 401, reason: 'auth', permanent: false }, null],
    [{ status: 429, reason: 'slow', permanent: false }, null],
    [{ status: 502, reason: 'descriptor names another blob', permanent: false }, null],
  ])('%j is refused as %s', (r, why) => {
    expect(refusalOf(r)).toBe(why);
  });
});

describe('deleting a save whose text waits (C§4.1, v1.12)', () => {
  const deleteNow = (w: W, hash = HASH) => commitDelete(w.db, w.signer.pubkey(), hash, deleteItem(w.db, w.now(), w.signer.pubkey(), hash).held);
  const deletes = (w: W) => w.db.all<{ target: string; payload: string }>(
    "SELECT t.target, o.payload FROM outbox o JOIN outbox_targets t ON t.outbox_id = o.id WHERE o.op = 'delete_blob' ORDER BY t.target");

  test('cancels its upload and mirror; nothing reached a server, so nothing is deleted there, and its staged text goes', async () => {
    const w = world({ 'PUT http://blossom/upload': refuse('quota') });
    const { held } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    // Undo keeps everything: nothing is cancelled before the delete goes through
    const c = deleteItem(w.db, w.now(), w.signer.pubkey(), HASH);
    c.revert();
    expect(ops(w)).toEqual([{ op: 'upload_blob', state: 'queued' }, { op: 'mirror_blob', state: 'queued' }]);
    deleteNow(w);
    expect(ops(w).filter((o) => o.op !== 'delete_item')).toEqual([]);
    expect(deletes(w)).toEqual([]);
    expect(orphanBlobs(w.db)).toEqual(['/staged']);
    w.tick(2 * 86_400);
    await drain(w.ports);
    expect(puts(w)).toEqual(['PUT http://blossom/upload']);
  });

  test('a blob another save of the owner names keeps its upload', async () => {
    const w = world({ 'PUT http://blossom/upload': refuse('quota') });
    const { held, sha } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, text_sha256) VALUES (?, ?, 'https://e.com/b', 1, 'unread', 'cached', 'share', ?)", w.signer.pubkey(), 'ef'.repeat(32), sha!);
    deleteNow(w);
    expect(ops(w).map((o) => o.op)).toEqual(['upload_blob', 'mirror_blob', 'delete_item']);
    expect(orphanBlobs(w.db)).toEqual([]);
  });

  test('an upload under way when the delete goes through is deleted from the operator once it lands, its mirror cancelled', async () => {
    let w: W;
    // the person deletes the save while the upload is on the wire
    w = world({ 'PUT http://blossom/upload': () => (deleteNow(w), undefined) });
    const { held, sha } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect(puts(w)).toEqual(['PUT http://blossom/upload']);
    expect(w.calls.filter((c) => c.startsWith('DELETE'))).toEqual([`DELETE http://blossom/${sha}`]);
    expect(ops(w)).toEqual([]);
    expect(w.published()).toHaveLength(0);
  });

  test("a mirror under way when the delete goes through deletes the mirror's copy", async () => {
    let w: W;
    w = world({ 'PUT http://m1/mirror': () => (deleteNow(w), undefined) });
    const { held, sha } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    expect(w.calls.filter((c) => c.startsWith('DELETE')).sort()).toEqual([`DELETE http://blossom/${sha}`, `DELETE http://m1/${sha}`]);
  });

  test("a text the operator took during the delete's Undo window is deleted from it once the delete goes through", async () => {
    const w = world({ 'PUT http://blossom/upload': (n) => (n === 1 ? refuse('quota') : undefined) });
    const { held, sha } = await save(w);
    release(w.db, held);
    await drain(w.ports);
    const c = deleteItem(w.db, w.now(), w.signer.pubkey(), HASH);
    // the text's day came while the toast was up: it went to the operator, and the mirror after it
    w.tick(86_400);
    await drain(w.ports);
    commitDelete(w.db, w.signer.pubkey(), HASH, c.held);
    expect(deletes(w).map((d) => d.target)).toEqual(['http://blossom', 'http://m1']);
    expect(JSON.parse(deletes(w)[0].payload)).toMatchObject({ sha256: sha, size: expect.any(Number), up: w.now() });
  });
});

describe('deleting makes room (C§5, v1.12)', () => {
  /** A save with a text of a given size, as the reckoning counts it; its rows released at once. */
  async function sized(w: W, n: number, size: number) {
    const md = normaliseMarkdown(`# Save ${n}\n\nWords.`);
    const enc = await encryptText(md, nodeCrypto);
    w.blobs.set(enc.text.sha256, enc.blob);
    const hash = n.toString(16).padStart(64, '0');
    release(w.db, queueSave(w.db, w.now(), {
      owner: w.signer.pubkey(), hash, url: `https://example.com/${n}`, canonical: null, title: `Save ${n}`, site: null, byline: null,
      savedAt: w.now(), words: 2, lang: 'en', hero: null, text: enc.text, textHash: textHash(md, nodeCrypto), textState: 'cached', origin: 'share',
    }, { sha256: enc.text.sha256, size, path: `/staged/${n}` }, { api: D.operator.api, blossom: D.operator.blossom, mirror: D.mirrors[0] }));
    w.tick(1);
    return { hash, sha: enc.text.sha256 };
  }

  /**
   * One save on the operator (z, 10,000 bytes), then three texts refused for room, oldest first: a (5,000), b (9,000)
   * and c (4,500). The figures the refusals brought say 1,000 bytes are left. sizes and room change those figures.
   * refuseAfter: how many uploads the operator takes once room is back before refusing again.
   */
  async function full(o: { refuseAfter?: number; figures?: boolean; sizes?: [number, number, number, number]; room?: number } = {}) {
    const state = { full: false, allowed: Infinity };
    const w = world({
      'PUT http://blossom/upload': () => {
        if (!state.full) return undefined;
        if (state.allowed-- > 0) return undefined;
        return refuse('quota');
      },
    });
    ensureIdentityRow(w.db, w.now(), w.signer.pubkey(), 'early_share', true);
    seedGeneratedLists(w.db, w.signer.pubkey(), D);
    const [zs, as, bs, cs] = o.sizes ?? [10_000, 5_000, 9_000, 4_500];
    const z = await sized(w, 9, zs);
    await drain(w.ports);
    state.full = true;
    state.allowed = 0;
    const [a, b, c] = [await sized(w, 1, as), await sized(w, 2, bs), await sized(w, 3, cs)];
    await drain(w.ports);
    const at = w.now();
    const used = 100_000 - (o.room ?? 1_000);
    if (o.figures !== false) w.ports.figures = () => ({ quota: 100_000, used, daily: 20_971_520, today: 0, at });
    w.tick(60);
    state.allowed = o.refuseAfter ?? Infinity;
    return { w, z, a, b, c, state, at };
  }

  const tries = (w: W, from: number) => w.calls.slice(from).filter((c) => c === 'PUT http://blossom/upload').length;
  const waiting = (w: W) => w.db.all<{ sha256: string; last_error: string | null; operator_at: number | null }>('SELECT sha256, last_error, operator_at FROM blobs ORDER BY rowid');

  test('the operator confirming a deletion tries at once the oldest waiting texts that fit, until one is refused', async () => {
    const { w, z, a, b, c } = await full({ refuseAfter: 1 });
    expect(waiting(w).map((x) => x.last_error)).toEqual([null, 'quota', 'quota', 'quota']);
    const before = w.calls.length;
    commitDelete(w.db, w.signer.pubkey(), z.hash, deleteItem(w.db, w.now(), w.signer.pubkey(), z.hash).held);
    await drain(w.ports);
    // 11,000 bytes of room: a (5,000) goes; then 6,000: b (9,000) doesn't fit and keeps its day, c (4,500) is tried and
    // refused
    expect(tries(w, before)).toBe(2);
    const by = new Map(waiting(w).map((x) => [x.sha256, x]));
    expect(by.get(a.sha)).toMatchObject({ last_error: null, operator_at: expect.any(Number) });
    expect(by.get(b.sha)).toMatchObject({ last_error: 'quota', operator_at: null });
    expect(by.get(c.sha)).toMatchObject({ last_error: 'quota', operator_at: null });
    // a went out again with its text; b and c wait for their day
    expect(nextDue(w.db, w.now() + 86_000)).toBeNull();
    expect(w.calls.slice(before).filter((x) => x.startsWith('PUT http://m1'))).toHaveLength(1);
  });

  test('every text that fits goes when none is refused, oldest first', async () => {
    const { w, z, a, c } = await full();
    const before = w.calls.length;
    commitDelete(w.db, w.signer.pubkey(), z.hash, deleteItem(w.db, w.now(), w.signer.pubkey(), z.hash).held);
    await drain(w.ports);
    expect(tries(w, before)).toBe(2);
    const taken = waiting(w).filter((x) => x.operator_at !== null).map((x) => x.sha256);
    expect(taken).toEqual(expect.arrayContaining([a.sha, c.sha]));
  });

  test('a text the room let through that meets a server error goes on its retry, and the next that fits follows it', async () => {
    const { w, z, a, c } = await full();
    // the operator stumbles once, on the first text the deletion lets through
    let stumbled = false;
    w.ports.fetch = ((orig) => (async (url: string, init: RequestInit) => {
      if (!stumbled && init.method === 'PUT' && url === 'http://blossom/upload') {
        stumbled = true;
        return new Response('', { status: 503 });
      }
      return orig(url, init);
    }))(w.ports.fetch) as typeof fetch;
    commitDelete(w.db, w.signer.pubkey(), z.hash, deleteItem(w.db, w.now(), w.signer.pubkey(), z.hash).held);
    await drain(w.ports);
    expect(waiting(w).find((x) => x.sha256 === a.sha)).toMatchObject({ last_error: 'quota', operator_at: null });
    // its second attempt, so a minute's backoff, not a day's
    w.tick(60);
    await drain(w.ports);
    const taken = waiting(w).filter((x) => x.operator_at !== null).map((x) => x.sha256);
    expect(taken).toEqual(expect.arrayContaining([a.sha, c.sha]));
  });

  test("figures that can't be read change nothing the operator did: the delete and the upload each count as done", async () => {
    const { w, z, a } = await full();
    w.ports.figures = () => {
      throw new Error('no figures table');
    };
    commitDelete(w.db, w.signer.pubkey(), z.hash, deleteItem(w.db, w.now(), w.signer.pubkey(), z.hash).held);
    await drain(w.ports);
    expect(w.db.get("SELECT 1 AS n FROM outbox WHERE op = 'delete_blob'")).toBeUndefined();
    // a text that waited for room is taken on its day, and its mirror and publish follow
    w.tick(86_400);
    await drain(w.ports);
    expect(w.db.get("SELECT 1 AS n FROM outbox WHERE op IN ('upload_blob', 'mirror_blob') AND subject = ?", a.sha)).toBeUndefined();
    expect(waiting(w).find((x) => x.sha256 === a.sha)).toMatchObject({ operator_at: expect.any(Number), last_error: null });
  });

  test('without known figures, or for texts waiting on the day, a deletion tries nothing at once', async () => {
    const one = await full({ figures: false });
    let before = one.w.calls.length;
    commitDelete(one.w.db, one.w.signer.pubkey(), one.z.hash, deleteItem(one.w.db, one.w.now(), one.w.signer.pubkey(), one.z.hash).held);
    await drain(one.w.ports);
    expect(tries(one.w, before)).toBe(0);

    const two = await full();
    two.w.db.run("UPDATE blobs SET last_error = 'daily' WHERE last_error = 'quota'");
    before = two.w.calls.length;
    commitDelete(two.w.db, two.w.signer.pubkey(), two.z.hash, deleteItem(two.w.db, two.w.now(), two.w.signer.pubkey(), two.z.hash).held);
    await drain(two.w.ports);
    expect(tries(two.w, before)).toBe(0);
  });

  test("a mirror's confirmation makes no room; only the operator's does", async () => {
    const { w, z } = await full();
    // the operator is down for deletes; the mirror deletes its copy
    w.ports.fetch = ((orig) => (async (url: string, init: RequestInit) =>
      init.method === 'DELETE' && url.startsWith('http://blossom') ? new Response('', { status: 503 }) : orig(url, init)))(w.ports.fetch) as typeof fetch;
    const before = w.calls.length;
    commitDelete(w.db, w.signer.pubkey(), z.hash, deleteItem(w.db, w.now(), w.signer.pubkey(), z.hash).held);
    await drain(w.ports);
    expect(w.calls.slice(before)).toContain(`DELETE http://m1/${z.sha}`);
    expect(tries(w, before)).toBe(0);
  });

  test("a deletion of a text the operator took after the figures gives back nothing they counted", async () => {
    const { w, a } = await full({ refuseAfter: 1 });
    // a gets through on its day, after the figures, and b, refused, holds c again: then a is deleted
    w.tick(86_400);
    await drain(w.ports);
    expect(waiting(w).find((x) => x.sha256 === a.sha)?.operator_at).toEqual(expect.any(Number));
    const before = w.calls.length;
    commitDelete(w.db, w.signer.pubkey(), a.hash, deleteItem(w.db, w.now(), w.signer.pubkey(), a.hash).held);
    // its blob's row gone with the staged text, as the outbox's sweep leaves it
    orphanBlobs(w.db);
    await drain(w.ports);
    // 1,000 bytes left by the figures, and a's own 5,000 back: c (4,500) doesn't fit in what they counted
    expect(tries(w, before)).toBe(0);
  });

  test('a text under a disk block counts as one, as the operator counts it, so none is tried that it would refuse', async () => {
    // the operator counts each blob as 4,096 bytes at least (C§5), in its figures too: deleting z (1,000 bytes) gives
    // back a block, room for a (300 bytes, so a block), after which the 100 bytes left fit neither b (900) nor c (200)
    const { w, z, a, b, c } = await full({ sizes: [1_000, 300, 900, 200], room: 100, refuseAfter: 1 });
    const before = w.calls.length;
    commitDelete(w.db, w.signer.pubkey(), z.hash, deleteItem(w.db, w.now(), w.signer.pubkey(), z.hash).held);
    await drain(w.ports);
    expect(tries(w, before)).toBe(1);
    const by = new Map(waiting(w).map((x) => [x.sha256, x]));
    expect(by.get(a.sha)).toMatchObject({ last_error: null, operator_at: expect.any(Number) });
    expect(by.get(b.sha)).toMatchObject({ last_error: 'quota', operator_at: null });
    expect(by.get(c.sha)).toMatchObject({ last_error: 'quota', operator_at: null });
  });

  test('a deletion of a blob whose size the phone doesn’t know gives back a block, as the operator counts it', async () => {
    // z's size isn't known here, as for a capture the phone never read (data/inbox): the operator still frees a block
    // at least (C§5), room for a (300 bytes, so a block); noted not at all, the 100 bytes left fitted nothing
    const { w, z, a, b, c } = await full({ sizes: [1_000, 300, 900, 200], room: 100, refuseAfter: 1 });
    w.db.run('UPDATE blobs SET size = NULL WHERE sha256 = ?', z.sha);
    const up = w.db.get<{ operator_at: number }>('SELECT operator_at FROM blobs WHERE sha256 = ?', z.sha)!.operator_at;
    const before = w.calls.length;
    commitDelete(w.db, w.signer.pubkey(), z.hash, deleteItem(w.db, w.now(), w.signer.pubkey(), z.hash).held);
    await drain(w.ports);
    expect(JSON.parse(getSetting(w.db, `space.freed.${w.signer.pubkey()}`) ?? '[]')).toEqual([{ at: w.now(), size: 4_096, up }]);
    expect(tries(w, before)).toBe(1);
    const by = new Map(waiting(w).map((x) => [x.sha256, x]));
    expect(by.get(a.sha)).toMatchObject({ last_error: null, operator_at: expect.any(Number) });
    expect([by.get(b.sha)?.operator_at, by.get(c.sha)?.operator_at]).toEqual([null, null]);
  });
});

describe('a refusal for room or the day holds the library’s other texts (C§5, v1.12)', () => {
  /** A save with text n, its sends queued as an imported link's parse leaves them; returns its blob's size. */
  async function texted(w: W, n: number, owner = w.signer.pubkey()) {
    const md = normaliseMarkdown(`# Bookmark ${n}\n\nWords.`);
    const enc = await encryptText(md, nodeCrypto);
    w.blobs.set(enc.text.sha256, enc.blob);
    release(w.db, queueSave(w.db, w.now(), {
      owner, hash: n.toString(16).padStart(64, '0'), url: `https://example.com/${n}`, canonical: null, title: `Bookmark ${n}`,
      site: null, byline: null, savedAt: w.now(), words: 2, lang: 'en', hero: null, text: enc.text, textHash: textHash(md, nodeCrypto),
      textState: 'cached', origin: 'import',
    }, { sha256: enc.text.sha256, size: enc.blob.length, path: `/staged/${n}` }, { api: D.operator.api, blossom: D.operator.blossom, mirror: D.mirrors[0] }));
    return enc.blob.length;
  }

  function library(w: W, owner = w.signer.pubkey()) {
    ensureIdentityRow(w.db, w.now(), owner, 'early_share', true);
    seedGeneratedLists(w.db, owner, D);
    w.db.run('UPDATE identities SET registered_at = 1 WHERE pubkey = ?', owner);
  }

  const uploads = (w: W) => w.calls.filter((c) => c === 'PUT http://blossom/upload').length;
  const saves = (w: W) => new Set(w.published().map((p) => p.event.tags.find((t) => t[0] === 'd')![1])).size;
  const reasons = (w: W) => w.db.all<{ last_error: string | null }>('SELECT last_error FROM blobs ORDER BY rowid').map((b) => b.last_error);
  const settle = async (w: W) => {
    for (let i = 0; 50 > i && (await drain(w.ports)) > 0; i++);
  };
  const deleteSave = (w: W, n: number) => {
    const hash = n.toString(16).padStart(64, '0');
    commitDelete(w.db, w.signer.pubkey(), hash, deleteItem(w.db, w.now(), w.signer.pubkey(), hash).held);
  };

  test('for the day: the others wait unsent until its retry, their saves going at once without them, counted in Backup space', async () => {
    let refusing = true;
    const w = world({ 'PUT http://blossom/upload': () => (refusing ? refuse('daily') : undefined) });
    library(w);
    for (let n = 0; 5 > n; n++) await texted(w, n);
    const refusedAt = w.now();
    await settle(w);
    expect(uploads(w)).toBe(1);
    expect(saves(w)).toBe(5);
    for (const p of w.published()) expect((await readItemEvent(w.signer, p.event)).item.item.text).toBeNull();
    expect(reasons(w)).toEqual(['daily', 'daily', 'daily', 'daily', 'daily']);
    expect(textsWaiting(w.db, w.signer.pubkey(), w.now())).toMatchObject({ daily: 5, dailyRecent: 5 });
    // a text that comes to upload while the hold stands, as a parse ending an hour on, waits with it, unsent
    w.tick(3600);
    await texted(w, 5);
    await settle(w);
    expect([uploads(w), saves(w), reasons(w)[5]]).toEqual([1, 6, 'daily']);
    // nothing to upload falls due before the refusal's retry, a day after it
    expect(nextDue(w.db, refusedAt + 86_399)).toBeNull();
    expect(nextDue(w.db, refusedAt + 86_400)?.row.op).toBe('upload_blob');
    // the next day the operator takes them all, each sent once more, and every save goes again naming its text
    refusing = false;
    w.tick(refusedAt + 86_400 - w.now());
    await settle(w);
    expect(uploads(w)).toBe(1 + 6);
    expect(notBackedUp(w.db, w.signer.pubkey())).toBe(0);
    expect(w.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')?.n).toBe(0);
  });

  test('for room: the others wait unsent, and a deletion the operator confirms still wakes the oldest that fits', async () => {
    let taking = 1;
    const w = world({ 'PUT http://blossom/upload': () => (taking-- > 0 ? undefined : refuse('quota')) });
    library(w);
    await texted(w, 0);
    await settle(w);
    for (let n = 1; 4 > n; n++) await texted(w, n);
    await settle(w);
    expect(uploads(w)).toBe(2);
    expect(reasons(w)).toEqual([null, 'quota', 'quota', 'quota']);
    expect(textsWaiting(w.db, w.signer.pubkey(), w.now()).full).toBe(true);
    // the library at its quota, known before the deletion: deleting the first save's text leaves room for one more
    const at = w.now();
    w.ports.figures = () => ({ quota: 10_000, used: 10_000, daily: 20_971_520, today: 0, at });
    w.tick(1);
    taking = 1;
    deleteSave(w, 0);
    const before = uploads(w);
    await settle(w);
    expect(uploads(w) - before).toBe(1);
    expect(reasons(w)).toEqual([null, null, 'quota', 'quota']);
  });

  test('while the day holds the texts, a confirmed deletion wakes none, though it leaves room', async () => {
    const w = world({ 'PUT http://blossom/upload': (n) => (n === 1 ? undefined : refuse('daily')) });
    library(w);
    for (let n = 0; 3 > n; n++) await texted(w, n);
    await settle(w);
    // a text refused for room before the day's refusal held it
    w.db.run("UPDATE blobs SET last_error = 'quota' WHERE rowid = 3");
    const at = w.now();
    w.ports.figures = () => ({ quota: 52_428_800, used: 0, daily: 20_971_520, today: 0, at });
    w.tick(1);
    deleteSave(w, 0);
    const before = uploads(w);
    await settle(w);
    expect(w.calls.filter((c) => c.startsWith('DELETE http://blossom/'))).toHaveLength(1);
    expect(uploads(w)).toBe(before);
  });

  test('one library’s hold is its own: another identity on the phone still sends its texts', async () => {
    const w = world({ 'PUT http://blossom/upload': (n) => (n === 1 ? refuse('daily') : undefined) });
    const other = new LocalSigner(nodeCrypto.randomBytes(32));
    const signer = w.ports.signer;
    w.ports.signer = async (pk) => (pk === other.pubkey() ? other : signer(pk));
    library(w);
    library(w, other.pubkey());
    await texted(w, 0);
    await settle(w);
    await texted(w, 1, other.pubkey());
    await texted(w, 2);
    await settle(w);
    expect(uploads(w)).toBe(2);
    expect(w.db.all('SELECT owner, operator_at IS NOT NULL AS taken, last_error FROM blobs ORDER BY rowid')).toEqual([
      { owner: w.signer.pubkey(), taken: 0, last_error: 'daily' },
      { owner: other.pubkey(), taken: 1, last_error: null },
      { owner: w.signer.pubkey(), taken: 0, last_error: 'daily' },
    ]);
  });

  test('for the day: a text the operator holds for another library here still goes, and the library’s others still wait', async () => {
    // the operator: one more text for the day, and a blob it stores already adds nothing to the day (C§5)
    const stored = new Set<string>();
    let dayLeft = 1;
    const sent: string[] = [];
    const w = world();
    const fetch = w.ports.fetch;
    w.ports.fetch = (async (url: string, init: RequestInit) => {
      const sha = (init.headers as Record<string, string> | undefined)?.['X-SHA-256'];
      if (url === 'http://blossom/upload' && sha) {
        sent.push(sha);
        if (!stored.has(sha) && dayLeft-- <= 0) return new Response(JSON.stringify({ v: 1, error: 'daily', ...FIGURES }), { status: 413, headers: { 'X-Reason': 'daily' } });
        stored.add(sha);
      }
      return fetch(url, init);
    }) as typeof globalThis.fetch;
    const source = new LocalSigner(nodeCrypto.randomBytes(32));
    const signer = w.ports.signer;
    w.ports.signer = async (pk) => (pk === source.pubkey() ? source : signer(pk));
    library(w, source.pubkey());
    library(w);
    // a text the source library had the operator take, and this library's copy of it, as a move makes one (C§4.8)
    const md = normaliseMarkdown('# Moved\n\nWords.');
    const enc = await encryptText(md, nodeCrypto);
    w.blobs.set(enc.text.sha256, enc.blob);
    const saveOf = (owner: string) => release(w.db, queueSave(w.db, w.now(), {
      owner, hash: 'ab'.repeat(32), url: 'https://example.com/moved', canonical: null, title: 'Moved', site: null, byline: null, savedAt: w.now(),
      words: 2, lang: 'en', hero: null, text: enc.text, textHash: textHash(md, nodeCrypto), textState: 'cached', origin: 'share',
    }, { sha256: enc.text.sha256, size: enc.blob.length, path: '/staged/moved' }, { api: D.operator.api, blossom: D.operator.blossom, mirror: D.mirrors[0] }));
    saveOf(source.pubkey());
    await settle(w);
    // this library's own text is refused for the day, holding the rest; then the copy comes, and one more text
    await texted(w, 1);
    await settle(w);
    saveOf(w.signer.pubkey());
    await texted(w, 2);
    await settle(w);
    // the copy went, at no cost to the day, and the other text waits unsent for the refusal's retry
    expect(w.db.get('SELECT owner, operator_at IS NOT NULL AS taken FROM blobs WHERE sha256 = ?', enc.text.sha256)).toEqual({ owner: w.signer.pubkey(), taken: 1 });
    expect(sent).toEqual([enc.text.sha256, expect.any(String), enc.text.sha256]);
    expect(heldFor(w.db, w.signer.pubkey(), w.now())?.reason).toBe('daily');
  });

  test('a hold from a clock since put back holds nothing, and a text taken lifts it for good', async () => {
    const w = world({ 'PUT http://blossom/upload': (n) => (n === 1 ? refuse('daily') : undefined) });
    library(w);
    // the refusal came while the phone's clock was two days ahead
    w.tick(2 * 86_400);
    await texted(w, 0);
    await settle(w);
    w.tick(-2 * 86_400);
    expect(heldFor(w.db, w.signer.pubkey(), w.now())).toBeNull();
    await texted(w, 1);
    await settle(w);
    expect(uploads(w)).toBe(2);
    // two days on, the old hold would stand again had the text taken not lifted it
    w.tick(2 * 86_400);
    expect(heldFor(w.db, w.signer.pubkey(), w.now())).toBeNull();
  });

  test('an import past the day: every save goes at once; each day its texts go until the first refusal, the rest unsent', async () => {
    // the operator takes forty texts a day, as 20 MB takes about 800, and refuses the rest for the day
    let today = 40;
    const w = world({ 'PUT http://blossom/upload': () => (today-- > 0 ? undefined : refuse('daily')) });
    let sent = 0;
    const fetch = w.ports.fetch;
    w.ports.fetch = (async (url: string, init: RequestInit) => {
      if (init.method === 'PUT' && url === 'http://blossom/upload') sent += (init.body as Uint8Array).length;
      return fetch(url, init);
    }) as typeof globalThis.fetch;
    library(w);
    // two hundred links, parsed two at a time through the first day, each parse's sends queued as it ends
    const sizes: number[] = [];
    for (let n = 0; 200 > n; n += 2) {
      sizes.push(await texted(w, n), await texted(w, n + 1));
      await settle(w);
      w.tick(60);
    }
    // forty texts taken and one refused: the other 159 never sent
    expect([uploads(w), saves(w), notBackedUp(w.db, w.signer.pubkey())]).toEqual([41, 200, 160]);
    expect(sent).toBe(sizes.slice(0, 41).reduce((a, b) => a + b, 0));
    expect(textsWaiting(w.db, w.signer.pubkey(), w.now())).toMatchObject({ daily: 160 });
    for (const left of [120, 80, 40, 0]) {
      today = 40;
      w.tick(86_400);
      await settle(w);
      expect(notBackedUp(w.db, w.signer.pubkey())).toBe(left);
    }
    // each text sent once when taken, and one more a day for the day's one refusal
    expect(uploads(w)).toBe(200 + 4);
    expect(w.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')?.n).toBe(0);
  }, 60_000);
});

describe('a save from before its page’s fields were fitted (C§3.3)', () => {
  /** A save as the code before the fitting stored it: its page's fields as the page gave them. */
  function oldSave(w: W, fields: Partial<PageFields>) {
    ensureIdentityRow(w.db, w.now(), w.signer.pubkey(), 'early_share', true);
    seedGeneratedLists(w.db, w.signer.pubkey(), D);
    w.db.run('UPDATE identities SET registered_at = 1');
    release(w.db, queueSave(w.db, w.now(), {
      owner: w.signer.pubkey(), hash: HASH, url: 'https://example.com/a', canonical: null, title: 'Title', site: 'example.com', byline: null,
      savedAt: w.now(), words: 2, lang: 'en', hero: null, text: null, textHash: null, textState: 'failed', origin: 'share', ...fields,
    }, null, { api: D.operator.api, blossom: D.operator.blossom, mirror: D.mirrors[0] }));
  }

  test('one whose event would pass 16 KB is fitted as a save made today is, and goes out', async () => {
    const w = world();
    const huge = {
      title: 'T'.repeat(20_000), byline: 'B'.repeat(5_000), hero: `https://cdn.example/${'h'.repeat(10_000)}`,
      canonical: `https://example.com/a?${'c'.repeat(3_000)}`,
    };
    oldSave(w, huge);
    await drain(w.ports);
    expect(w.published().map((p) => p.relay).sort()).toEqual(['ws://a', 'ws://b', 'ws://op']);
    const item = await lastItem(w);
    const fitted = fitSave({ url: 'https://example.com/a', site: 'example.com', lang: 'en', ...huge })!;
    expect([item.title, item.byline, item.hero, item.canonical, item.site]).toEqual([fitted.title, fitted.byline, null, null, 'example.com']);
    expect(w.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox')?.n).toBe(0);
    expect(notBackedUp(w.db, w.signer.pubkey())).toBe(0);
  });

  test('one whose address alone is too long for any event stays on the phone, counted, and isn’t tried for ever', async () => {
    const w = world();
    oldSave(w, { url: `https://example.com/?q=${'x'.repeat(10_000)}` });
    await drain(w.ports);
    expect(w.published()).toEqual([]);
    expect(w.db.get("SELECT o.state, t.last_error FROM outbox o JOIN outbox_targets t ON t.outbox_id = o.id WHERE o.op = 'publish_item' LIMIT 1"))
      .toEqual({ state: 'dead', last_error: 'too large for its event' });
    expect(w.db.get('SELECT 1 AS kept FROM items')).toEqual({ kept: 1 });
    expect(notBackedUp(w.db, w.signer.pubkey())).toBe(1);
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
