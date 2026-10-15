import { LocalSigner, savedD, type NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { deleteEverything, deletePorts, deleteTargets, progressOf, type DelPorts, type Progress } from '../src/services/deleteAccount';
import type { RelayAnswer } from '../src/services/send';
import { SERVER_TIMEOUT_MS } from '../src/net/http';
import { memoryDb } from './sqlite';
import { inward, silent, watch, type Sends } from './inward';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('the Delete my data screen’s ports', () => {
  test('the ports read the relays through the pool, so saves only the relays hold are named (F32)', async () => {
    const asked: string[] = [];
    const e = { id: 'e' } as NostrEvent;
    const pool = {
      publish: async (url: string) => (asked.push(`publish ${url}`), { ok: true as const }),
      query: async (url: string) => (asked.push(`query ${url}`), [e]),
    };
    const db = memoryDb();
    const p = deletePorts({ db, signer: new LocalSigner(nodeCrypto.randomBytes(32)), defaults: D, crypto: nodeCrypto, fetch, pool, wipePhone: async () => undefined });
    expect(await p.query!('ws://a', [{ kinds: [30078] }])).toEqual([e]);
    expect(await p.publish('ws://b', e)).toEqual({ ok: true });
    expect(asked).toEqual(['query ws://a', 'publish ws://b']);
    expect(Math.abs(p.now() - Date.now() / 1000)).toBeLessThan(2);
  });

  test('signing reads the relays first, so the rows show waiting from the press, for a generated identity too', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'screens', 'Delete.tsx'), 'utf8');
    expect(src).toContain('deletePorts({');
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
import { settleUserLists } from '../src/services/nostrSignIn';
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

  /** A nostr user signed in with Keep backup copies on, their lists as their other apps wrote them, read whole (C§3.1). */
  async function signedIn(w: ReturnType<typeof world>, relays: string[][], servers: string[][], at = 500) {
    w.db.run('DELETE FROM relays');
    w.db.run('DELETE FROM servers');
    w.db.run("UPDATE identities SET provider = 'nip55'");
    const relayList = await w.p.signer.signEvent({ kind: 10002, created_at: at, tags: relays, content: '' });
    const serverList = await w.p.signer.signEvent({ kind: 10063, created_at: at, tags: servers, content: '' });
    settleUserLists(w.db, 90, w.pk, D, { relays: readRelayList(relayList), servers: readServerList(serverList), known: true, relayList, serverList }, true);
  }

  test('their lists are republished whole, past what Kefli uses of them, without Kefli’s relay, server and the defaults it added', async () => {
    const w = world();
    const relays = [
      ...Array.from({ length: 60 }, (_, i) => (i % 7 === 3 ? ['r', `wss://r${i}.example`, 'read'] : ['r', `wss://r${i}.example`])),
      ['r', 'wss://r60.example', 'outbox'], ['alt', 'relay list'],
    ];
    const servers = Array.from({ length: 55 }, (_, i) => ['server', `https://s${i}.example`]);
    // their list names Kefli's second default relay itself, which Kefli didn't add and which stays
    await signedIn(w, [...relays, ['r', 'ws://b', 'write']], servers);
    const signed = await signDeletion(w.p);
    const relayList = signed.lists.find((e) => e.kind === 10002)!;
    const serverList = signed.lists.find((e) => e.kind === 10063)!;
    expect(relayList.tags).toEqual([...relays, ['r', 'ws://b', 'write']]);
    expect(serverList.tags).toEqual(servers);
    // dated after the lists they replace, whatever this phone's clock says (C§3.1)
    expect([relayList.created_at, serverList.created_at]).toEqual([501, 501]);
  });

  test('the newest lists on the relays are read first, so what they added in another app since the last sync stays theirs', async () => {
    const w = world();
    await signedIn(w, [['r', 'wss://mine']], [['server', 'https://my.blossom']]);
    // since this phone last synced, they added a relay and a server in another app
    const newer = [
      await w.p.signer.signEvent({ kind: 10002, created_at: 900, tags: [['r', 'wss://mine'], ['r', 'wss://new.example', 'read']], content: '' }),
      await w.p.signer.signEvent({ kind: 10063, created_at: 900, tags: [['server', 'https://my.blossom'], ['server', 'https://new.blossom']], content: '' }),
    ];
    const asked: string[] = [];
    const p: DelPorts = {
      ...w.p,
      query: async (relay, filters) => {
        asked.push(relay);
        return filters[0].kinds.includes(10002) && relay === 'ws://idx' ? newer : [];
      },
    };
    const signed = await signDeletion(p);
    // rewritten from the list held, as it was, the new relay and server went from the lists their other apps share
    expect(signed.lists.find((e) => e.kind === 10002)!.tags).toEqual([['r', 'wss://mine'], ['r', 'wss://new.example', 'read']]);
    expect(signed.lists.find((e) => e.kind === 10063)!.tags).toEqual([['server', 'https://my.blossom'], ['server', 'https://new.blossom']]);
    expect(signed.lists.map((e) => e.created_at)).toEqual([901, 901]);
    // the relays they read from now are read for saves too
    expect(asked).toContain('wss://new.example');
    // a relay that doesn't answer the read stops nothing: the lists held are rewritten
    const quiet = world();
    await signedIn(quiet, [['r', 'wss://mine']], [['server', 'https://my.blossom']]);
    const down = await signDeletion({ ...quiet.p, query: async () => Promise.reject(new Error('down')) });
    expect(down.lists.map((e) => e.tags)).toEqual([[['r', 'wss://mine']], [['server', 'https://my.blossom']]]);
  });

  test('a relay holding a newer list from another app, or one that keeps no lists, is confirmed by its answers to the kind 5s alone', async () => {
    const w = world();
    w.db.run("UPDATE identities SET provider = 'nip55'");
    w.db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app) VALUES ('wss://mine', ?, 1, 0, 'user', 0)", w.pk);
    w.db.run("INSERT INTO servers (url, owner, role, in_10063, added_by_app) VALUES ('https://my.blossom', ?, 'user', 1, 0)", w.pk);
    const lists: string[] = [];
    const p: DelPorts = {
      ...w.p,
      publish: async (relay, e) => {
        if (e.kind !== 5) lists.push(`${relay} ${e.kind}`);
        // another app's 10002, newer than the rewrite signed before the deletion ran, reached this relay meanwhile
        if (relay === 'ws://a' && e.kind === 10002) return { ok: false, reason: 'replaced: have newer event' };
        if (relay === 'ws://b' && e.kind !== 5) return { ok: false, reason: 'blocked: lists are not kept here' };
        return w.p.publish(relay, e);
      },
    };
    let last: Progress | null = null;
    expect(await deleteEverything(p, (pr) => (last = pr))).toBe('done');
    expect(last!.others).toMatchObject({ 'ws://a': 'done', 'ws://b': 'done' });
    // and the other list still went to the relay that held a newer one of the first
    expect(lists).toEqual(expect.arrayContaining(['ws://a 10002', 'ws://a 10063', 'ws://b 10002', 'ws://b 10063']));
  });

  test('a list of theirs too long for one event is left as it is; the deletion and the other list go on', async () => {
    const w = world();
    const huge = Array.from({ length: 1000 }, (_, i) => ['r', `wss://relay-number-${i}.example`]);
    await signedIn(w, huge, [['server', 'https://my.blossom']]);
    const signed = await signDeletion(w.p);
    expect(signed.lists.map((e) => e.kind)).toEqual([10063]);
    expect(signed.lists[0].tags).toEqual([['server', 'https://my.blossom']]);
    expect(signed.items.length).toBeGreaterThan(0);
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

describe('Delete my data asks its servers through the hops, each within a deadline (7.1, 7.2)', () => {
  afterEach(() => jest.useRealTimers());

  test("the operator sending DELETE /account or a blob's deletion into the phone's network: nothing is asked there, and the step fails", async () => {
    const sendsOn: Sends[] = [(_m, url) => url.endsWith('/account'), (_m, url) => url.startsWith('http://blossom/')];
    for (const sends of sendsOn) {
      const w = world();
      const net = inward(w.p.fetch, sends);
      w.p.fetch = net.f;
      // followed as OkHttp followed it, the phone took whatever answers at 192.168.1.1 for the operator, and wiped itself
      expect(await deleteEverything(w.p, () => undefined)).toBe('failed');
      expect(net.asked).toEqual([]);
      expect(w.wiped()).toBe(false);
    }
  });

  test("the local stack's operator moving a blob's deletion to its other address on loopback: followed there, and only there", async () => {
    for (const localStack of [true, false]) {
      const w = world();
      // as the screen hands them over (screens/Delete.tsx), the build's word with them
      const ports = deletePorts({
        db: w.db, signer: w.p.signer, defaults: { ...D, operator: { ...D.operator, blossom: 'http://localhost:3447' } }, crypto: nodeCrypto,
        fetch: w.p.fetch, wipePhone: w.p.wipePhone, localStack,
        pool: { publish: w.p.publish, query: async () => [] },
      });
      const base = ports.fetch;
      ports.fetch = (async (url: string, init: RequestInit) => {
        const moved = /^http:\/\/localhost:3447\/([0-9a-f]{64})$/.exec(url);
        return moved ? new Response(null, { status: 307, headers: { location: `/v1/${moved[1]}` } }) : base(url, init);
      }) as typeof fetch;
      ports.sleep = async () => undefined;
      ports.budgetMs = 0;
      expect([localStack, await deleteEverything(ports, () => undefined)]).toEqual([localStack, localStack ? 'done' : 'failed']);
      expect([localStack, w.log.some((l) => l.startsWith('DELETE http://localhost:3447/v1/')), w.wiped()]).toEqual([localStack, localStack, localStack]);
    }
  });

  test('DELETE /account answered by any redirect, on any build, is the API not answering: the step fails and the phone keeps everything', async () => {
    // every call to the API is signed for its exact address (C§6), so it never answers through a redirect. Followed, a
    // 303 to any page that answers 200 read as the account deleted, and Delete my data went on to wipe the phone
    const answers: [number, string | null][] = [
      [303, 'https://news.example/'], [302, 'https://news.example/'], [301, '/v1/account'], [307, '/v1/account'], [308, 'http://api/v2/account'],
      [302, null], [300, null], [304, null],
    ];
    for (const localStack of [true, false]) {
      for (const [status, location] of answers) {
        const w = world();
        w.p.localStack = localStack;
        const base = w.p.fetch;
        const asked: string[] = [];
        w.p.fetch = (async (url: string, init: RequestInit = {}) => {
          asked.push(`${init.method ?? 'GET'} ${url}`);
          if (url === 'http://api/account') return new Response(null, { status, headers: location ? { location } : {} });
          return base(url, init);
        }) as typeof fetch;
        const named = [localStack, status, location];
        expect([...named, await deleteEverything(w.p, () => undefined)]).toEqual([...named, 'failed']);
        expect([...named, w.wiped(), progressOf(w.db)]).toEqual([...named, false, null]);
        // the operator's blob deletions and DELETE /account, tried within the minute; nothing a redirect names
        expect([...named, asked.filter((a) => !a.startsWith('DELETE http://blossom/') && a !== 'DELETE http://api/account')]).toEqual([...named, []]);
        expect([...named, asked.includes('DELETE http://api/account')]).toEqual([...named, true]);
      }
    }
  });

  test('an API that takes DELETE /account and never answers fails the step at its deadline, where it held the screen for good', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const w = world();
    const base = w.p.fetch;
    w.p.fetch = (async (url: string, init: RequestInit) => (url.endsWith('/account') ? silent(url, init) : base(url, init))) as typeof fetch;
    // one try, as the minute's last
    w.p.budgetMs = 0;
    const run = watch(deleteEverything(w.p, () => undefined));
    await jest.advanceTimersByTimeAsync(SERVER_TIMEOUT_MS - 1_000);
    expect(run.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(run).toMatchObject({ settled: true, value: 'failed' });
    expect(w.wiped()).toBe(false);
  });

  /** w's ports as the screen builds them (deletePorts), whose waits are timers and whose minute is the clock's. */
  const screenPorts = (w: ReturnType<typeof world>, fetch: typeof globalThis.fetch) => deletePorts({
    db: w.db, signer: w.p.signer, defaults: D, crypto: nodeCrypto, fetch, wipePhone: w.p.wipePhone,
    pool: { publish: w.p.publish, query: async () => [] },
  });

  test('an API that never answers DELETE /account holds the first step a minute at most, its tries counted with its waits', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const w = world();
    const base = w.p.fetch;
    let tries = 0;
    const ports = screenPorts(w, (async (url: string, init: RequestInit) => {
      if (!url.endsWith('/account')) return base(url, init);
      tries++;
      return silent(url, init);
    }) as typeof fetch);
    const run = watch(deleteEverything(ports, () => undefined));
    let ms = 0;
    while (!run.settled && 300_000 > ms) {
      await jest.advanceTimersByTimeAsync(1_000);
      ms += 1_000;
    }
    // the waits alone were counted: five tries of 15 s and 30 s of waits held the screen for 1 min 45 s
    expect(run).toMatchObject({ settled: true, value: 'failed' });
    expect(ms).toBeLessThanOrEqual(60_000);
    expect([tries, w.wiped()]).toEqual([3, false]);
  });

  test('an operator that fails at once is still tried through its minute, and one that answers by then is done', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const w = world();
    const base = w.p.fetch;
    const at: number[] = [];
    const t0 = Date.now();
    // the API unreachable for its first 20 s, then answering
    const ports = screenPorts(w, (async (url: string, init: RequestInit) => {
      if (!url.endsWith('/account')) return base(url, init);
      at.push(Date.now() - t0);
      if (Date.now() - t0 < 20_000) throw new Error('unreachable');
      return base(url, init);
    }) as typeof fetch);
    const run = watch(deleteEverything(ports, () => undefined));
    for (let s = 0; 120 > s && !run.settled; s++) await jest.advanceTimersByTimeAsync(1_000);
    expect(run).toMatchObject({ settled: true, value: 'done' });
    expect(at).toEqual([0, 2_000, 6_000, 14_000, 30_000]);
  });

  test("the phone's clock set back or forward while the first step runs neither stretches nor cuts its minute", async () => {
    // the minute was read from the wall clock: set back an hour during the first try, as a network's time can set a phone
    // whose clock was wrong, a never-answering API held the screen, which swallows Back, for 37 minutes of eleven tries
    for (const step of [-3_600_000, 3_600_000]) {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
      const w = world();
      const base = w.p.fetch;
      let tries = 0;
      const ports = screenPorts(w, (async (url: string, init: RequestInit) => {
        if (!url.endsWith('/account')) return base(url, init);
        if (++tries === 1) jest.setSystemTime(Date.now() + step);
        return silent(url, init);
      }) as typeof fetch);
      const run = watch(deleteEverything(ports, () => undefined));
      let ms = 0;
      while (!run.settled && 7_200_000 > ms) {
        await jest.advanceTimersByTimeAsync(1_000);
        ms += 1_000;
      }
      expect([step, run, ms, tries, w.wiped()]).toEqual([step, expect.objectContaining({ settled: true, value: 'failed' }), 51_000, 3, false]);
      jest.useRealTimers();
    }
  });

  test("a mirror that never answers a deletion is let go at its deadline: it isn't confirmed, and the phone is wiped all the same", async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const w = world();
    const base = w.p.fetch;
    w.p.fetch = (async (url: string, init: RequestInit) => (url.startsWith('http://m1/') ? silent(url, init) : base(url, init))) as typeof fetch;
    w.p.budgetMs = 0;
    const run = watch(deleteEverything(w.p, () => undefined));
    await jest.advanceTimersByTimeAsync(SERVER_TIMEOUT_MS + 1_000);
    expect(run).toMatchObject({ settled: true, value: 'partial' });
    expect(w.wiped()).toBe(true);
  });
});
