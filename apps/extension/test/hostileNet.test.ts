// What Kefli's own servers, or a phone with a bug, could send that would hang, exhaust or break the extension: an
// operator that takes a request and never answers, an answer that never ends, and lists that aren't lists of addresses.
import { hexToBytes } from '@noble/hashes/utils.js';
import type { PairAck } from '../../../packages/protocol/src/pairing';
import type { CryptoPort } from '../../../packages/protocol/src/ports';
import { LocalSigner } from '../../../packages/protocol/src/signer';
import { webCrypto } from '../src/crypto';
import { DEFAULTS_LIST_MAX, loadDefaults, relayRows, type Defaults } from '../src/defaults';
import { applyMove } from '../src/move';
import { newOffer, pairingFrom, postOffer } from '../src/pair';
import { ANSWER_MAX_BYTES, fetchNet } from '../src/save';
import { ADDRESS_MAX, KEYS, LIST_MAX, memoryStore, type Pairing } from '../src/store';

const DEFAULTS: Defaults = { v: 1, operator: { relay: 'wss://relay.example', blossom: 'https://blossom.example', api: 'https://api.example' }, relays: ['wss://a.example', 'wss://b.example'], mirrors: ['https://m.example'] };
const NOW = 1_791_600_000;
const user = new LocalSigner(hexToBytes('11'.repeat(32)));
const device = new LocalSigner(hexToBytes('22'.repeat(32)));
const PAIRING: Pairing = { v: 1, user_pubkey: user.pubkey(), write_relays: ['wss://relay.example'], blossom_servers: ['https://blossom.example'], token: 'ab'.repeat(32), label: 'Chrome on a Mac', paired_at: NOW };

/** A server that takes the request and never answers, until the caller's signal gives up on it. */
const never = ((_u: string, init?: RequestInit) =>
  new Promise((_ok, fail) => init?.signal?.addEventListener('abort', () => fail(init.signal!.reason)))) as unknown as typeof fetch;

/** A 200 whose body never ends, a megabyte at a time, counting how much of it was read. */
function endless(headers: Record<string, string> = {}) {
  const read = { mb: 0 };
  const get = (async () =>
    new Response(new ReadableStream({ pull: (c) => void (read.mb++, c.enqueue(new Uint8Array(1 << 20).fill(0x20))) }), { status: 200, headers })) as unknown as typeof fetch;
  return { get, read };
}

const json = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

/**
 * The browser's crypto with a code key that costs nothing to derive, for the tests that time a post to the operator. The
 * post derives the typed code's key first, scrypt in pure JS: a fifth of a second alone, and over five seconds on a
 * loaded machine under coverage, which counted against the post's time limit and Jest's.
 */
const quickKey: CryptoPort = { ...webCrypto, scrypt: async (_password, _salt, _cost, length) => new Uint8Array(length) };

/** How long a promise took to end, in ms, and whether it rejected. */
async function timed(p: Promise<unknown>): Promise<{ ms: number; rejected: boolean; value: unknown }> {
  const t = Date.now();
  try {
    return { value: await p, rejected: false, ms: Date.now() - t };
  } catch (e) {
    return { value: e, rejected: true, ms: Date.now() - t };
  }
}

describe('defaults.json from an operator that misbehaves', () => {
  test('one that takes the request and never answers gives way to the kept copy, in time', async () => {
    const store = memoryStore();
    await store.set(KEYS.defaults, DEFAULTS);
    const r = await timed(loadDefaults(store, 'https://kefli.example/defaults.json', never, 50));
    expect(r).toMatchObject({ rejected: false, value: DEFAULTS });
    expect(r.ms).toBeLessThan(5000);
  });

  test('one whose fetch pays the time limit no heed is given up on all the same', async () => {
    const deaf = (() => new Promise(() => undefined)) as unknown as typeof fetch;
    const store = memoryStore();
    await store.set(KEYS.defaults, DEFAULTS);
    expect(await timed(loadDefaults(store, 'u', deaf, 50))).toMatchObject({ rejected: false, value: DEFAULTS });
    const o = await newOffer(device, DEFAULTS, 'Chrome on a Mac', webCrypto, NOW);
    expect(await timed(postOffer(device, DEFAULTS, o, quickKey, deaf, 50))).toMatchObject({ rejected: true });
  });

  test('an answer that never ends is cut off as it is read, and the kept copy stands in', async () => {
    const store = memoryStore();
    await store.set(KEYS.defaults, DEFAULTS);
    const e = endless();
    expect(await loadDefaults(store, 'u', e.get, 2000)).toEqual(DEFAULTS);
    expect(e.read.mb).toBeLessThan(4);
    // and one that says how long it is goes unread
    const declared = endless({ 'content-length': String(ANSWER_MAX_BYTES * 1000) });
    expect(await loadDefaults(store, 'u', declared.get, 2000)).toEqual(DEFAULTS);
    expect(declared.read.mb).toBeLessThan(2);
  });

  test.each([
    ['relays that aren’t a list', { ...DEFAULTS, relays: 5 }],
    ['relays that aren’t addresses', { ...DEFAULTS, relays: [1, { url: 'wss://x' }] }],
    ['mirrors missing', { ...DEFAULTS, mirrors: undefined }],
    ['an operator relay that isn’t a relay', { ...DEFAULTS, operator: { ...DEFAULTS.operator, relay: 'javascript:alert(1)' } }],
    ['an operator API that isn’t an address', { ...DEFAULTS, operator: { ...DEFAULTS.operator, api: { evil: 1 } } }],
    ['an address longer than any real one', { ...DEFAULTS, operator: { ...DEFAULTS.operator, blossom: `https://b.example/${'x'.repeat(ADDRESS_MAX)}` } }],
    ['more relays than an operator lists', { ...DEFAULTS, relays: Array.from({ length: DEFAULTS_LIST_MAX + 1 }, (_, i) => `wss://r${i}.example`) }],
    ['200,000 relays', { ...DEFAULTS, relays: Array.from({ length: 200_000 }, (_, i) => `wss://r${i}.example`) }],
  ])('a copy with %s is refused, and the kept copy stays', async (_name, bad) => {
    const store = memoryStore();
    await store.set(KEYS.defaults, DEFAULTS);
    expect(await loadDefaults(store, 'u', json(bad))).toEqual(DEFAULTS);
    expect(store.data.get(KEYS.defaults)).toEqual(DEFAULTS);
  });

  test('a copy within the limits is taken', async () => {
    const store = memoryStore();
    const more = { ...DEFAULTS, relays: Array.from({ length: DEFAULTS_LIST_MAX }, (_, i) => `wss://r${i}.example`), indexer: ['wss://purplepag.es'] };
    expect(await loadDefaults(store, 'u', json(more))).toEqual(more);
    // the dev build's operator is on localhost, without TLS
    const dev = { ...DEFAULTS, operator: { relay: 'ws://localhost:7777', blossom: 'http://localhost:3000', api: 'http://localhost:8447' } };
    expect(await loadDefaults(store, 'u', json(dev))).toEqual(dev);
  });
});

describe('pairing with an operator that misbehaves', () => {
  test('POST /pair-offers that never answers rejects in time, so the page says it can’t connect and tries again', async () => {
    const o = await newOffer(device, DEFAULTS, 'Chrome on a Mac', webCrypto, NOW);
    const r = await timed(postOffer(device, DEFAULTS, o, quickKey, never, 50));
    expect(r.rejected).toBe(true);
    expect(r.ms).toBeLessThan(5000);
    expect(o.posted).toBe(false);
  });
});

describe('Blossom answers that never end', () => {
  test('an upload answered with an endless descriptor fails as it is read, and the save waits to try again', async () => {
    const e = endless();
    await expect(fetchNet(async () => undefined, e.get).upload('https://blossom.example', new Uint8Array(8), 'ab'.repeat(32), device)).rejects.toThrow('answer too large');
    expect(e.read.mb).toBeLessThan(4);
  });

  test('a refusal with an endless reason is read only as far as the limit', async () => {
    const read = { mb: 0 };
    const get = (async () =>
      new Response(new ReadableStream({ pull: (c) => void (read.mb++, c.enqueue(new Uint8Array(1 << 20).fill(0x61))) }), { status: 413 })) as unknown as typeof fetch;
    expect(await fetchNet(async () => undefined, get).upload('https://blossom.example', new Uint8Array(8), 'ab'.repeat(32), device)).toMatchObject({ ok: false, status: 413, permanent: true });
    expect(read.mb).toBeLessThan(4);
  });

  test('Undo’s removal of the blob is given up on, rather than holding Undo for as long as the server waits', async () => {
    let signal: AbortSignal | undefined;
    const spy = (async (_u: string, init: RequestInit) => ((signal = init.signal ?? undefined), new Response(null, { status: 200 }))) as unknown as typeof fetch;
    expect(await fetchNet(async () => undefined, spy).remove('https://blossom.example', 'ab'.repeat(32), device)).toMatchObject({ ok: true });
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe('lists from the phone that aren’t lists of addresses', () => {
  const ack = (lists: Partial<PairAck>): PairAck => ({ v: 1, user_pubkey: user.pubkey(), write_relays: [], blossom_servers: [], token: 'cd'.repeat(32), nonce: 'n', ...lists });
  const junk = [1, { toString: null }, null, 'wss://ok.example', `wss://${'x'.repeat(ADDRESS_MAX)}`] as unknown as string[];

  test('the pairing keeps the addresses only, and at most a hundred of them', () => {
    const p = pairingFrom(ack({ write_relays: junk, blossom_servers: 'not a list' as unknown as string[] }), 'Chrome on a Mac', NOW);
    expect(p).toMatchObject({ write_relays: ['wss://ok.example'], blossom_servers: [] });
    const many = pairingFrom(ack({ write_relays: Array.from({ length: 100_000 }, (_, i) => `wss://r${i}.example`) }), 'x', NOW);
    expect(many.write_relays).toHaveLength(LIST_MAX);
  });

  test('Advanced still draws from a pairing kept before its lists were checked', () => {
    expect(() => relayRows(junk, DEFAULTS)).not.toThrow();
    expect(relayRows(junk, DEFAULTS).map((r) => r.url)).toEqual(['wss://relay.example', 'wss://ok.example']);
    expect(relayRows(junk, null).map((r) => r.url)).toEqual(['wss://ok.example']);
  });

  test('Advanced draws relays whose addresses hold long runs of slashes in good time, and still finds Kefli’s', () => {
    // a hundred of the longest addresses a pairing keeps, each a run of slashes and then a letter: the pattern for a
    // trailing run was tried from every slash of it, 5 to 14 ms an address, and Advanced drew these in 2 to 6 s
    const runs = Array.from({ length: LIST_MAX - 1 }, (_, i) => `wss://r${i}.example/${'/'.repeat(ADDRESS_MAX - 40)}x`);
    const kefli = `wss://relay.example${'/'.repeat(ADDRESS_MAX - 19)}`;
    const started = Date.now();
    const rows = relayRows([...runs, kefli], DEFAULTS);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(rows[0]).toEqual({ url: kefli, label: 'Kefli', operator: true });
    expect(rows.slice(1).map((r) => r.url)).toEqual(runs);
    expect(rows.slice(1).every((r) => r.label === 'Your relay')).toBe(true);
  });

  test('a move’s pairing is kept the same way', async () => {
    const store = memoryStore();
    await store.set(KEYS.pairing, PAIRING);
    const T = new LocalSigner(hexToBytes('33'.repeat(32)));
    const p = await applyMove(store, device, { ...ack({ write_relays: junk }), user_pubkey: T.pubkey(), moved_from: user.pubkey(), nonce: undefined }, NOW, memoryStore());
    expect(p.write_relays).toEqual(['wss://ok.example']);
    expect((await store.get<Pairing>(KEYS.pairing))!.write_relays).toEqual(['wss://ok.example']);
  });
});
