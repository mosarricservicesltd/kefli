// GET /account on the phone (C§6, FD 117, FD 104; mobile spec 5.8): asked as Advanced opens, signed with NIP-98 by the
// library's own signer, its answer kept as the last the phone has; a not_registered answer forgets it, and anything
// else that goes wrong leaves it as it was.
import { LocalSigner, nobleSecp, verifyEventWith, type NostrEvent, type Signer } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { MB, accountFigures, recordFigures } from '../src/data/account';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { ACCOUNT_TIMEOUT_MS, checkAccount, type AccountPorts } from '../src/services/account';
import { memoryDb } from './sqlite';

const API = 'http://api';
const NOW = 1_760_000_000;
const ANSWER = { v: 1, quota: 50 * MB, used: Math.round(12.43 * MB), daily: 20 * MB, today: 1234 };

type Reply = { status: number; body: unknown } | (() => Promise<Response>);

function world(reply: Reply = { status: 200, body: ANSWER }, opts: { signer?: (s: Signer) => Signer | null } = {}) {
  const db = memoryDb();
  migrate(db);
  const own = new LocalSigner(nodeCrypto.randomBytes(32));
  ensureIdentityRow(db, NOW, own.pubkey(), 'new', true);
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (typeof reply === 'function') return reply();
    return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body), { status: reply.status });
  }) as unknown as typeof globalThis.fetch;
  const signer = opts.signer ? opts.signer(own) : own;
  const ports: AccountPorts = { db, now: () => NOW, owner: own.pubkey(), api: async () => API, signer: async () => signer, fetch, crypto: nodeCrypto };
  return { db, ports, calls, owner: own.pubkey() };
}

/** The kind 27235 in an Authorization header. */
const authEvent = (init: RequestInit) =>
  JSON.parse(Buffer.from(String((init.headers as Record<string, string>).Authorization).replace(/^Nostr /, ''), 'base64').toString('utf8')) as NostrEvent;

describe('GET /account (C§6)', () => {
  test('a GET to the API’s /account, signed with NIP-98 by the library’s own key, with no payload tag', async () => {
    const w = world();
    expect(await checkAccount(w.ports)).toBe('ok');
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0].url).toBe(`${API}/account`);
    expect(w.calls[0].init.method).toBe('GET');
    const e = authEvent(w.calls[0].init);
    expect(verifyEventWith(nobleSecp, e)).toBe(true);
    expect(e).toMatchObject({ kind: 27235, pubkey: w.owner, created_at: NOW, content: '' });
    expect(e.tags).toEqual([['u', `${API}/account`], ['method', 'GET']]);
  });

  test('its answer is kept as the last the phone has', async () => {
    const w = world();
    await checkAccount(w.ports);
    expect(accountFigures(w.db, w.owner)).toEqual({ quota: 50 * MB, used: ANSWER.used, daily: 20 * MB, today: 1234, at: NOW });
  });

  test('a not_registered answer forgets the figures held: Kefli’s server keeps nothing for this library', async () => {
    const w = world({ status: 403, body: { v: 1, error: 'not_registered' } });
    recordFigures(w.db, w.owner, ANSWER, 1);
    expect(await checkAccount(w.ports)).toBe('unregistered');
    expect(accountFigures(w.db, w.owner)).toBeNull();
  });

  test('any other refusal, a server error or a limit leaves the last answer as it was', async () => {
    for (const reply of [
      { status: 403, body: { v: 1, error: 'forbidden' } }, { status: 401, body: { v: 1, error: 'auth' } }, { status: 429, body: {} },
      { status: 500, body: { v: 1, error: 'server' } }, { status: 404, body: 'not found' },
    ]) {
      const w = world(reply);
      recordFigures(w.db, w.owner, ANSWER, 1);
      expect(await checkAccount(w.ports)).toBe('failed');
      expect(accountFigures(w.db, w.owner)).toMatchObject({ used: ANSWER.used, at: 1 });
    }
  });

  test('an answer that isn’t the figures, or is in a version this client doesn’t know, is a failed check', async () => {
    for (const body of ['not json', { v: 1 }, { ...ANSWER, v: 2 }, { ...ANSWER, used: -3 }, null]) {
      const w = world({ status: 200, body });
      expect(await checkAccount(w.ports)).toBe('failed');
      expect(accountFigures(w.db, w.owner)).toBeNull();
    }
  });

  test('an answer too long to be the figures is a failed check', async () => {
    const w = world({ status: 200, body: { ...ANSWER, pad: 'x'.repeat(5000) } });
    expect(await checkAccount(w.ports)).toBe('failed');
  });

  test('offline: a failed check, the last answer kept', async () => {
    const w = world(async () => {
      throw new TypeError('Network request failed');
    });
    recordFigures(w.db, w.owner, ANSWER, 1);
    expect(await checkAccount(w.ports)).toBe('failed');
    expect(accountFigures(w.db, w.owner)).toMatchObject({ at: 1 });
  });

  test('a signer app that won’t sign out of sight (FD 104) leaves the last answer, and nothing is sent', async () => {
    // a NIP-55 app asked out of sight that won't answer there throws with the code 'background'
    const declining = (s: Signer): Signer => ({
      pubkey: () => s.pubkey(),
      capabilities: () => s.capabilities(),
      signEvent: async () => {
        throw Object.assign(new Error('the signer app needs its screen'), { code: 'background' });
      },
      nip44Encrypt: (peer, text) => s.nip44Encrypt(peer, text),
      nip44Decrypt: (peer, text) => s.nip44Decrypt(peer, text),
    });
    const w = world(undefined, { signer: declining });
    recordFigures(w.db, w.owner, ANSWER, 1);
    expect(await checkAccount(w.ports)).toBe('failed');
    expect(w.calls).toHaveLength(0);
    expect(accountFigures(w.db, w.owner)).toMatchObject({ at: 1 });
  });

  test('no signer, or another library’s, asks nothing', async () => {
    for (const signer of [() => null, () => new LocalSigner(nodeCrypto.randomBytes(32))]) {
      const w = world(undefined, { signer });
      expect(await checkAccount(w.ports)).toBe('failed');
      expect(w.calls).toHaveLength(0);
    }
  });

  test('a server that doesn’t answer in time is a failed check', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    try {
      const w = world(() => new Promise<Response>(() => undefined));
      const run = checkAccount(w.ports);
      await jest.advanceTimersByTimeAsync(ACCOUNT_TIMEOUT_MS);
      expect(await run).toBe('failed');
    } finally {
      jest.useRealTimers();
    }
  });

  test('asks made while one is under way share it, and a later ask goes again', async () => {
    let release: (r: Response) => void = () => undefined;
    const w = world(() => new Promise<Response>((ok) => (release = ok)));
    const a = checkAccount(w.ports);
    const b = checkAccount(w.ports);
    await new Promise((r) => setImmediate(r));
    release(new Response(JSON.stringify(ANSWER), { status: 200 }));
    expect(await Promise.all([a, b])).toEqual(['ok', 'ok']);
    expect(w.calls).toHaveLength(1);
    const c = checkAccount(w.ports);
    await new Promise((r) => setImmediate(r));
    release(new Response(JSON.stringify(ANSWER), { status: 200 }));
    expect(await c).toBe('ok');
    expect(w.calls).toHaveLength(2);
  });
});
