// A server's address loses its trailing slashes before a path is joined to it, counted back from the end
// (withoutTrailingSlashes): the pattern /\/+$/ was tried from every slash of a run that something else follows, so a
// long run of them before a letter, in a defaults.json operator address, a save's text.servers or a 10063 entry, took
// seconds a call (6 to 7 s for 40,000 on the phone's engine, 0.6 s on Node's, and 25 times that for 200,000).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalSigner, encryptText } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { enqueue } from '../src/data/outbox';
import { TEXT_SERVERS_MAX, blobServers } from '../src/data/sync';
import { readBlob } from '../src/services/inbox';
import { stagedBlob, type MovePorts } from '../src/services/move';
import { sendOne, type SendPorts } from '../src/services/send';
import { memoryDb } from './sqlite';

/** 200,000 slashes and then a letter, after a host: nothing at its end to take off, and every slash to try. */
const LONG = `https://b.example${'/'.repeat(200_000)}x`;
const SHA = 'ab'.repeat(32);

/** The CPU time this process spends on f, in ms: other work on a loaded machine adds nothing to it, as it would to a clock's. */
async function cpuMs(f: () => Promise<unknown>): Promise<number> {
  const start = process.cpuUsage();
  await f();
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}

/** A fetch that records each address asked and answers what answer gives. */
function recording(answer: (url: string, init: RequestInit) => Response) {
  const asked: string[] = [];
  const f = (async (url: string, init: RequestInit = {}) => (asked.push(url), answer(url, init))) as unknown as typeof fetch;
  return { f, asked };
}

describe("a server's address loses its trailing slashes in linear time, however many it holds before them", () => {
  test("the inbox blob's server", async () => {
    const enc = await encryptText('<p>x</p>', nodeCrypto);
    const net = recording(() => new Response('', { status: 404 }));
    const ms = await cpuMs(() => readBlob({ fetch: net.f, crypto: nodeCrypto }, { ...enc.text, server: `${LONG}///` }));
    expect(net.asked).toEqual([`${LONG}/${enc.text.sha256}`]);
    expect(ms).toBeLessThan(2_000);
  });

  test("the operator's address a mirror copies the text from", async () => {
    const db = memoryDb();
    migrate(db);
    const signer = new LocalSigner(nodeCrypto.randomBytes(32));
    ensureIdentityRow(db, 1, signer.pubkey(), 'new', true);
    enqueue(db, 1, { op: 'mirror_blob', signer: signer.pubkey(), subject: SHA, payload: { sha256: SHA }, targets: ['https://mirror.example'] });
    const net = recording((_url, init) => new Response(JSON.stringify({ sha256: SHA, from: JSON.parse(String(init.body)).url })));
    const sources: string[] = [];
    const p: SendPorts = {
      db, now: () => 1, signer: async () => signer, crypto: nodeCrypto, readBlob: async () => null, publish: async () => ({ ok: true }),
      fetch: (async (url: string, init: RequestInit) => (sources.push(String(JSON.parse(String(init.body)).url)), net.f(url, init))) as typeof fetch,
      defaults: () => ({ v: 1, operator: { relay: 'wss://op.example', blossom: `${LONG}//`, api: 'https://api.example' }, relays: ['wss://a.example', 'wss://b.example'], indexer: ['wss://i.example'], mirrors: ['https://mirror.example'] }),
    };
    const ms = await cpuMs(() => sendOne(p));
    expect(sources).toEqual([`${LONG}/${SHA}`]);
    expect(ms).toBeLessThan(2_000);
  });

  test("the servers a move fetches S's text from", async () => {
    const db = memoryDb();
    migrate(db);
    const from = 'cd'.repeat(32);
    ensureIdentityRow(db, 1, from, 'new', true);
    db.run(`INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, text_sha256, text_servers)
      VALUES (?, ?, 'https://e.com/a', 1, 'unread', 'remote', 'sync', ?, ?)`, from, '01'.repeat(32), SHA, JSON.stringify([`${LONG}/`]));
    const net = recording(() => new Response('', { status: 404 }));
    const p = {
      db, fetch: net.f, crypto: nodeCrypto, readStaged: async () => null, stage: () => '/staged',
      defaults: async () => ({ operator: { relay: 'wss://op.example', blossom: 'https://blossom.example', api: 'https://api.example' }, mirrors: ['https://m.example'] }),
    } as unknown as MovePorts;
    let got: unknown;
    const ms = await cpuMs(async () => (got = await stagedBlob(p, from, '01'.repeat(32))));
    expect(got).toBe('missing');
    expect(net.asked).toEqual([`${LONG}/${SHA}`, `https://blossom.example/${SHA}`]);
    expect(ms).toBeLessThan(2_000);
  });

  test("the blob servers a save's text names, as a sync reads them, are given to no pattern but the check of their form", () => {
    // a server's address is at most 2,048 characters (isServerUrl); these are nearly all a run of slashes before a
    // letter, and end in two more. Counted, not timed: every pattern runs through exec, and each address may be given
    // to the one that checks its form, once. The trim's pattern was given each as well, and tried from every slash
    const run = `https://b.example${'/'.repeat(2_000)}x`;
    const servers = Array.from({ length: TEXT_SERVERS_MAX }, (_, i) => `${run}${i}//`);
    const exec = jest.spyOn(RegExp.prototype, 'exec');
    let kept: string[] = [];
    let given: number[] = [];
    try {
      kept = blobServers(servers);
      given = exec.mock.calls.map(([s]) => String(s).length);
    } finally {
      exec.mockRestore();
    }
    expect(kept).toEqual(servers.map((s) => s.slice(0, -2)));
    expect(given.filter((n) => n >= 2_000)).toHaveLength(servers.length);
  });

  test("no server's address in the phone's calls to servers is trimmed by the pattern that backtracks", () => {
    // what the move's HEAD and S's DELETE /account, Delete my data's DELETE /account and the rest join a path to, and
    // the blob servers a sync reads a text from
    for (const file of ['services/send.ts', 'services/move.ts', 'services/inbox.ts', 'services/deleteAccount.ts', 'data/sync.ts']) {
      const src = readFileSync(join(__dirname, '..', 'src', file), 'utf8');
      expect([file, src.includes('replace(/\\/+$/')]).toEqual([file, false]);
    }
  });
});
