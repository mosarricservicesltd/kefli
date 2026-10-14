import { LocalSigner, secretKeyFromMnemonic, type NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { base64 } from '@scure/base';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { queueRestore } from '../src/data/settings';
import { beginRestore, restoreOf, settleRestore } from '../src/data/restore';
import { findLibrary } from '../src/services/recovery';
import { freshState, pickDefaults, type Defaults } from '../src/services/defaultsPick';
import { syncInbound, type Filter, type SyncPorts } from '../src/services/sync';
import { memoryDb } from './sqlite';

// Contract section 8 as the contract test it names: a restore from the recovery code alone, with the operator's API,
// relay and Blossom server switched off, run on the fixture shared/fixtures/protocol/restore.json (C§9). The phone
// has only the words and the defaults baked into its build.
type Fixture = {
  mnemonic: string; pubkey: string; library_key: string; defaults: Defaults;
  relays: Record<string, NostrEvent[]>; servers: Record<string, Record<string, string>>;
  expected: { saves: { hash: string; title: string; state: string; markdown: string | null }[]; deleted: string[] };
};
const f: Fixture = JSON.parse(readFileSync(join(__dirname, '../../../shared/fixtures/protocol/restore.json'), 'utf8'));
const operator = [f.defaults.operator.relay, f.defaults.operator.blossom, f.defaults.operator.api];

function matches(e: NostrEvent, x: Filter): boolean {
  const tag = (k: string, vs?: string[]) => !vs || e.tags.some((t) => t[0] === k && vs.includes(t[1]));
  return x.kinds.includes(e.kind) && (!x.authors || x.authors.includes(e.pubkey)) && tag('t', x['#t']) && tag('k', x['#k']) && tag('d', x['#d'])
    && (x.since === undefined || e.created_at >= x.since) && (x.until === undefined || e.created_at <= x.until);
}

async function restore() {
  const db = memoryDb();
  migrate(db);
  const asked: string[] = [];
  // the operator's three endpoints, and any server the fixture doesn't hold, can't be reached
  const query = async (relay: string, filters: Filter[]) => {
    asked.push(relay);
    const held = f.relays[relay];
    if (!held || operator.includes(relay)) throw new Error(`${relay} unreachable`);
    return held.filter((e) => filters.some((x) => matches(e, x))).sort((a, b) => b.created_at - a.created_at).slice(0, filters[0].limit ?? Infinity);
  };
  const fetch = (async (url: string) => {
    const u = new URL(url);
    const server = f.servers[u.origin];
    if (!server || operator.includes(u.origin)) throw new Error(`${u.origin} unreachable`);
    const b64 = server[u.pathname.slice(1)];
    return b64 ? new Response(base64.decode(b64) as unknown as BodyInit, { status: 200 }) : new Response('', { status: 404 });
  }) as unknown as typeof globalThis.fetch;
  const kept = new Map<string, string>();
  const defaults = () => pickDefaults({
    url: `${f.defaults.operator.api}/defaults.json`, baked: f.defaults, fetch, now: () => 1_000_000,
    read: () => kept.get('defaults') ?? null, write: (j) => kept.set('defaults', j),
  }, freshState());

  // the code screen's first pass, then what adopting the code does (services/identity.ts adoptRecovery)
  const signer = new LocalSigner(await secretKeyFromMnemonic(f.mnemonic, nodeCrypto));
  const pk = signer.pubkey();
  const found = await findLibrary({ query, defaults: await defaults() }, pk);
  ensureIdentityRow(db, 100, pk, 'recovery_code', true);
  queueRestore(db, 100, pk);
  beginRestore(db, 101, pk);

  const texts = new Map<string, string>();
  // the phone's clock as a phone's is: after the fixture's events (3 October 2026), since one dated more than a day
  // past it waits for its time
  const ports: SyncPorts = {
    db, now: () => 1_791_100_000, signer: async (k) => (k === pk ? signer : null), query, fetch, crypto: nodeCrypto, defaults,
    files: { writeText: (hash, md) => texts.set(hash, md), removeText: (hash) => texts.delete(hash), removeAll: (hash) => texts.delete(hash) },
  };
  const result = await syncInbound(ports);
  const state = settleRestore(db, 300, pk);
  const rows = db.all<{ hash: string; title: string; state: string }>('SELECT hash, title, state FROM items WHERE owner = ? ORDER BY hash', pk);
  return { db, pk, found, result, state, rows, texts, asked, defaultsUsed: await defaults() };
}

const byHash = <T extends { hash: string }>(xs: T[]) => [...xs].sort((a, b) => (a.hash < b.hash ? -1 : 1));
// the save whose text only a server in the 10063 holds (C§8's "or the user's 10063 list")
const ELSEWHERE = f.expected.saves.find((s) => s.title === 'Elsewhere')!;

describe('restore with the operator switched off (contract 8, 9)', () => {
  test('the baked defaults are used, the library is found, and every save comes back from the public relays', async () => {
    const r = await restore();
    expect(r.defaultsUsed).toEqual(f.defaults);
    expect(r.found).toBe('found');
    expect(r.pk).toBe(f.pubkey);
    // the newest copy of each save, less the one a kind 5 removed; a save from before v1.10 keeps its hash
    expect(r.rows).toEqual(byHash(f.expected.saves).map(({ hash, title, state }) => ({ hash, title, state })));
    for (const hash of f.expected.deleted) expect(r.rows.some((x) => x.hash === hash)).toBe(false);
    // the library key comes from its record, ready for the next publish (C§4.3)
    expect(r.db.get<{ library_key: string }>('SELECT library_key FROM identities WHERE pubkey = ?', r.pk)!.library_key).toBe(f.library_key);
    // the operator relay was asked and didn't answer; nothing came from it
    expect(r.asked).toContain(f.defaults.operator.relay);
  });

  test("the texts come from the mirror, the operator's server being off", async () => {
    const r = await restore();
    for (const s of f.expected.saves) {
      if (s.markdown === null || s === ELSEWHERE) continue;
      expect(r.texts.get(s.hash)).toBe(s.markdown);
    }
  });

  // F37: a newer 10063 adds the servers it names to the servers table, and the text fetch also asks the servers of
  // the newest 10063 held, so a server the defaults don't name is still asked.
  test("a text held only by a server the user's 10063 lists comes back too, and the restore finishes", async () => {
    const r = await restore();
    expect(r.texts.get(ELSEWHERE.hash)).toBe(ELSEWHERE.markdown);
    expect(r.state).toBe('done');
    expect(restoreOf(r.db, r.pk)).toMatchObject({ found: f.expected.saves.length, total: f.expected.saves.length });
  });
});
