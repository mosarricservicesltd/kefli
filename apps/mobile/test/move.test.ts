import {
  LocalSigner, buildLibraryKeyEvent, encryptText, normaliseMarkdown, readItemEvent, releaseTemplate, savedD, statementHolds, textHash, unwrap,
  type NostrEvent, type Signer,
} from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { bytesToHex } from '@noble/hashes/utils.js';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, queueSave } from '../src/data/saves';
import { moveJob, queueSwitch } from '../src/data/move';
import { seedGeneratedLists } from '../src/data/lists';
import { enqueue, release } from '../src/data/outbox';
import { absorbRecord } from '../src/data/devices';
import { commitDelete, deleteItem, setArchived, setPosition } from '../src/data/library';
import { notBackedUp } from '../src/data/backup';
import { libraryKey } from '../src/data/libraryKey';
import { drain } from '../src/services/send';
import { TEXT_TIMEOUT_MS, syncOwner, type Filter } from '../src/services/sync';
import { runMove, type MovePorts } from '../src/services/move';
import type { Defaults } from '../src/services/config';
import { SERVER_TIMEOUT_MS } from '../src/net/http';
import { memoryDb } from './sqlite';
import { inward, silent, watch } from './inward';

const D: Defaults = {
  v: 1, operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' },
  relays: ['ws://a', 'ws://b'], indexer: ['ws://idx'], mirrors: ['http://m1', 'http://m2'],
};
const T3 = { api: D.operator.api, blossom: D.operator.blossom, mirror: D.mirrors[0] };
const h = (n: number) => n.toString(16).padStart(64, '0');

function matches(e: NostrEvent, f: Filter): boolean {
  if (!f.kinds.includes(e.kind)) return false;
  if (f.authors && !f.authors.includes(e.pubkey)) return false;
  if (f['#t'] && !e.tags.some((t) => t[0] === 't' && f['#t']!.includes(t[1]))) return false;
  if (f['#p'] && !e.tags.some((t) => t[0] === 'p' && f['#p']!.includes(t[1]))) return false;
  if (f.since !== undefined && e.created_at < f.since) return false;
  if (f.until !== undefined && e.created_at > f.until) return false;
  return true;
}

function world(o: { down?: Set<string>; accountStatus?: number; refuse?: (author: string) => boolean; dayUsed?: (author: string) => boolean; switch?: boolean } = {}) {
  const db = memoryDb();
  migrate(db);
  const S = new LocalSigner(nodeCrypto.randomBytes(32));
  const T = new LocalSigner(nodeCrypto.randomBytes(32));
  const signers = new Map<string, Signer>([[S.pubkey(), S], [T.pubkey(), T]]);
  let clock = 1_000;
  const relays = new Map<string, NostrEvent[]>();
  const blossom = new Map<string, { bytes: Uint8Array; owners: Set<string> }>();
  const staged = new Map<string, Uint8Array>();
  const log: string[] = [];
  const devicePosts: { author: string; body: Record<string, unknown> }[] = [];
  const signerOf = async (pk: string) => signers.get(pk) ?? null;
  const authorOf = (init: RequestInit) => {
    const a = (init.headers as Record<string, string> | undefined)?.Authorization ?? '';
    return a.startsWith('Nostr ') ? (JSON.parse(Buffer.from(a.slice(6), 'base64').toString()) as NostrEvent).pubkey : '';
  };
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const host = new URL(url).origin;
    if (o.down?.has(host)) throw new Error('down');
    log.push(`${method} ${url} ${authorOf(init).slice(0, 4)}`);
    const sha = url.split('/').pop()!;
    // the operator refusing an author's texts for room (C§5): 413 quota with the library's figures
    if (url.endsWith('/upload') && o.refuse?.(authorOf(init))) {
      return new Response(JSON.stringify({ v: 1, error: 'quota', quota: 100, used: 100, daily: 100, today: 0 }), { status: 413, headers: { 'X-Reason': 'quota' } });
    }
    // an author's day of uploads used (C§5): a blob the server stores already adds nothing to the day, and is taken
    if (url.endsWith('/upload') && o.dayUsed?.(authorOf(init)) && !blossom.has(bytesToHex(nodeCrypto.sha256(new Uint8Array(init.body as ArrayBuffer))))) {
      return new Response(JSON.stringify({ v: 1, error: 'daily', quota: 52_428_800, used: 0, daily: 100, today: 100 }), { status: 413, headers: { 'X-Reason': 'daily' } });
    }
    if (url.endsWith('/upload')) {
      const bytes = new Uint8Array(init.body as ArrayBuffer);
      const s = bytesToHex(nodeCrypto.sha256(bytes));
      const b = blossom.get(s) ?? { bytes, owners: new Set() };
      b.owners.add(authorOf(init));
      blossom.set(s, b);
      return new Response(JSON.stringify({ sha256: s }), { status: 200 });
    }
    if (url.endsWith('/mirror')) return new Response(JSON.stringify({ sha256: String(JSON.parse(String(init.body)).url).split('/').pop() }), { status: 200 });
    if (url.endsWith('/account')) return new Response('{}', { status: o.accountStatus ?? 200 });
    if (url.endsWith('/devices') && method === 'POST') devicePosts.push({ author: authorOf(init), body: JSON.parse(String(init.body)) });
    if (method === 'GET' && blossom.has(sha)) return new Response(blossom.get(sha)!.bytes as never, { status: 200 });
    if (method === 'GET' || method === 'HEAD') return new Response('', { status: method === 'GET' && /^[0-9a-f]{64}$/.test(sha) ? 404 : 200 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const publish = async (relay: string, event: NostrEvent) => {
    if (o.down?.has(relay)) throw new Error('down');
    const list = relays.get(relay) ?? [];
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    // addressable: the newer copy replaces the older
    const kept = event.kind === 30078 && d ? list.filter((e) => !(e.kind === 30078 && e.pubkey === event.pubkey && e.tags.some((t) => t[0] === 'd' && t[1] === d))) : list;
    relays.set(relay, [...kept, event]);
    log.push(`publish ${relay} ${event.kind} ${event.pubkey.slice(0, 4)}`);
    return { ok: true as const };
  };
  const query = async (relay: string, filters: Filter[]) => {
    if (o.down?.has(relay)) throw new Error('down');
    return (relays.get(relay) ?? []).filter((e) => filters.some((f) => matches(e, f)));
  };
  const runOutbox = () => drain({ db, now: () => clock, signer: signerOf, fetch, crypto: nodeCrypto, defaults: () => D, publish, readBlob: async (s) => staged.get(s) ?? null });
  const syncPorts = {
    db, now: () => clock, signer: signerOf, query, fetch, crypto: nodeCrypto, defaults: async () => D,
    files: { writeText: () => undefined, removeText: () => undefined, removeAll: () => undefined },
  };
  let keysRetired = false;
  const p: MovePorts = {
    db, now: () => clock, source: S, target: T, defaults: async () => D, query, publish, fetch, crypto: nodeCrypto,
    readStaged: async (s) => staged.get(s) ?? null,
    stage: (s, bytes) => (staged.set(s, bytes), `/staged/${s}`),
    spoken: () => 'some words',
    collect: async (owner, signer) => (await syncOwner(syncPorts, owner, signer)).waiting === 0,
    runOutbox,
    drainSourceInbox: async () => undefined,
    retireKeys: async () => void (keysRetired = true),
  };
  if (o.switch) {
    // Use my nostr app instead (C§4.8): S, made here, stays the phone's identity; T, the nostr app's key, joins beside it
    // as the move's target, its lists confirmed absent, and learns its library key only from its relays or by making one
    ensureIdentityRow(db, clock, S.pubkey(), 'new', true);
    seedGeneratedLists(db, S.pubkey(), D);
    queueSwitch(db, clock, S.pubkey(), T.pubkey(), 'nip55', { relays: null, servers: null, known: true }, false, D);
  } else {
    ensureIdentityRow(db, clock, T.pubkey(), 'recovery_code', true);
    ensureIdentityRow(db, clock, S.pubkey(), 'early_share', true);
    seedGeneratedLists(db, T.pubkey(), D);
    seedGeneratedLists(db, S.pubkey(), D);
    // T was restored, so it learnt its library key at its first sync (F5); S was made here and makes its own
    db.run('UPDATE identities SET library_key = ?, library_key_at = 1 WHERE pubkey = ?', '0a'.repeat(32), T.pubkey());
    db.run("UPDATE identities SET role = 'move_source' WHERE pubkey = ?", S.pubkey());
    db.run("INSERT INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES (?, 'move', 'queued', 0, ?, 1, 1)",
      `move:${S.pubkey()}`, JSON.stringify({ from: S.pubkey(), to: T.pubkey() }));
  }

  /** A save under owner, its blob staged on the phone (or only on the operator's server), then sent. */
  async function save(owner: Signer, n: number, opts: { state?: 'unread' | 'archived'; stagedOnly?: boolean } = {}) {
    const pk = owner.pubkey();
    const md = normaliseMarkdown(`# Title ${n}\n\nSome words.`);
    const enc = await encryptText(md, nodeCrypto);
    staged.set(enc.text.sha256, enc.blob);
    queueSave(db, clock, {
      owner: pk, hash: h(n), url: `https://e.com/${n}`, canonical: null, title: `Title ${n}`, site: 'e.com', byline: null, savedAt: clock + n,
      words: 2, lang: 'en', hero: null, text: enc.text, textHash: textHash(md, nodeCrypto), textState: 'cached', origin: 'share',
    }, { sha256: enc.text.sha256, size: enc.blob.length, path: '/staged' }, T3);
    if (opts.state === 'archived') db.run("UPDATE items SET state = 'archived' WHERE owner = ? AND hash = ?", pk, h(n));
    db.run("UPDATE outbox SET state = 'queued' WHERE state = 'held'");
    if (!opts.stagedOnly) {
      // only S's own signer is the outbox's during setup
      await runOutbox();
      staged.delete(enc.text.sha256);
    }
    return enc.text.sha256;
  }
  return { db, S, T, p, log, devicePosts, relays, blossom, staged, save, syncPorts, tick: (s: number) => (clock += s), keysRetired: () => keysRetired };
}

/** Runs the move with relays a and b unreachable, so it stops at step 4's read-back with S whole; then time passes. */
async function waitAtReadBack(w: ReturnType<typeof world>) {
  const off = (r: string) => r === 'ws://a' || r === 'ws://b';
  const cut: MovePorts = {
    ...w.p,
    publish: (r, e) => (off(r) ? Promise.reject(new Error('down')) : w.p.publish(r, e)),
    query: (r, f) => (off(r) ? Promise.reject(new Error('down')) : w.p.query(r, f)),
  };
  cut.runOutbox = () => drain({
    db: w.db, now: () => 2_000, signer: async (pk) => (pk === w.S.pubkey() ? w.S : pk === w.T.pubkey() ? w.T : null),
    fetch: w.p.fetch, crypto: nodeCrypto, defaults: () => D, publish: cut.publish, readBlob: w.p.readStaged,
  });
  expect(await runMove(cut)).toBe('waiting');
  expect(moveJob(w.db)?.step).toBe(4);
  w.tick(60);
}

const rowsOf = (w: ReturnType<typeof world>, pk: string) => w.db.all<{ hash: string; state: string }>('SELECT hash, state FROM items WHERE owner = ? ORDER BY hash', pk);

describe('The move (contract 4.8, mobile spec 4.10)', () => {
  test('early saves go to T: copied, re-owned blobs, read back, then S retired', async () => {
    const w = world();
    const sha1 = await w.save(w.S, 1);
    await w.save(w.S, 2, { stagedOnly: true });
    w.tick(10);
    expect(await runMove(w.p)).toBe('done');
    expect(rowsOf(w, w.S.pubkey())).toEqual([]);
    expect(rowsOf(w, w.T.pubkey()).map((r) => r.hash)).toEqual([h(1), h(2)]);
    // T took the published blob, fetched back from the operator, as its own
    expect(w.blossom.get(sha1)!.owners).toEqual(new Set([w.S.pubkey(), w.T.pubkey()]));
    // T's saves are on its relays; S's are deleted, and S's account went last
    const op = w.relays.get('ws://op')!;
    expect(op.filter((e) => e.kind === 30078 && e.pubkey === w.T.pubkey() && e.tags.some((t) => t[1]?.startsWith('kefli/item/'))).length).toBe(2);
    expect(op.some((e) => e.kind === 5 && e.pubkey === w.S.pubkey())).toBe(true);
    const del = w.log.findIndex((l) => l.startsWith('DELETE http://api/account'));
    expect(w.log[del]).toContain(w.S.pubkey().slice(0, 4));
    expect(w.log.findIndex((l) => l.startsWith(`publish ws://op 5 ${w.S.pubkey().slice(0, 4)}`))).toBeLessThan(del);
    expect(w.db.get('SELECT 1 FROM identities WHERE pubkey = ?', w.S.pubkey())).toBeUndefined();
    expect(w.keysRetired()).toBe(true);
    expect(moveJob(w.db)).toBeNull();
    // searchable under T
    expect(w.db.all('SELECT rowid FROM items_fts WHERE items_fts MATCH ?', 'words').length).toBe(2);
  });

  test("a save T holds keeps T's copy, un-archived only when S's is unread", async () => {
    const w = world();
    await w.save(w.T, 1, { state: 'archived' });
    await w.save(w.T, 2, { state: 'archived' });
    await w.save(w.S, 1);
    await w.save(w.S, 2, { state: 'archived' });
    expect(await runMove(w.p)).toBe('done');
    expect(rowsOf(w, w.T.pubkey())).toEqual([{ hash: h(1), state: 'unread' }, { hash: h(2), state: 'archived' }]);
  });

  test('a save from a newer Kefli stops it before anything is copied, S untouched', async () => {
    const w = world();
    await w.save(w.S, 1);
    w.db.run("INSERT INTO items_future (owner, d, event_json, created_at) VALUES (?, 'kefli/item/x', '{}', 1)", w.T.pubkey());
    expect(await runMove(w.p)).toBe('newer');
    expect(rowsOf(w, w.S.pubkey()).length).toBe(1);
    expect(rowsOf(w, w.T.pubkey())).toEqual([]);
    expect(moveJob(w.db)?.step).toBe(1);
    expect(w.log.some((l) => l.includes('/account'))).toBe(false);
  });

  test("a library whose saves wait for its signer holds the move at the collect, then it carries on (F14)", async () => {
    const w = world();
    await w.save(w.S, 1);
    let answers = false;
    const p: MovePorts = { ...w.p, collect: async (owner, signer) => answers && (await w.p.collect(owner, signer)) };
    expect(await runMove(p)).toBe('waiting');
    expect(moveJob(w.db)?.step).toBe(0);
    expect(rowsOf(w, w.T.pubkey())).toEqual([]);
    // T's collect answers, S's still waits: the move stops before copying anything
    p.collect = async (owner, signer) => (owner === w.T.pubkey() || answers) && (await w.p.collect(owner, signer));
    expect(await runMove(p)).toBe('waiting');
    expect(moveJob(w.db)?.step).toBe(1);
    expect(rowsOf(w, w.T.pubkey())).toEqual([]);
    answers = true;
    expect(await runMove(p)).toBe('done');
    expect(rowsOf(w, w.T.pubkey())).toEqual([{ hash: h(1), state: 'unread' }]);
  });

  test('cut short at the read-back, it waits with S whole, then resumes without copying twice', async () => {
    const w = world();
    await w.save(w.S, 1);
    // relays a and b unreachable: only the operator's holds T's copy, one of the two the read-back needs
    const off = (r: string) => r === 'ws://a' || r === 'ws://b';
    const cut: MovePorts = {
      ...w.p,
      publish: (r, e) => (off(r) ? Promise.reject(new Error('down')) : w.p.publish(r, e)),
      query: (r, f) => (off(r) ? Promise.reject(new Error('down')) : w.p.query(r, f)),
    };
    cut.runOutbox = () => drain({
      db: w.db, now: () => 2_000, signer: async (pk) => (pk === w.S.pubkey() ? w.S : pk === w.T.pubkey() ? w.T : null),
      fetch: w.p.fetch, crypto: nodeCrypto, defaults: () => D, publish: cut.publish, readBlob: w.p.readStaged,
    });
    expect(await runMove(cut)).toBe('waiting');
    expect(rowsOf(w, w.S.pubkey()).length).toBe(1);
    expect(moveJob(w.db)?.step).toBe(4);
    w.db.run('UPDATE outbox_targets SET next_at = 0');
    expect(await runMove(w.p)).toBe('done');
    expect(rowsOf(w, w.T.pubkey()).length).toBe(1);
    expect(w.relays.get('ws://op')!.filter((e) => e.kind === 30078 && e.pubkey === w.T.pubkey() && e.tags.some((t) => t[1]?.startsWith('kefli/item/'))).length).toBe(1);
  });

  test('an old address S never managed to retire is deleted with S’s saves (F5)', async () => {
    const w = world();
    await w.save(w.S, 1);
    // S moved this save to its keyed address, but every relay refused the kind 5 for its address before v1.10
    const old = `kefli/item/${h(1)}`;
    enqueue(w.db, 1, { op: 'delete_item', signer: w.S.pubkey(), subject: `retire:${old}`, payload: { ds: [old], after: 1 }, targets: ['ws://op'] });
    w.db.run("UPDATE outbox SET state = 'dead' WHERE subject = ?", `retire:${old}`);
    expect(await runMove(w.p)).toBe('done');
    const named = w.relays.get('ws://op')!.filter((e) => e.kind === 5 && e.pubkey === w.S.pubkey()).flatMap((e) => e.tags).map((t) => t[1]);
    expect(named).toContain(`30078:${w.S.pubkey()}:${old}`);
  });

  test('one write relay down still confirms on the other two', async () => {
    const w = world();
    await w.save(w.S, 1);
    const p: MovePorts = {
      ...w.p,
      publish: (r, e) => (r === 'ws://b' ? Promise.reject(new Error('down')) : w.p.publish(r, e)),
      query: (r, f) => (r === 'ws://b' ? Promise.reject(new Error('down')) : w.p.query(r, f)),
    };
    p.runOutbox = () => drain({
      db: w.db, now: () => 2_000, signer: async (pk) => (pk === w.S.pubkey() ? w.S : pk === w.T.pubkey() ? w.T : null),
      fetch: w.p.fetch, crypto: nodeCrypto, defaults: () => D, publish: p.publish, readBlob: w.p.readStaged,
    });
    expect(await runMove(p)).toBe('done');
  });

  test("S's connected browsers get T, a new token and a pair-ack sealed by S with moved_from", async () => {
    const w = world();
    const device = new LocalSigner(nodeCrypto.randomBytes(32));
    w.db.run("INSERT INTO devices (token, owner, device_pubkey, label, relay, connected_at) VALUES ('old', ?, ?, 'Firefox', 'ws://op', 1)", w.S.pubkey(), device.pubkey());
    expect(await runMove(w.p)).toBe('done');
    const wrap = w.relays.get('ws://op')!.find((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === device.pubkey()))!;
    const { rumor, seal } = await unwrap(device, wrap);
    const ack = JSON.parse(rumor.content);
    expect(seal.pubkey).toBe(w.S.pubkey());
    expect(ack).toMatchObject({ user_pubkey: w.T.pubkey(), moved_from: w.S.pubkey() });
    expect(ack.nonce).toBeUndefined();
    expect(w.db.all<{ token: string }>('SELECT token FROM devices WHERE owner = ?', w.T.pubkey()).map((r) => r.token)).toEqual([ack.token]);
    expect(w.log.some((l) => l.startsWith('POST http://api/devices') && l.endsWith(w.T.pubkey().slice(0, 4)))).toBe(true);
  });

  test('POST /devices as T carries a release S signs for that browser going to T, and no proof (C§4.8 step 4)', async () => {
    const w = world();
    const device = new LocalSigner(nodeCrypto.randomBytes(32));
    w.db.run("INSERT INTO devices (token, owner, device_pubkey, label, relay, connected_at) VALUES ('old', ?, ?, 'Firefox', 'ws://op', 1)", w.S.pubkey(), device.pubkey());
    expect(await runMove(w.p)).toBe('done');
    expect(w.devicePosts).toHaveLength(1);
    const [{ author, body }] = w.devicePosts;
    expect(author).toBe(w.T.pubkey());
    expect(Object.keys(body).sort()).toEqual(['device_pubkey', 'release', 'v']);
    const release = body.release as { pubkey: string; created_at: number; sig: string };
    expect(release.pubkey).toBe(w.S.pubkey());
    expect(statementHolds(w.S.pubkey(), releaseTemplate(D.operator.api, device.pubkey(), w.T.pubkey(), release.created_at), release.sig)).toBe(true);
    // the release names T: it does nothing for anyone else who might hold it
    expect(statementHolds(w.S.pubkey(), releaseTemplate(D.operator.api, device.pubkey(), w.S.pubkey(), release.created_at), release.sig)).toBe(false);
  });

  test("a POST /devices the API refuses leaves that browser with S, and the move still finishes", async () => {
    const w = world();
    const device = new LocalSigner(nodeCrypto.randomBytes(32));
    w.db.run("INSERT INTO devices (token, owner, device_pubkey, label, relay, connected_at) VALUES ('old', ?, ?, 'Firefox', 'ws://op', 1)", w.S.pubkey(), device.pubkey());
    const fetch = w.p.fetch;
    const p: MovePorts = { ...w.p, fetch: (async (url: string, init: RequestInit) => (String(url).endsWith('/devices') ? new Response('{"v":1,"error":"release: holder"}', { status: 403 }) : fetch(url, init))) as typeof globalThis.fetch };
    p.runOutbox = () => drain({
      db: w.db, now: () => 1_000, signer: async (pk) => (pk === w.S.pubkey() ? w.S : pk === w.T.pubkey() ? w.T : null),
      fetch: p.fetch, crypto: nodeCrypto, defaults: () => D, publish: w.p.publish, readBlob: w.p.readStaged,
    });
    expect(await runMove(p)).toBe('done');
    // no pair-ack went to the browser, so it isn't told it moved to a library the operator doesn't hold it for
    expect(w.relays.get('ws://op')!.some((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === device.pubkey()))).toBe(false);
    expect(w.db.all('SELECT token FROM devices WHERE owner = ?', w.T.pubkey())).toEqual([]);
  });

  test('a browser known only from the synced record gets its pair-ack on the operator relay, and the move finishes (F19)', async () => {
    const w = world();
    const device = new LocalSigner(nodeCrypto.randomBytes(32));
    // a reinstall or restore: the browser comes from S's kefli/devices record, which carries no relay
    absorbRecord(w.db, w.S.pubkey(), { v: 1, devices: [{ device_pubkey: device.pubkey(), label: 'Chrome', token: 'old', connected_at: 1, revoked_at: null }] }, 'ee'.repeat(32), 1);
    expect(await runMove(w.p)).toBe('done');
    const wrap = w.relays.get('ws://op')!.find((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === device.pubkey()))!;
    expect(JSON.parse((await unwrap(device, wrap)).rumor.content)).toMatchObject({ user_pubkey: w.T.pubkey(), moved_from: w.S.pubkey() });
    expect(w.db.all('SELECT relay FROM devices WHERE owner = ?', w.T.pubkey())).toEqual([{ relay: 'ws://op' }]);
    expect(w.db.get('SELECT 1 FROM outbox_targets WHERE target IS NULL')).toBeUndefined();
  });

  test('a move that goes back for a save found at the end pairs each browser once', async () => {
    const w = world();
    const device = new LocalSigner(nodeCrypto.randomBytes(32));
    w.db.run("INSERT INTO devices (token, owner, device_pubkey, label, relay, connected_at) VALUES ('old', ?, ?, 'Firefox', 'ws://op', 1)", w.S.pubkey(), device.pubkey());
    await w.save(w.S, 1);
    let drained = false;
    const p: MovePorts = {
      ...w.p,
      drainSourceInbox: async () => {
        if (drained) return;
        drained = true;
        await w.save(w.S, 2);
      },
    };
    expect(await runMove(p)).toBe('done');
    expect(w.relays.get('ws://op')!.filter((e) => e.kind === 1059 && e.tags.some((t) => t[0] === 'p' && t[1] === device.pubkey())).length).toBe(1);
    expect(w.db.all('SELECT token FROM devices WHERE owner = ?', w.T.pubkey()).length).toBe(1);
  });

  test('changes made under S while the move waits reach T at retire, and a save deleted meanwhile stays deleted (F20)', async () => {
    const w = world();
    for (const n of [1, 2, 3, 4]) await w.save(w.S, n);
    await waitAtReadBack(w);
    // the app restarted on S's Saves: the person archives one, reads into another and deletes the third
    const S = w.S.pubkey();
    release(w.db, setArchived(w.db, 1_100, S, h(1), true).held);
    setPosition(w.db, 1_100, S, h(2), 1, true);
    const del = deleteItem(w.db, 1_100, S, h(3));
    commitDelete(w.db, S, h(3), del.held);
    // and another phone on S archived the fourth, which a sync took as it takes any newer event
    w.db.run("UPDATE items SET state = 'archived', event_id = ?, event_created_at = 1100, published = 1, dirty = 0 WHERE owner = ? AND hash = ?", 'ff'.repeat(32), S, h(4));
    w.db.run('UPDATE outbox_targets SET next_at = 0');
    expect(await runMove(w.p)).toBe('done');
    // T is the phone's identity now, and its outbox sends what was carried
    await w.p.runOutbox();
    const T = w.T.pubkey();
    expect(w.db.all('SELECT hash, state, position_word FROM items WHERE owner = ? ORDER BY hash', T)).toEqual([
      { hash: h(1), state: 'archived', position_word: 0 },
      { hash: h(2), state: 'unread', position_word: 1 },
      { hash: h(4), state: 'archived', position_word: 0 },
    ]);
    // published as T's, and T's copy of the deleted save is deleted on T's relays
    const op = w.relays.get('ws://op')!;
    const mine = await Promise.all(op.filter((e) => e.kind === 30078 && e.pubkey === T && e.tags.some((t) => t[1]?.startsWith('kefli/item/')))
      .map((e) => readItemEvent(w.T, e)));
    expect(mine.find((m) => m.hash === h(1))!.item.item.state).toBe('archived');
    const gone = mine.find((m) => m.hash === h(3))!;
    expect(op.some((e) => e.kind === 5 && e.pubkey === T && e.tags.some((t) => t[0] === 'a' && t[1] === `30078:${T}:${gone.d}`))).toBe(true);
    expect(w.db.get("SELECT 1 FROM outbox WHERE signer = ? AND op = 'publish_item' AND state != 'dead'", T)).toBeUndefined();
  });

  test("a save deleted under S while the move waits, its kind 5 not yet out, is named in S's retirement (F20)", async () => {
    const w = world();
    await w.save(w.S, 1);
    await w.save(w.S, 2);
    await waitAtReadBack(w);
    const S = w.S.pubkey();
    const d2 = w.db.get<{ remote_d: string }>('SELECT remote_d FROM items WHERE owner = ? AND hash = ?', S, h(2))!.remote_d;
    // every relay refused the kind 5 until the outbox gave up on it
    const del = deleteItem(w.db, 1_100, S, h(2));
    commitDelete(w.db, S, h(2), del.held);
    w.db.run("UPDATE outbox SET state = 'dead' WHERE op = 'delete_item' AND signer = ?", S);
    w.db.run('UPDATE outbox_targets SET next_at = 0');
    expect(await runMove(w.p)).toBe('done');
    const named = w.relays.get('ws://op')!.filter((e) => e.kind === 5 && e.pubkey === S).flatMap((e) => e.tags).map((t) => t[1]);
    expect(named).toContain(`30078:${S}:${d2}`);
  });

  test('DELETE /account refused: S stays, to try again', async () => {
    const w = world({ accountStatus: 500 });
    await w.save(w.S, 1);
    expect(await runMove(w.p)).toBe('waiting');
    expect(w.db.get('SELECT 1 FROM identities WHERE pubkey = ?', w.S.pubkey())).toBeTruthy();
    expect(moveJob(w.db)?.step).toBe(5);
  });

  test("S's own retirement kind 5s, read back by a sync after DELETE /account failed, leave T's copies alone", async () => {
    const w = world({ accountStatus: 500 });
    await w.save(w.S, 1);
    await w.save(w.S, 2);
    expect(await runMove(w.p)).toBe('waiting');
    expect(moveJob(w.db)).toMatchObject({ step: 5, carried: true });
    // in a switch S is still the active identity, which the next sync syncs: its own kind 5s remove its rows
    w.tick(30);
    await w.p.collect(w.S.pubkey(), w.S);
    expect(rowsOf(w, w.S.pubkey())).toEqual([]);
    const ok = (async (url: string, init?: RequestInit) =>
      url.endsWith('/account') ? new Response('{}', { status: 200 }) : w.p.fetch(url, init)) as typeof fetch;
    w.tick(30);
    expect(await runMove({ ...w.p, fetch: ok })).toBe('done');
    expect(rowsOf(w, w.T.pubkey()).map((r) => r.hash)).toEqual([h(1), h(2)]);
    expect(w.db.get("SELECT 1 FROM outbox WHERE signer = ? AND op IN ('delete_item', 'delete_blob')", w.T.pubkey())).toBeUndefined();
  });

  test('a move stopped after retireLocal, before it is marked done, keeps T whole when it resumes', async () => {
    const w = world();
    await w.save(w.S, 1);
    const p = { ...w.p, retireKeys: async () => { throw new Error('Keystore not ready'); } };
    await expect(runMove(p)).rejects.toThrow('Keystore');
    expect(moveJob(w.db)?.step).toBe(5);
    w.tick(30);
    expect(await runMove(w.p)).toBe('done');
    expect(rowsOf(w, w.T.pubkey()).map((r) => r.hash)).toEqual([h(1)]);
    expect(w.keysRetired()).toBe(true);
  });

  test("S's kind 5s are dated past its newest version, though another phone's clock ran ahead of this one (F36)", async () => {
    const w = world();
    await w.save(w.S, 1);
    const S = w.S.pubkey();
    // a newer version taken from a phone whose clock runs ten minutes fast
    w.db.run('UPDATE items SET event_created_at = 1600 WHERE owner = ? AND hash = ?', S, h(1));
    expect(await runMove(w.p)).toBe('done');
    const fives = w.relays.get('ws://op')!.filter((e) => e.kind === 5 && e.pubkey === S);
    expect(fives.length).toBeGreaterThan(0);
    for (const e of fives) expect(e.created_at).toBeGreaterThan(1600);
  });

  test('a text no server has is copied without it; servers that are down make it wait', async () => {
    const w = world();
    const sha = await w.save(w.S, 1);
    w.blossom.delete(sha);
    expect(await runMove(w.p)).toBe('done');
    expect(w.db.get<{ fail_reason: string }>('SELECT fail_reason FROM items WHERE owner = ?', w.T.pubkey())?.fail_reason).toBe('blob_missing');

    const v = world({ down: new Set(['http://blossom', 'http://m1']) });
    await v.save(v.S, 1, { stagedOnly: true });
    v.staged.clear();
    expect(await runMove(v.p)).toBe('waiting');
    expect(moveJob(v.db)?.step).toBe(2);
  });

  test("a save found in S's inbox at the end goes back through the copy", async () => {
    const w = world();
    await w.save(w.S, 1);
    let drained = false;
    const p: MovePorts = {
      ...w.p,
      drainSourceInbox: async () => {
        if (drained) return;
        drained = true;
        await w.save(w.S, 2);
      },
    };
    expect(await runMove(p)).toBe('done');
    expect(rowsOf(w, w.T.pubkey()).map((r) => r.hash)).toEqual([h(1), h(2)]);
  });

  /** T's newest copy of a save on a relay the operator doesn't run. */
  async function tCopy(w: ReturnType<typeof world>, hash: string) {
    const T = w.T.pubkey();
    const mine = await Promise.all(w.relays.get('ws://a')!.filter((e) => e.kind === 30078 && e.pubkey === T && e.tags.some((t) => t[1]?.startsWith('kefli/item/')))
      .map((e) => readItemEvent(w.T, e)));
    return mine.find((m) => m.hash === hash)!.item.item;
  }

  test("an upload refused under T counts as settled: T's copy names the mirror holding S's text, which waits under T (C§4.8, v1.12)", async () => {
    let refused = '';
    const w = world({ refuse: (author) => author === refused });
    refused = w.T.pubkey();
    const T = w.T.pubkey();
    const sha = await w.save(w.S, 1);
    expect(await runMove(w.p)).toBe('done');
    expect((await tCopy(w, h(1))).text).toMatchObject({ sha256: sha, servers: ['http://m1'] });
    // the text waits under T, its ciphertext kept on the phone, and it stays backed up on the mirror
    expect(w.db.get('SELECT owner, operator_at, last_error, mirror_url FROM blobs')).toEqual({ owner: T, operator_at: null, last_error: 'quota', mirror_url: 'http://m1' });
    expect(w.staged.has(sha)).toBe(true);
    expect(notBackedUp(w.db, T)).toBe(0);
    // room comes: T's upload goes from the phone's copy, and the save goes out again naming both
    refused = 'nobody';
    w.tick(86_400);
    await w.p.runOutbox();
    expect((await tCopy(w, h(1))).text).toMatchObject({ sha256: sha, servers: ['http://blossom', 'http://m1'] });
    expect(w.blossom.get(sha)!.owners.has(T)).toBe(true);
    expect(notBackedUp(w.db, T)).toBe(0);
  });

  test("T's day used: its copies of texts the operator holds under S still go, costing nothing against the day, and stay T's", async () => {
    let dayUsed = '';
    const w = world({ dayUsed: (author) => author === dayUsed });
    const T = w.T.pubkey();
    // S's later save is on the operator under S; its first waits on the phone, refused for S's day
    const taken = await w.save(w.S, 2);
    dayUsed = w.S.pubkey();
    const waiting = await w.save(w.S, 1, { stagedOnly: true });
    await w.p.runOutbox();
    expect([w.blossom.get(taken)?.owners.has(w.S.pubkey()), w.blossom.has(waiting)]).toEqual([true, false]);
    // T's day is used too: the first copy's text, which only the phone has, is refused for it
    dayUsed = T;
    expect(await runMove(w.p)).toBe('done');
    expect(w.blossom.has(waiting)).toBe(false);
    expect(w.db.get('SELECT owner, last_error FROM blobs WHERE sha256 = ?', waiting)).toEqual({ owner: T, last_error: 'daily' });
    // the text the operator held under S went under T all the same, so S's retirement leaves it there
    expect(w.blossom.get(taken)!.owners.has(T)).toBe(true);
    expect((await tCopy(w, h(2))).text).toMatchObject({ sha256: taken, servers: ['http://blossom', 'http://m1'] });
    expect(notBackedUp(w.db, T)).toBe(1);
  });

  test('a text that waited on the phone under S goes under T without text, and waits there', async () => {
    const w = world({ refuse: () => true });
    const T = w.T.pubkey();
    const sha = await w.save(w.S, 1, { stagedOnly: true });
    await w.p.runOutbox();
    expect(w.db.get('SELECT owner, last_error FROM blobs')).toEqual({ owner: w.S.pubkey(), last_error: 'quota' });
    expect(await runMove(w.p)).toBe('done');
    expect((await tCopy(w, h(1))).text).toBeNull();
    expect(w.db.get('SELECT owner, operator_at, last_error, mirror_url FROM blobs')).toEqual({ owner: T, operator_at: null, last_error: 'quota', mirror_url: null });
    expect(w.staged.has(sha)).toBe(true);
    expect(w.db.get("SELECT 1 AS n FROM outbox WHERE signer = ? AND op = 'upload_blob' AND state = 'queued'", T)).toEqual({ n: 1 });
    expect(notBackedUp(w.db, T)).toBe(1);
  });

  test("a text S had from another phone's upload: T's copy names the mirror S's copy named", async () => {
    let refused = '';
    const w = world({ refuse: (author) => author === refused });
    refused = w.T.pubkey();
    const md = normaliseMarkdown('# From another phone\n\nWords.');
    const enc = await encryptText(md, nodeCrypto);
    w.blossom.set(enc.text.sha256, { bytes: enc.blob, owners: new Set(['another']) });
    w.db.run(
      `INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, text_sha256, text_key, text_nonce, text_hash, text_servers, words)
       VALUES (?, ?, 'https://e.com/9', 5, 'unread', 'cached', 'sync', ?, ?, ?, ?, ?, 4)`,
      w.S.pubkey(), h(9), enc.text.sha256, enc.text.key, enc.text.nonce, textHash(md, nodeCrypto), JSON.stringify(['http://blossom', 'http://m2']),
    );
    expect(await runMove(w.p)).toBe('done');
    expect((await tCopy(w, h(9))).text).toMatchObject({ sha256: enc.text.sha256, servers: ['http://m2'] });
    expect(w.db.get('SELECT mirror_url FROM blobs')).toEqual({ mirror_url: 'http://m2' });
  });

  test("a switch's target learns its library key through its own signer, though the sync's answers only for the phone's identity, S", async () => {
    for (const held of [false, true]) {
      const w = world({ switch: true });
      const T = w.T.pubkey();
      // T's record from another phone, when it has used Kefli before
      const theirs = nodeCrypto.randomBytes(32);
      if (held) for (const r of ['ws://op', 'ws://a', 'ws://b']) await w.p.publish(r, await buildLibraryKeyEvent(w.T, theirs, 900));
      await w.save(w.S, 1);
      await w.save(w.S, 2);
      // the phone's sync ports (services/runner.ts) answer for the signer slot alone, which is S's until the move ends
      const phone = { ...w.syncPorts, signer: async (pk: string) => (pk === w.S.pubkey() ? w.S : null) };
      const p: MovePorts = { ...w.p, collect: async (owner, signer) => (await syncOwner(phone, owner, signer)).waiting === 0 };
      expect(await runMove(p)).toBe('done');
      const key = libraryKey(w.db, T)!;
      if (held) expect(key).toEqual(theirs);
      // T's copies went out at the addresses T's own key makes, on every write relay
      for (const r of ['ws://op', 'ws://a', 'ws://b']) {
        const ds = w.relays.get(r)!.filter((e) => e.kind === 30078 && e.pubkey === T).map((e) => e.tags.find((t) => t[0] === 'd')?.[1]);
        expect(ds).toEqual(expect.arrayContaining([savedD(key, h(1)), savedD(key, h(2))]));
      }
      expect(rowsOf(w, T).map((r) => r.hash)).toEqual([h(1), h(2)]);
    }
  });

  test('a switch puts T beside S as the target, its lists settled, and queues the move', () => {
    const db = memoryDb();
    migrate(db);
    ensureIdentityRow(db, 1, 'a'.repeat(64), 'new', true);
    queueSwitch(db, 5, 'a'.repeat(64), 'b'.repeat(64), 'nip55', { relays: null, servers: null, known: true }, false, D);
    expect(db.all('SELECT pubkey, role, provider FROM identities ORDER BY pubkey')).toEqual([
      { pubkey: 'a'.repeat(64), role: 'active', provider: 'local' },
      { pubkey: 'b'.repeat(64), role: 'move_target', provider: 'nip55' },
    ]);
    expect(db.get<{ value: string }>("SELECT value FROM settings WHERE key = 'lists.keep_copies'")?.value).toBe('0');
    expect(db.get('SELECT 1 FROM relays WHERE owner = ?', 'b'.repeat(64))).toBeTruthy();
    expect(moveJob(db)).toMatchObject({ from: 'a'.repeat(64), to: 'b'.repeat(64), step: 0 });
  });
});

describe("the move's calls to servers take the hops, each with a deadline (7.1)", () => {
  afterEach(() => jest.useRealTimers());
  const blobAt = (url: string) => /\/[0-9a-f]{64}$/.test(url);

  test("S's servers sending the text's GET and HEAD into the phone's network: nothing is asked there, and the move waits", async () => {
    const w = world();
    await w.save(w.S, 1);
    const net = inward(w.p.fetch, (m, url) => (m === 'GET' || m === 'HEAD') && blobAt(url));
    // followed as OkHttp followed it, S's text was asked for at 192.168.1.1
    expect(await runMove({ ...w.p, fetch: net.f })).toBe('waiting');
    expect(net.asked).toEqual([]);
    expect(moveJob(w.db)?.step).toBe(2);
    expect(rowsOf(w, w.T.pubkey())).toEqual([]);
  });

  test("the API sending S's DELETE /account into the phone's network: nothing is asked there, and S stays to retire later", async () => {
    const w = world();
    await w.save(w.S, 1);
    const net = inward(w.p.fetch, (m, url) => m === 'DELETE' && url.endsWith('/account'));
    expect(await runMove({ ...w.p, fetch: net.f })).toBe('waiting');
    expect(net.asked).toEqual([]);
    expect(moveJob(w.db)?.step).toBe(5);
    expect(w.keysRetired()).toBe(false);
  });

  test("the API answering S's DELETE /account with any redirect: nothing it names is asked, and S stays to retire later", async () => {
    // every call to the API is signed for its exact address (C§6), so it never answers through a redirect. Followed, a
    // 303 to any page that answers 200 read as S's account deleted, and S's keys went with its library still held there
    for (const [status, location] of [[303, 'https://news.example/'], [307, '/v1/account'], [302, null]] as const) {
      const w = world();
      await w.save(w.S, 1);
      const base = w.p.fetch;
      const asked: string[] = [];
      const away = (async (url: string, init: RequestInit = {}) => {
        if (init.method !== 'DELETE' || !url.endsWith('/account')) return base(url, init);
        asked.push(url);
        return url === 'http://api/account' ? new Response(null, { status, headers: location ? { location } : {} }) : new Response('{}', { status: 200 });
      }) as typeof fetch;
      expect([status, await runMove({ ...w.p, fetch: away })]).toEqual([status, 'waiting']);
      expect([status, asked, moveJob(w.db)?.step, w.keysRetired()]).toEqual([status, ['http://api/account'], 5, false]);
      expect(w.db.get('SELECT 1 AS n FROM identities WHERE pubkey = ?', w.S.pubkey())).toEqual({ n: 1 });
    }
  });

  test('a server too slow to send the text in its time makes the move wait: the text is never copied as missing', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const w = world();
    await w.save(w.S, 1);
    const base = w.p.fetch;
    // the servers answer a HEAD at once, but never send the text itself
    const slow = (async (url: string, init: RequestInit) => ((init.method ?? 'GET') === 'GET' && blobAt(url) ? silent(url, init) : base(url, init))) as typeof fetch;
    const run = watch(runMove({ ...w.p, fetch: slow }));
    await jest.advanceTimersByTimeAsync(4 * TEXT_TIMEOUT_MS);
    // without a deadline it waited for ever; read as missing, the HEAD's answer had T's copy made without its text,
    // and S's retirement took the text with it
    expect(run).toMatchObject({ settled: true, value: 'waiting' });
    expect(moveJob(w.db)?.step).toBe(2);
    expect(w.db.get("SELECT 1 FROM items WHERE fail_reason = 'blob_missing'")).toBeUndefined();
  });

  test('an API that takes DELETE /account and never answers is let go at its deadline; S stays to retire later', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const w = world();
    await w.save(w.S, 1);
    const base = w.p.fetch;
    const stalls = (async (url: string, init: RequestInit) => (init.method === 'DELETE' && url.endsWith('/account') ? silent(url, init) : base(url, init))) as typeof fetch;
    const run = watch(runMove({ ...w.p, fetch: stalls }));
    await jest.advanceTimersByTimeAsync(SERVER_TIMEOUT_MS + 1_000);
    expect(run).toMatchObject({ settled: true, value: 'waiting' });
    expect(moveJob(w.db)?.step).toBe(5);
  });
});
