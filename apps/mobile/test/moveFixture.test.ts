import { LocalSigner, readItemEvent, savedD, type Item, type NostrEvent, type Signer } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { base64 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { drain } from '../src/services/send';
import { syncOwner, type Filter } from '../src/services/sync';
import { runMove, type MovePorts } from '../src/services/move';
import type { Defaults } from '../src/services/config';
import { memoryDb } from './sqlite';

// Contract section 9's move scenario as a decrypt-and-compare test (mobile spec 11.1): S's three saves and T's one are
// on the relays, the phone moves S into T, and what it published under T must decrypt to the fixture's expected items.
type Save = { hash: string; d: string; event: NostrEvent; item: Item };
type Side = { secret_key: string; pubkey: string; library_key: string; library_key_record: NostrEvent; items: Save[] };
type Fixture = { defaults: Defaults; source: Side; target: Side; blobs: Record<string, string>; expected: { hash: string; item: Item }[] };
const f: Fixture = JSON.parse(readFileSync(join(__dirname, '../../../shared/fixtures/protocol/move.json'), 'utf8'));
const D = f.defaults;
const WRITE = [D.operator.relay, ...D.relays];

function matches(e: NostrEvent, x: Filter): boolean {
  const tag = (k: string, vs?: string[]) => !vs || e.tags.some((t) => t[0] === k && vs.includes(t[1]));
  return x.kinds.includes(e.kind) && (!x.authors || x.authors.includes(e.pubkey)) && tag('t', x['#t']) && tag('k', x['#k']) && tag('d', x['#d']) && tag('p', x['#p'])
    && (x.since === undefined || e.created_at >= x.since) && (x.until === undefined || e.created_at <= x.until);
}

function world() {
  const db = memoryDb();
  migrate(db);
  const S = new LocalSigner(hexToBytes(f.source.secret_key));
  const T = new LocalSigner(hexToBytes(f.target.secret_key));
  const signers = new Map<string, Signer>([[S.pubkey(), S], [T.pubkey(), T]]);
  const signerOf = async (pk: string) => signers.get(pk) ?? null;
  const library = [f.source.library_key_record, ...f.source.items.map((x) => x.event), f.target.library_key_record, ...f.target.items.map((x) => x.event)];
  const relays = new Map<string, NostrEvent[]>(WRITE.map((r) => [r, [...library]]));
  // S's texts on the operator's server and the mirror, as S's saves name them
  const blossom = new Map<string, Uint8Array>(Object.entries(f.blobs).map(([sha, b64]) => [sha, base64.decode(b64)]));
  const staged = new Map<string, Uint8Array>();
  const fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const sha = url.split('/').pop()!;
    if (url.endsWith('/upload')) {
      const bytes = new Uint8Array(init.body as ArrayBuffer);
      const s = bytesToHex(nodeCrypto.sha256(bytes));
      blossom.set(s, bytes);
      return new Response(JSON.stringify({ sha256: s }), { status: 200 });
    }
    if (url.endsWith('/mirror')) return new Response(JSON.stringify({ sha256: String(JSON.parse(String(init.body)).url).split('/').pop() }), { status: 200 });
    if (method === 'GET' && blossom.has(sha)) return new Response(blossom.get(sha)!.slice(), { status: 200 });
    if (method === 'GET' && /^[0-9a-f]{64}$/.test(sha)) return new Response('', { status: 404 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const publish = async (relay: string, event: NostrEvent) => {
    const list = relays.get(relay) ?? [];
    const d = event.tags.find((t) => t[0] === 'd')?.[1];
    // addressable: the newer copy replaces the older
    const kept = event.kind === 30078 && d ? list.filter((e) => !(e.kind === 30078 && e.pubkey === event.pubkey && e.tags.some((t) => t[0] === 'd' && t[1] === d))) : list;
    relays.set(relay, [...kept, event]);
    return { ok: true as const };
  };
  const query = async (relay: string, filters: Filter[]) => (relays.get(relay) ?? []).filter((e) => filters.some((x) => matches(e, x)));
  const runOutbox = () => drain({ db, now: () => 2_000_000_000, signer: signerOf, fetch, crypto: nodeCrypto, defaults: () => D, publish, readBlob: async (s) => staged.get(s) ?? null });
  const syncPorts = {
    db, now: () => 2_000_000_000, signer: signerOf, query, fetch, crypto: nodeCrypto, defaults: async () => D,
    files: { writeText: () => undefined, removeText: () => undefined, removeAll: () => undefined },
  };
  const p: MovePorts = {
    db, now: () => 2_000_000_000, source: S, target: T, defaults: async () => D, query, publish, fetch, crypto: nodeCrypto,
    readStaged: async (s) => staged.get(s) ?? null,
    stage: (s, bytes) => (staged.set(s, bytes), `/staged/${s}`),
    spoken: () => 'some words',
    collect: async (owner, signer) => (await syncOwner(syncPorts, owner, signer)).waiting === 0,
    runOutbox,
    drainSourceInbox: async () => undefined,
    retireKeys: async () => undefined,
  };
  // T came from the recovery code; S holds the shares made before it, and is the move's source
  ensureIdentityRow(db, 1, T.pubkey(), 'recovery_code', true);
  ensureIdentityRow(db, 1, S.pubkey(), 'early_share', true);
  seedGeneratedLists(db, T.pubkey(), D);
  seedGeneratedLists(db, S.pubkey(), D);
  db.run("UPDATE identities SET role = 'move_source' WHERE pubkey = ?", S.pubkey());
  db.run("INSERT INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES (?, 'move', 'queued', 0, ?, 1, 1)",
    `move:${S.pubkey()}`, JSON.stringify({ from: S.pubkey(), to: T.pubkey() }));
  return { p, T, relays };
}

describe('the move scenario (contract 4.8, 9)', () => {
  test("T's saves on each of its write relays decrypt to the expected items, at T's keyed addresses", async () => {
    const w = world();
    expect(await runMove(w.p)).toBe('done');
    const tKey = hexToBytes(f.target.library_key);
    for (const relay of WRITE) {
      const newest = new Map<string, NostrEvent>();
      for (const e of w.relays.get(relay)!) {
        const d = e.tags.find((t) => t[0] === 'd')?.[1] ?? '';
        if (e.kind !== 30078 || e.pubkey !== w.T.pubkey() || !d.startsWith('kefli/item/')) continue;
        if ((newest.get(d)?.created_at ?? -1) < e.created_at) newest.set(d, e);
      }
      const got = [];
      for (const [d, e] of newest) {
        const { hash, item } = await readItemEvent(w.T, e);
        expect(d).toBe(savedD(tKey, hash));
        got.push({ hash, item: item.item });
      }
      const byHash = (a: { hash: string }, b: { hash: string }) => (a.hash < b.hash ? -1 : 1);
      expect(got.sort(byHash)).toEqual([...f.expected].sort(byHash));
    }
  });
});
