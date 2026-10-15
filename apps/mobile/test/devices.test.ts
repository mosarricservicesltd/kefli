import {
  LocalSigner, PAIR_ACK_D, buildDevicesEvent, derivePairCode, deviceProofTemplate, newPairCode, nobleSecp, readDevicesEvent, sealOffer,
  signEventWith, unwrap, type NostrEvent, type PairOffer,
} from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { seedGeneratedLists } from '../src/data/lists';
import { absorbRecord, browserCount, connectedBrowsers, disconnect, localRecord } from '../src/data/devices';
import { enqueue } from '../src/data/outbox';
import { youStats } from '../src/data/you';
import { connectBrowser, lookupCode, readScan, type ConnectPorts } from '../src/services/connect';
import { drain, type RelayAnswer, type SendPorts } from '../src/services/send';
import { syncInbound, type SyncPorts } from '../src/services/sync';
import type { Defaults } from '../src/services/config';
import { SERVER_TIMEOUT_MS } from '../src/net/http';
import { memoryDb } from './sqlite';
import { inward, silent, watch } from './inward';

const D: Defaults = {
  v: 1, operator: { relay: 'ws://op', blossom: 'http://blossom', api: 'http://api' },
  relays: ['ws://a', 'ws://b'], indexer: ['ws://a'], mirrors: ['http://m1'],
};
const T0 = 1_800_000_000;

const deviceSecrets = new Map<string, Uint8Array>();

function deviceKey() {
  const sk = nodeCrypto.randomBytes(32);
  const pubkey = bytesToHex(schnorr.getPublicKey(sk));
  deviceSecrets.set(pubkey, sk);
  return { signer: new LocalSigner(sk), pubkey };
}

/** The proof the extension signs with its offer (C§4.4), made when the offer is; fixed aux, so the same each time. */
const MADE = T0 - 100;
const fixedAux = { ...nobleSecp, sign: (hash: string, sk: Uint8Array) => nobleSecp.sign(hash, sk, '00'.repeat(32)) };
function proofOf(pubkey: string, nonce = 'n-1', api = D.operator.api): PairOffer['proof'] {
  const e = signEventWith(fixedAux, deviceProofTemplate(api, nonce, MADE), deviceSecrets.get(pubkey)!);
  return { created_at: e.created_at, sig: e.sig };
}

function offerFor(pubkey: string, over: Partial<PairOffer> = {}): PairOffer {
  return { v: 1, device_pubkey: pubkey, relay: D.operator.relay, nonce: 'n-1', expires: T0 + 300, label: 'Chrome on a Linux laptop', proof: proofOf(pubkey), ...over };
}

function world(opts: { relay?: (url: string, e: NostrEvent) => RelayAnswer; status?: (method: string, url: string) => number; registered?: boolean } = {}) {
  const db = memoryDb();
  migrate(db);
  const signer = new LocalSigner(nodeCrypto.randomBytes(32));
  const owner = signer.pubkey();
  ensureIdentityRow(db, T0, owner, 'new', true);
  seedGeneratedLists(db, owner, D);
  if (opts.registered !== false) db.run('UPDATE identities SET registered_at = 1 WHERE pubkey = ?', owner);
  let clock = T0;
  const calls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const events: { relay: string; event: NostrEvent }[] = [];
  const offers = new Map<string, string>();
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push(`${init.method} ${url}`);
    if (init.method === 'POST' && url.endsWith('/devices')) bodies.push(JSON.parse(String(init.body)));
    const s = opts.status?.(init.method!, url);
    if (s) return new Response('{}', { status: s });
    const m = /\/pair-offers\/([0-9a-f]+)$/.exec(url);
    if (m) return offers.has(m[1]) ? new Response(JSON.stringify({ v: 1, offer: offers.get(m[1]) })) : new Response('{}', { status: 404 });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const send: SendPorts = {
    db, now: () => clock, signer: async (pk) => (pk === owner ? signer : null), fetch, crypto: nodeCrypto, defaults: () => D,
    publish: async (relay, event) => {
      events.push({ relay, event });
      return opts.relay?.(relay, event) ?? { ok: true };
    },
    readBlob: async () => null,
  };
  const ports: ConnectPorts = {
    db, now: () => clock, owner, defaults: async () => D, signer: async () => signer, fetch, crypto: nodeCrypto,
    runOutbox: () => drain(send),
  };
  return { db, signer, owner, ports, send, calls, bodies, events, offers, tick: (s: number) => (clock += s) };
}

describe('connected browsers (mobile spec 5.5, contract 4.4 and 4.9)', () => {
  test('a scanned offer is checked as the contract says', () => {
    const { pubkey } = deviceKey();
    expect(readScan(JSON.stringify(offerFor(pubkey)), D.operator, T0)).toEqual({ offer: offerFor(pubkey) });
    expect(readScan(JSON.stringify(offerFor(pubkey, { expires: T0 - 61 })), D.operator, T0)).toEqual({ problem: 'expired' });
    // 60 s of skew is allowed
    expect('offer' in readScan(JSON.stringify(offerFor(pubkey, { expires: T0 - 59 })), D.operator, T0)).toBe(true);
    expect(readScan(JSON.stringify(offerFor(pubkey, { relay: 'wss://elsewhere' })), D.operator, T0)).toEqual({ problem: 'wrong' });
    expect(readScan('https://example.com', D.operator, T0)).toEqual({ problem: 'wrong' });
    expect(readScan('null', D.operator, T0)).toEqual({ problem: 'wrong' });
  });

  test("an offer without the device key's proof, or with one that doesn't hold, reads as a wrong code (C§4.4)", () => {
    const { pubkey } = deviceKey();
    const other = deviceKey().pubkey;
    const scan = (o: Partial<PairOffer>) => readScan(JSON.stringify(o), D.operator, T0);
    // an extension from before contract v1.11 sends none
    expect(scan({ ...offerFor(pubkey), proof: undefined })).toEqual({ problem: 'wrong' });
    // signed by another key, over another nonce, or for another operator
    expect(scan(offerFor(pubkey, { proof: proofOf(other) }))).toEqual({ problem: 'wrong' });
    expect(scan(offerFor(pubkey, { proof: proofOf(pubkey, 'n-2') }))).toEqual({ problem: 'wrong' });
    expect(scan(offerFor(pubkey, { proof: proofOf(pubkey, 'n-1', 'http://api.elsewhere') }))).toEqual({ problem: 'wrong' });
    expect(scan(offerFor(pubkey, { proof: { ...proofOf(pubkey), created_at: MADE + 1 } }))).toEqual({ problem: 'wrong' });
    // the phone's own verify decides
    expect(readScan(JSON.stringify(offerFor(pubkey)), D.operator, T0, () => false)).toEqual({ problem: 'wrong' });
  });

  test("a typed code's offer is held to the same proof", async () => {
    const w = world();
    const { pubkey } = deviceKey();
    const code = newPairCode(nodeCrypto);
    const { lookup, key } = await derivePairCode(code, nodeCrypto);
    w.offers.set(lookup, await sealOffer(offerFor(pubkey, { proof: proofOf(deviceKey().pubkey) }), key, nodeCrypto));
    expect(await lookupCode(w.ports, code)).toEqual({ problem: 'wrong' });
  }, 20_000);

  test('a typed code finds its offer; a wrong or short one does not', async () => {
    const w = world();
    const { pubkey } = deviceKey();
    const code = newPairCode(nodeCrypto);
    const { lookup, key } = await derivePairCode(code, nodeCrypto);
    w.offers.set(lookup, await sealOffer(offerFor(pubkey), key, nodeCrypto));
    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    expect(await lookupCode(w.ports, typed)).toEqual({ offer: offerFor(pubkey) });
    expect(await lookupCode(w.ports, 'K7QM')).toEqual({ problem: 'wrong' });
    expect(await lookupCode(w.ports, code === '00000000' ? '11111111' : '00000000')).toEqual({ problem: 'wrong' });
    // sealed under another code's key: it doesn't open
    const other = await derivePairCode('ABCDEFGH', nodeCrypto);
    w.offers.set(other.lookup, await sealOffer(offerFor(pubkey), key, nodeCrypto));
    expect(await lookupCode(w.ports, 'ABCD-EFGH')).toEqual({ problem: 'wrong' });
    w.tick(400);
    expect(await lookupCode(w.ports, typed)).toEqual({ problem: 'expired' });
    // each lookup runs scrypt at N = 16384 (contract 4.4), which outlasts Jest's five seconds when the whole suite runs
  }, 20_000);

  test('an unregistered identity registers first; the API down is offline', async () => {
    const w = world({ registered: false, status: (m, u) => (u.includes('/pair-offers/') ? 503 : 0) });
    expect(await lookupCode(w.ports, 'ABCD-EFGH')).toEqual({ problem: 'offline' });
    expect(w.calls[0]).toBe('POST http://api/register');
  });

  test("the API sending a typed code's lookup into the phone's network: nothing is asked there, and it reads as offline", async () => {
    const w = world();
    const net = inward(w.ports.fetch, (_m, url) => url.includes('/pair-offers/'));
    // followed as OkHttp followed it, whatever answered at 192.168.1.1 had the lookup, and its answer was read as the offer
    expect(await lookupCode({ ...w.ports, fetch: net.f }, 'ABCD-EFGH')).toEqual({ problem: 'offline' });
    expect(net.asked).toEqual([]);
  }, 20_000);

  test('an API that takes the lookup and never answers is let go at its deadline: offline, where Connect waited for good', async () => {
    const w = world();
    let asked = (): void => undefined;
    const started = new Promise<void>((ok) => (asked = ok));
    const stalls = (async (url: string, init: RequestInit) => {
      if (!url.includes('/pair-offers/')) return w.ports.fetch(url, init);
      asked();
      return silent(url, init);
    }) as typeof fetch;
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    try {
      const run = watch(lookupCode({ ...w.ports, fetch: stalls }, 'ABCD-EFGH'));
      // the code is stretched first (scrypt), in real time
      await started;
      await jest.advanceTimersByTimeAsync(SERVER_TIMEOUT_MS + 1_000);
      expect(run).toMatchObject({ settled: true, value: { problem: 'offline' } });
    } finally {
      jest.useRealTimers();
    }
  }, 20_000);

  test('Connect posts the device, wraps the pair-ack to it, and republishes the record', async () => {
    const w = world();
    const dev = deviceKey();
    const offer = offerFor(dev.pubkey);
    expect(await connectBrowser(w.ports, offer)).toBe('connected');
    expect(w.calls).toContain('POST http://api/devices');
    // the device's proof goes with it, its nonce beside it, and nothing names the browser to the operator (F30)
    expect(w.bodies).toEqual([{ v: 1, device_pubkey: dev.pubkey, proof: { nonce: 'n-1', ...offer.proof } }]);
    const wrap = w.events.find((e) => e.event.kind === 1059)!;
    expect(wrap.relay).toBe(D.operator.relay);
    const { rumor, seal } = await unwrap(dev.signer, wrap.event);
    expect(seal.pubkey).toBe(w.owner);
    expect(rumor.tags).toContainEqual(['d', PAIR_ACK_D]);
    const ack = JSON.parse(rumor.content);
    expect(ack).toMatchObject({ v: 1, user_pubkey: w.owner, nonce: 'n-1', write_relays: ['ws://op', 'ws://a', 'ws://b'], blossom_servers: ['http://blossom', 'http://m1'] });
    expect(ack.token).toMatch(/^[0-9a-f]{64}$/);

    expect(connectedBrowsers(w.db, w.owner)).toEqual([{ device_pubkey: dev.pubkey, label: 'Chrome on a Linux laptop', connected_at: T0 }]);
    expect(youStats(w.db, w.owner).browsers).toBe(1);
    // the record went to the write relays, never to the indexer alone
    const records = w.events.filter((e) => e.event.kind === 30078 && e.event.tags.some((t) => t[1] === 'kefli/devices'));
    expect(records.map((e) => e.relay).sort()).toEqual(['ws://a', 'ws://b', 'ws://op']);
    const record = await readDevicesEvent(w.signer, records[0].event);
    expect(record.devices).toEqual([{ device_pubkey: dev.pubkey, label: 'Chrome on a Linux laptop', token: ack.token, connected_at: T0, revoked_at: null }]);
  });

  test("Can't connect withdraws the rows and lets the API's device go", async () => {
    const w = world({ relay: (_u, e) => (e.kind === 1059 ? { ok: false, reason: 'error: down' } : { ok: true }) });
    const dev = deviceKey();
    expect(await connectBrowser(w.ports, offerFor(dev.pubkey))).toBe('failed');
    expect(browserCount(w.db, w.owner)).toBe(0);
    expect(w.db.all("SELECT op FROM outbox")).toEqual([{ op: 'delete_device' }]);
    await drain(w.send);
    expect(w.calls).toContain(`DELETE http://api/devices/${dev.pubkey}`);
    expect(w.db.all('SELECT op FROM outbox')).toEqual([]);
  });

  test("a refused POST /devices is Can't connect, with nothing to let go", async () => {
    const w = world({ status: (m, u) => (m === 'POST' && u.endsWith('/devices') ? 500 : 0) });
    expect(await connectBrowser(w.ports, offerFor(deviceKey().pubkey))).toBe('failed');
    expect(w.db.all('SELECT op FROM outbox')).toEqual([]);
    expect(w.events.some((e) => e.event.kind === 1059)).toBe(false);
  });

  test('a post_device queued before the proof is refused here, without asking the API', async () => {
    const w = world();
    const dev = deviceKey();
    const id = enqueue(w.db, T0, { op: 'post_device', signer: w.owner, subject: 't', payload: { device_pubkey: dev.pubkey, label: 'Chrome' }, targets: [`${D.operator.api}/devices`] });
    await drain(w.send);
    expect(w.calls.filter((c) => c.endsWith('/devices'))).toEqual([]);
    expect(w.db.get<{ state: string }>('SELECT state FROM outbox WHERE id = ?', id)?.state).toBe('dead');
  });

  test('Disconnect revokes at once, republishes and calls DELETE /devices', async () => {
    const w = world();
    const dev = deviceKey();
    await connectBrowser(w.ports, offerFor(dev.pubkey));
    w.tick(60);
    disconnect(w.db, T0 + 60, w.owner, D.operator.api, dev.pubkey);
    expect(connectedBrowsers(w.db, w.owner)).toEqual([]);
    w.events.length = 0;
    await drain(w.send);
    expect(w.calls).toContain(`DELETE http://api/devices/${dev.pubkey}`);
    const record = await readDevicesEvent(w.signer, w.events.find((e) => e.event.tags.some((t) => t[1] === 'kefli/devices'))!.event);
    expect(record.devices[0].revoked_at).toBe(T0 + 60);
  });

  test('a copy from a relay merges by token, keeps revocations, and republishes when this phone holds more', () => {
    const w = world();
    const a = { device_pubkey: deviceKey().pubkey, label: 'Chrome', token: 'a'.repeat(64), connected_at: 10, revoked_at: null };
    const b = { device_pubkey: deviceKey().pubkey, label: 'Firefox', token: 'b'.repeat(64), connected_at: 20, revoked_at: null };
    expect(absorbRecord(w.db, w.owner, { v: 1, devices: [a] }, 'e1', 100)).toBe(false);
    expect(absorbRecord(w.db, w.owner, { v: 1, devices: [a, b] }, 'e2', 110)).toBe(false);
    // a copy missing b, with a revoked: a stays revoked and the phone has b to add back
    expect(absorbRecord(w.db, w.owner, { v: 1, devices: [{ ...a, revoked_at: 50 }] }, 'e3', 120)).toBe(true);
    expect(localRecord(w.db, w.owner).devices).toEqual([{ ...a, revoked_at: 50 }, b]);
    // an older copy can't bring a's token back
    expect(absorbRecord(w.db, w.owner, { v: 1, devices: [a, b] }, 'e0', 90)).toBe(true);
    expect(connectedBrowsers(w.db, w.owner).map((x) => x.label)).toEqual(['Firefox']);
    // the earlier revoked_at wins
    absorbRecord(w.db, w.owner, { v: 1, devices: [{ ...a, revoked_at: 40 }, b] }, 'e4', 130);
    expect(localRecord(w.db, w.owner).devices[0].revoked_at).toBe(40);
  });

  test('sync merges the record it finds with the saves and queues a republish when needed', async () => {
    const w = world();
    const mine = { device_pubkey: deviceKey().pubkey, label: 'Chrome', token: 'c'.repeat(64), connected_at: 5, revoked_at: null };
    const theirs = { device_pubkey: deviceKey().pubkey, label: 'Firefox', token: 'd'.repeat(64), connected_at: 6, revoked_at: null };
    absorbRecord(w.db, w.owner, { v: 1, devices: [mine] }, 'e1', 1);
    const event = await buildDevicesEvent(w.signer, { v: 1, devices: [theirs] }, T0 - 10);
    const ports: SyncPorts = {
      db: w.db, now: () => T0, signer: async () => w.signer, fetch: w.send.fetch, crypto: nodeCrypto, defaults: async () => D,
      query: async (_relay, filters) => (filters[0].kinds.includes(30078) ? [event] : []),
      files: { writeText: () => undefined, removeText: () => undefined, removeAll: () => undefined },
    };
    const r = await syncInbound(ports);
    expect(r.items).toBe(0);
    expect(browserCount(w.db, w.owner)).toBe(2);
    expect(w.db.all("SELECT op FROM outbox WHERE op = 'publish_lists'")).toHaveLength(1);
  });
});
