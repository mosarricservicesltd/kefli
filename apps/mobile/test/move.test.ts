import { LocalSigner, encryptText, normaliseMarkdown, textHash, unwrap, type NostrEvent, type Signer } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { bytesToHex } from '@noble/hashes/utils.js';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, queueSave } from '../src/data/saves';
import { moveJob, queueSwitch } from '../src/data/move';
import { seedGeneratedLists } from '../src/data/lists';
import { drain } from '../src/services/send';
import { syncOwner, type Filter } from '../src/services/sync';
import { runMove, type MovePorts } from '../src/services/move';
import type { Defaults } from '../src/services/config';
import { memoryDb } from './sqlite';

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

function world(o: { down?: Set<string>; accountStatus?: number } = {}) {
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
    if (method === 'GET' && blossom.has(sha)) return new Response(blossom.get(sha)!.bytes, { status: 200 });
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
    collect: async (owner, signer) => void (await syncOwner(syncPorts, owner, signer)),
    runOutbox,
    drainSourceInbox: async () => undefined,
    retireKeys: async () => void (keysRetired = true),
  };
  ensureIdentityRow(db, clock, T.pubkey(), 'recovery_code', true);
  ensureIdentityRow(db, clock, S.pubkey(), 'early_share', true);
  seedGeneratedLists(db, T.pubkey(), D);
  seedGeneratedLists(db, S.pubkey(), D);
  // T was restored, so it learnt its library key at its first sync (F5); S was made here and makes its own
  db.run('UPDATE identities SET library_key = ?, library_key_at = 1 WHERE pubkey = ?', '0a'.repeat(32), T.pubkey());
  db.run("UPDATE identities SET role = 'move_source' WHERE pubkey = ?", S.pubkey());
  db.run("INSERT INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES (?, 'move', 'queued', 0, ?, 1, 1)",
    `move:${S.pubkey()}`, JSON.stringify({ from: S.pubkey(), to: T.pubkey() }));

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
  return { db, S, T, p, log, relays, blossom, staged, save, tick: (s: number) => (clock += s), keysRetired: () => keysRetired };
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

  test('DELETE /account refused: S stays, to try again', async () => {
    const w = world({ accountStatus: 500 });
    await w.save(w.S, 1);
    expect(await runMove(w.p)).toBe('waiting');
    expect(w.db.get('SELECT 1 FROM identities WHERE pubkey = ?', w.S.pubkey())).toBeTruthy();
    expect(moveJob(w.db)?.step).toBe(5);
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
