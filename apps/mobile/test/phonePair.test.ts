import { LocalSigner, newMnemonic, secretKeyFromMnemonic, type PhoneQr } from '@shelf/protocol';
import { nodeCrypto } from '@shelf/protocol/node';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { showPhonePair, takePhonePair, type ShowPorts } from '../src/services/phonePair';
import { memoryDb } from './sqlite';

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
});
