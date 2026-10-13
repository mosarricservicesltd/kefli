import { LocalSigner, savedD, type NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { deleteEverything, deleteTargets, progressOf, type DelPorts, type Progress } from '../src/services/deleteAccount';
import type { RelayAnswer } from '../src/services/send';
import { memoryDb } from './sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('the Delete my data screen’s ports', () => {
  test('the screen passes the relay read, so saves only the relays hold are named (F32)', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'screens', 'Delete.tsx'), 'utf8');
    const at = src.indexOf('const ports: DelPorts = {');
    expect(src.slice(at, src.indexOf('};', at))).toContain('query: (url, filters) => pool.query(url, filters as never)');
    // signing reads the relays first: the rows show waiting from the press, for a generated identity too
    expect(src).toContain("setPhase(nostr ? 'approve' : 'running');");
  });
});

const D = { operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' }, relays: ['ws://a', 'ws://b'], indexer: ['ws://idx'], mirrors: ['http://m1'] };
const h = (n: number) => n.toString(16).padStart(64, '0');

function world(o: { down?: Set<string>; refuse?: Set<string>; accountStatus?: number } = {}) {
  const db = memoryDb();
  migrate(db);
  const signer = new LocalSigner(nodeCrypto.randomBytes(32));
  const pk = signer.pubkey();
  ensureIdentityRow(db, 1, pk, 'new', true);
  seedGeneratedLists(db, pk, D);
  // published before v1.10, at their unkeyed addresses (F5)
  for (const n of [1, 2]) {
    db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, text_sha256, text_servers, remote_d) VALUES (?, ?, ?, 1, 'unread', 'cached', 'share', ?, ?, ?)",
      pk, h(n), `https://e.com/${n}`, h(100 + n), JSON.stringify(['http://blossom', 'http://m1']), `kefli/item/${h(n)}`);
  }
  db.run("INSERT INTO inbox_seen (wrap_id, owner, seen_at, outcome) VALUES (?, ?, 1, 'created')", h(500), pk);
  const log: string[] = [];
  const sent: { relay: string; event: NostrEvent }[] = [];
  let wiped = false;
  const p: DelPorts = {
    db, now: () => 100, signer, defaults: D, crypto: nodeCrypto, sleep: async () => undefined, budgetMs: 10_000,
    publish: async (relay, event): Promise<RelayAnswer> => {
      if (o.down?.has(relay)) throw new Error('down');
      sent.push({ relay, event });
      log.push(`publish ${relay} ${event.kind}`);
      return o.refuse?.has(relay) ? { ok: false, reason: 'blocked: no' } : { ok: true };
    },
    fetch: (async (url: string, init: RequestInit) => {
      const host = new URL(url).origin;
      if (o.down?.has(host)) throw new Error('down');
      log.push(`${init.method} ${url}`);
      if (url.endsWith('/account')) return new Response('{}', { status: o.accountStatus ?? 200 });
      return new Response('{}', { status: 200 });
    }) as never,
    wipePhone: async () => {
      wiped = true;
      log.push('wipe');
    },
  };
  return { db, pk, p, log, sent, wiped: () => wiped };
}

describe('Delete my data (mobile spec 7.2, contract 4.7)', () => {
  test('the targets are the other write relays and the other servers holding text', () => {
    const w = world();
    expect(deleteTargets(w.db, w.pk, D.operator).map((t) => `${t.kind} ${t.host}`)).toEqual(['relay a', 'relay b', 'server m1']);
  });

  test('the operator first, DELETE /account last of its step, then every other server, then the phone', async () => {
    const w = world();
    const seen: Progress[] = [];
    expect(await deleteEverything(w.p, (pr) => seen.push(pr))).toBe('done');
    const i = (s: string) => w.log.findIndex((l) => l.startsWith(s));
    expect(i('publish ws://op 5')).toBeLessThan(i('DELETE http://blossom/'));
    expect(i('DELETE http://blossom/')).toBeLessThan(i('DELETE http://api/account'));
    expect(i('DELETE http://api/account')).toBeLessThan(i('publish ws://a 5'));
    expect(i('DELETE http://m1/')).toBeGreaterThan(i('DELETE http://api/account'));
    expect(w.log.at(-1)).toBe('wipe');
    // the wrap's deletion and the saves' (the operator relay is in the 10002), with the devices record among them
    const op = w.sent.filter((s) => s.relay === 'ws://op').map((s) => s.event.tags);
    expect(op.some((t) => t.some((x) => x[0] === 'e' && x[1] === h(500)))).toBe(true);
    expect(op.flat().filter((x) => x[0] === 'a').map((x) => x[1].split(':')[2])).toEqual(expect.arrayContaining([`kefli/item/${h(1)}`, 'kefli/devices']));
    // the generated identity's lists go from every relay in the 10002, the operator's included, and the indexer
    expect(w.sent.some((s) => s.relay === 'ws://op' && s.event.tags.some((t) => t[1] === `10063:${w.pk}:`))).toBe(true);
    // then emptied a second later on each of them; the indexer, which refuses kind 5, gets the empty lists alone
    for (const relay of ['ws://op', 'ws://a', 'ws://b', 'ws://idx']) {
      const empties = w.sent.filter((s) => s.relay === relay && s.event.kind !== 5).map((s) => s.event);
      expect(empties.map((e) => [e.kind, e.tags.length, e.created_at]).sort()).toEqual([[10002, 0, 101], [10063, 0, 101]]);
    }
    expect(w.sent.some((s) => s.relay === 'ws://idx' && s.event.kind === 5)).toBe(false);
    expect(seen.at(-1)).toEqual({ operator: 'done', others: { 'ws://a': 'done', 'ws://b': 'done', 'http://m1': 'done' }, phone: 'done' });
  });

  test('a save only ever at its keyed address is deleted there, and its plain hash is never published (F5)', async () => {
    const w = world();
    const key = new Uint8Array(32).fill(9);
    w.db.run('UPDATE identities SET library_key = ?, library_key_at = 1 WHERE pubkey = ?', '09'.repeat(32), w.pk);
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, remote_d) VALUES (?, ?, 'https://e.com/3', 1, 'unread', 'failed', 'share', ?)",
      w.pk, h(3), savedD(key, h(3)));
    expect(await deleteEverything(w.p, () => undefined)).toBe('done');
    const named = w.sent.flatMap((s) => s.event.tags).filter((t) => t[0] === 'a').map((t) => t[1].split(':')[2]);
    expect(named).toContain(savedD(key, h(3)));
    expect(named).not.toContain(`kefli/item/${h(3)}`);
    // the saves from before v1.10 are named at the unkeyed addresses they were at, and at their keyed ones
    expect(named).toEqual(expect.arrayContaining([`kefli/item/${h(1)}`, savedD(key, h(1)), 'kefli/library-key']));
  });

  test('the operator unreachable, or refusing DELETE /account: nothing else runs and the key stays', async () => {
    const w = world({ down: new Set(['ws://op']) });
    expect(await deleteEverything(w.p, () => undefined)).toBe('failed');
    expect(w.wiped()).toBe(false);
    expect(w.log.some((l) => l.includes('ws://a') || l.includes('/account'))).toBe(false);
    expect(progressOf(w.db)).toBeNull();
    const r = world({ accountStatus: 500 });
    expect(await deleteEverything(r.p, () => undefined)).toBe('failed');
    expect(r.wiped()).toBe(false);
  });

  test("a server that doesn't confirm is named; the phone is wiped all the same", async () => {
    const w = world({ refuse: new Set(['ws://b']), down: new Set(['http://m1']) });
    let last: Progress | null = null;
    expect(await deleteEverything(w.p, (pr) => (last = pr))).toBe('partial');
    expect(last!.others).toEqual({ 'ws://a': 'done', 'ws://b': 'fail', 'http://m1': 'fail' });
    expect(w.wiped()).toBe(true);
  });

  test('cut short after the operator, it resumes without asking the operator again', async () => {
    const w = world();
    w.db.run("INSERT INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES ('delete_account', 'delete_account', 'running', 0, ?, 1, 1)",
      JSON.stringify({ operator: 'done', others: { 'ws://a': 'done', 'ws://b': 'wait', 'http://m1': 'wait' }, phone: 'wait' }));
    expect(await deleteEverything(w.p, () => undefined)).toBe('done');
    expect(w.log.some((l) => l.includes('ws://op') || l.includes('/account') || l.includes('ws://a'))).toBe(false);
    expect(w.log).toContain('wipe');
  });
});

import { S, listOf } from '../src/ui/strings';

describe('the deletion’s words', () => {
  test('servers are counted and listed as a sentence says them', () => {
    expect(listOf([])).toBe('');
    expect(listOf(['a.org'])).toBe('a.org');
    expect(listOf(['a.org', 'b.org', 'c.org'])).toBe('a.org, b.org and c.org');
    expect(S.del.backups(1)).toBe('Copies on one independent backup server');
    expect(S.del.backups(3)).toBe('Copies on three independent backup servers');
    expect(S.del.partialLine(['a.org', 'b.org'])).toMatch(/^a\.org and b\.org didn’t confirm/);
  });
});

describe('the lists’ deletion', () => {
  test('names the list events by id as well as by address', async () => {
    const w = world();
    w.db.run("INSERT INTO lists (owner, kind, d, event_id, created_at, raw) VALUES (?, 10002, '', ?, 1, NULL)", w.pk, 'ee'.repeat(32));
    await deleteEverything(w.p, () => undefined);
    const ev = w.sent.find((s) => s.relay === 'ws://a' && s.event.tags.some((t) => t[1] === `10002:${w.pk}:`))!.event;
    expect(ev.tags).toContainEqual(['e', 'ee'.repeat(32)]);
    expect(ev.tags).toContainEqual(['a', `10002:${w.pk}:`]);
  });
});

describe('Advanced’s words', () => {
  test('a relay not answering, or several', () => {
    expect(S.adv.willReach(['a.org'])).toBe('Saves will reach a.org when it answers again.');
    expect(S.adv.willReach(['a.org', 'b.org'])).toBe('Saves will reach a.org and b.org when they answer again.');
    expect(S.adv.notBacked(1)).toBe('One save isn’t backed up yet. Kefli keeps trying until a backup server accepts it.');
    expect(S.adv.notBacked(3)).toMatch(/^Three saves aren’t backed up yet/);
    expect(S.adv.copied(true, 2)).toMatch(/^Your other saves are copied to both\./);
  });
});

describe('a nostr user’s lists', () => {
  test('are never deleted', async () => {
    const w = world();
    w.db.run("UPDATE identities SET provider = 'nip55'");
    await deleteEverything(w.p, () => undefined);
    expect(w.sent.some((s) => s.event.tags.some((t) => t[1] === `10002:${w.pk}:`))).toBe(false);
    expect(w.sent.some((s) => s.relay === 'ws://idx')).toBe(false);
  });
});

import { signDeletion } from '../src/services/deleteAccount';
import { readRelayList, readServerList } from '@kefli/protocol';

describe('a nostr user’s deletion (contract 4.7)', () => {
  test('their lists are republished without Kefli’s entries', async () => {
    const w = world();
    w.db.run("UPDATE identities SET provider = 'nip55'");
    w.db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app) VALUES ('wss://mine', ?, 1, 0, 'user', 0)", w.pk);
    w.db.run("INSERT INTO servers (url, owner, role, in_10063, added_by_app) VALUES ('https://my.blossom', ?, 'user', 1, 0)", w.pk);
    await deleteEverything(w.p, () => undefined);
    const lists = w.sent.filter((s) => s.relay === 'ws://idx').map((s) => s.event);
    expect(lists.map((e) => e.kind).sort()).toEqual([10002, 10063]);
    expect(readRelayList(lists.find((e) => e.kind === 10002)!)).toEqual([{ url: 'wss://mine', read: true, write: false }]);
    expect(readServerList(lists.find((e) => e.kind === 10063)!)).toEqual(['https://my.blossom']);
    expect(w.sent.some((s) => s.event.kind === 5 && s.event.tags.some((t) => t[1]?.startsWith('10002:')))).toBe(false);
  });

  test('declined in their app, nothing is sent and nothing deleted', async () => {
    const w = world();
    w.db.run("UPDATE identities SET provider = 'nip55'");
    const declining = { ...w.p, signer: { pubkey: () => w.pk, signEvent: async () => { throw Object.assign(new Error('rejected'), { code: 'rejected' }); } } as never };
    await expect(signDeletion(declining)).rejects.toThrow('rejected');
    await expect(deleteEverything(declining, () => undefined)).rejects.toThrow('rejected');
    expect(w.sent).toEqual([]);
    expect(w.log).toEqual([]);
    expect(w.wiped()).toBe(false);
  });
});

import { buildItemEvent } from '@kefli/protocol';
import { commitDelete, deleteItem } from '../src/data/library';
import { enqueue } from '../src/data/outbox';

/** A save another device made, which this phone hasn't synced: only the relays hold it. */
async function elsewhere(w: ReturnType<typeof world>, n: number, createdAt: number) {
  const key = new Uint8Array(32).fill(9);
  const text = { sha256: h(700 + n), key: 'AA==', nonce: 'AA==', servers: ['http://blossom', 'http://m1'] };
  const item = {
    v: 1 as const, url: `https://e.com/${n}`, canonical: null, title: 'T', site: 'e.com', byline: null, saved_at: 1, state: 'unread' as const,
    progress: 0, words: 1, lang: 'en', text, text_hash: h(800 + n), hero: null, source_kind: 'web' as const, audio_pref: null,
  };
  return (await buildItemEvent(w.p.signer, h(n), { item, extra: {} }, createdAt, key)).event;
}

const named = (w: ReturnType<typeof world>, relay: string) =>
  w.sent.filter((s) => s.relay === relay && s.event.kind === 5).flatMap((s) => s.event.tags).filter((t) => t[0] === 'a').map((t) => t[1].split(':')[2]);

describe('Delete my data covers every save (contract 4.7, F32)', () => {
  test('a save only the relays hold gets its kind 5, dated past it, and its text goes from the mirror', async () => {
    const w = world();
    const theirs = await elsewhere(w, 9, 500);
    const p: DelPorts = { ...w.p, query: async (relay) => (relay === 'ws://b' ? [theirs] : []) };
    expect(await deleteEverything(p, () => undefined, await signDeletion(p))).toBe('done');
    const d = theirs.tags.find((t) => t[0] === 'd')![1];
    for (const relay of ['ws://op', 'ws://a', 'ws://b']) expect(named(w, relay)).toContain(d);
    expect(w.sent.filter((s) => s.event.kind === 5 && s.event.tags.some((t) => t[1]?.endsWith(d))).every((s) => s.event.created_at > 500)).toBe(true);
    expect(w.log).toContain(`DELETE http://m1/${h(709)}`);
  });

  test('a relay that doesn’t answer the read adds nothing and stops nothing', async () => {
    const w = world();
    const p: DelPorts = { ...w.p, query: async () => Promise.reject(new Error('down')) };
    expect(await deleteEverything(p, () => undefined, await signDeletion(p))).toBe('done');
    expect(named(w, 'ws://a')).toEqual(expect.arrayContaining([`kefli/item/${h(1)}`, 'kefli/devices']));
  });

  test('a save deleted here whose kind 5 and blob delete never went out is still deleted', async () => {
    const w = world();
    w.db.run('UPDATE identities SET library_key = ?, library_key_at = 1 WHERE pubkey = ?', '09'.repeat(32), w.pk);
    w.db.run("INSERT INTO blobs (sha256, hash, kind, owner, operator_at) VALUES (?, ?, 'text', ?, 1)", h(102), h(2), w.pk);
    // the delete's toast closed, then the relays were down, so its kind 5 and blob delete stayed queued
    const del = deleteItem(w.db, 50, w.pk, h(2));
    commitDelete(w.db, w.pk, h(2), del.held);
    expect(w.db.get('SELECT 1 FROM items WHERE hash = ?', h(2))).toBeUndefined();
    expect(await deleteEverything(w.p, () => undefined)).toBe('done');
    expect(named(w, 'ws://a')).toEqual(expect.arrayContaining([`kefli/item/${h(2)}`, savedD(new Uint8Array(32).fill(9), h(2))]));
    expect(w.log).toContain(`DELETE http://m1/${h(102)}`);
  });

  test('a never-published save deleted here is named nowhere in public with no key (F5)', async () => {
    const w = world();
    w.db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'https://e.com/4', 1, 'unread', 'queued', 'share')", w.pk, h(4));
    const del = deleteItem(w.db, 50, w.pk, h(4));
    commitDelete(w.db, w.pk, h(4), del.held);
    expect(await deleteEverything(w.p, () => undefined)).toBe('done');
    expect(w.sent.flatMap((s) => s.event.tags).some((t) => t[1]?.includes(h(4)))).toBe(false);
  });

  test('the counted servers are those a save’s text names, not a nostr user’s own in their 10063', () => {
    const w = world();
    w.db.run("UPDATE identities SET provider = 'nip55'");
    w.db.run("INSERT INTO servers (url, owner, role, in_10063, added_by_app) VALUES ('https://my.blossom', ?, 'user', 1, 0)", w.pk);
    expect(deleteTargets(w.db, w.pk, D.operator).map((t) => `${t.kind} ${t.host}`)).toEqual(['relay a', 'relay b', 'server m1']);
  });

  test('a nostr user who listed Kefli’s relay and server themselves gets lists without them', async () => {
    const w = world();
    w.db.run("UPDATE identities SET provider = 'nip55'");
    // read back from their own 10002 and 10063 at a later sign-in, so marked as theirs
    w.db.run("UPDATE relays SET source = 'user', added_by_app = 0 WHERE owner = ? AND url = 'ws://op'", w.pk);
    w.db.run("UPDATE servers SET role = 'user', added_by_app = 0, in_10063 = 1 WHERE owner = ? AND url = 'http://blossom'", w.pk);
    w.db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app) VALUES ('wss://mine', ?, 1, 1, 'user', 0)", w.pk);
    w.db.run("INSERT INTO servers (url, owner, role, in_10063, added_by_app) VALUES ('https://my.blossom', ?, 'user', 1, 0)", w.pk);
    const signed = await signDeletion(w.p);
    expect(readRelayList(signed.lists.find((e) => e.kind === 10002)!).map((r) => r.url)).toEqual(['wss://mine']);
    expect(readServerList(signed.lists.find((e) => e.kind === 10063)!)).toEqual(['https://my.blossom']);
  });

  test('a delete left queued or given up on joins the kind 5s, dated past the save it names', async () => {
    const w = world();
    enqueue(w.db, 1, { op: 'delete_item', signer: w.pk, subject: h(6), payload: { ds: [`kefli/item/${h(6)}`], hash: h(6), after: 900 }, targets: ['ws://a'] });
    w.db.run("UPDATE outbox SET state = 'dead' WHERE subject = ?", h(6));
    const signed = await signDeletion(w.p);
    expect(signed.items.flatMap((e) => e.tags).map((t) => t[1])).toContain(`30078:${w.pk}:kefli/item/${h(6)}`);
    expect(signed.items.every((e) => e.created_at > 900)).toBe(true);
  });
});
