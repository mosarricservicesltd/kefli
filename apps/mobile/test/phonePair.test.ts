import { LocalSigner, newMnemonic, secretKeyFromMnemonic, type PhoneQr } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { showPhonePair, takePhonePair, type ShowPorts } from '../src/services/phonePair';
import { SERVER_TIMEOUT_MS } from '../src/net/http';
import { memoryDb } from './sqlite';
import { inward, silent, watch } from './inward';

const D = { operator: { relay: 'ws://op', blossom: 'http://b', api: 'http://api' }, mirrors: ['http://m'] };

async function world(opts: { down?: boolean } = {}) {
  const words = newMnemonic(nodeCrypto);
  const signer = new LocalSigner(await secretKeyFromMnemonic(words, nodeCrypto));
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, 1, signer.pubkey(), 'new', true);
  db.run('UPDATE identities SET registered_at = 1');
  const offers = new Map<string, string>();
  const fetch = (async (url: string, init: RequestInit) => {
    if (opts.down) throw new Error('offline');
    if (init.method === 'POST') {
      const b = JSON.parse(String(init.body));
      offers.set(b.lookup, b.offer);
      return new Response('{}');
    }
    const lookup = url.split('/').pop()!;
    if (!offers.has(lookup)) return new Response('{}', { status: 404 });
    const offer = offers.get(lookup);
    offers.delete(lookup);
    return new Response(JSON.stringify({ v: 1, offer }));
  }) as unknown as typeof globalThis.fetch;
  const show: ShowPorts = {
    db, now: () => 1000, owner: signer.pubkey(), defaults: async () => D, signer: async () => signer, fetch, crypto: nodeCrypto,
    runOutbox: async () => 0, mnemonic: async () => words,
  };
  return { words, signer, show, take: { fetch, crypto: nodeCrypto, api: D.operator.api }, offers };
}

describe('second-phone pairing on the phone (mobile spec 5.3, 5.8)', () => {
  test('the source posts an offer that the target opens once with the six digits', async () => {
    const w = await world();
    const shown = await showPhonePair(w.show);
    if (shown === 'offline') throw new Error('offline');
    expect(shown.qr.pubkey).toBe(w.signer.pubkey());
    expect(w.offers.size).toBe(1);
    const wrongSix = shown.six === '000000' ? '000001' : '000000';
    expect(await takePhonePair(w.take, shown.qr, wrongSix)).toBe('wrong');
    expect(await takePhonePair(w.take, shown.qr, shown.six)).toEqual({ mnemonic: w.words });
    // fetched once: the offer is gone
    expect(await takePhonePair(w.take, shown.qr, shown.six)).toBe('wrong');
  });

  test("an offer whose key isn't the QR's pubkey is refused", async () => {
    const w = await world();
    const shown = await showPhonePair(w.show);
    if (shown === 'offline') throw new Error('offline');
    const forged: PhoneQr = { ...shown.qr, pubkey: new LocalSigner(nodeCrypto.randomBytes(32)).pubkey() };
    expect(await takePhonePair(w.take, forged, shown.six)).toBe('wrong');
  });

  test('offline on either side', async () => {
    const w = await world({ down: true });
    expect(await showPhonePair(w.show)).toBe('offline');
    const qr: PhoneQr = { v: 1, pubkey: w.signer.pubkey(), secret: 'ab'.repeat(32), expires: 2000 };
    expect(await takePhonePair(w.take, qr, '123456')).toBe('offline');
    const noWords = await world();
    expect(await showPhonePair({ ...noWords.show, mnemonic: async () => null })).toBe('offline');
  });

  test("the API sending the offer's post or its fetch into the phone's network: nothing is asked there, and that side is offline", async () => {
    const w = await world();
    // followed as OkHttp followed it, whatever answered at 192.168.1.1 had the sealed offer, and then the six digits' lookup
    const post = inward(w.show.fetch, (m) => m === 'POST');
    expect(await showPhonePair({ ...w.show, fetch: post.f })).toBe('offline');
    expect(post.asked).toEqual([]);
    const shown = await showPhonePair(w.show);
    if (shown === 'offline') throw new Error('offline');
    const get = inward(w.take.fetch, (m) => m === 'GET');
    expect(await takePhonePair({ ...w.take, fetch: get.f }, shown.qr, shown.six)).toBe('offline');
    expect(get.asked).toEqual([]);
    // the offer is still held for an answer the phone can take
    expect(await takePhonePair(w.take, shown.qr, shown.six)).toEqual({ mnemonic: w.words });
  });

  test("the API answering either call with any redirect, its own origin's or another's: that side is offline, and nothing it names is asked", async () => {
    // every call to the API is signed for its exact address (C§6), so it never answers through a redirect. Followed, a
    // post answered 302 to a page that answers 200 showed a code whose offer the API never held, and a fetch answered
    // 303 to another of its paths read as a wrong code
    const w = await world();
    for (const [status, location] of [[302, 'https://news.example/'], [303, '/phone-offers/elsewhere'], [307, 'http://api/v1/phone-offers'], [301, null]] as const) {
      const asked: string[] = [];
      const away = (f: typeof fetch, method: string) => (async (url: string, init: RequestInit = {}) => {
        asked.push(`${init.method ?? 'GET'} ${url}`);
        if (!url.startsWith('http://api/')) return new Response('<p>a page</p>', { status: 200 });
        if ((init.method ?? 'GET') === method) return new Response(null, { status, headers: location ? { location } : {} });
        return f(url, init);
      }) as typeof fetch;
      expect([status, await showPhonePair({ ...w.show, fetch: away(w.show.fetch, 'POST') })]).toEqual([status, 'offline']);
      const shown = await showPhonePair(w.show);
      if (shown === 'offline') throw new Error('offline');
      expect([status, await takePhonePair({ ...w.take, fetch: away(w.take.fetch, 'GET') }, shown.qr, shown.six)]).toEqual([status, 'offline']);
      expect([status, asked.map((a) => a.replace(/[0-9a-f]{64}$/, '<lookup>'))])
        .toEqual([status, ['POST http://api/phone-offers', 'GET http://api/phone-offers/<lookup>']]);
      // the offer is still held for an answer the phone can take
      expect(await takePhonePair(w.take, shown.qr, shown.six)).toEqual({ mnemonic: w.words });
    }
  });

  test('an API that takes either call and never answers is let go at its deadline: offline, where each side waited for good', async () => {
    const w = await world();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    try {
      const show = watch(showPhonePair({ ...w.show, fetch: silent }));
      const qr: PhoneQr = { v: 1, pubkey: w.signer.pubkey(), secret: 'ab'.repeat(32), expires: 2000 };
      const take = watch(takePhonePair({ ...w.take, fetch: silent }, qr, '123456'));
      await jest.advanceTimersByTimeAsync(SERVER_TIMEOUT_MS - 1_000);
      expect([show.settled, take.settled]).toEqual([false, false]);
      await jest.advanceTimersByTimeAsync(2_000);
      expect([show.value, take.value]).toEqual(['offline', 'offline']);
    } finally {
      jest.useRealTimers();
    }
  });
});
