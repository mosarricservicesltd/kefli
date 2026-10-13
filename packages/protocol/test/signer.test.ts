import { BACKGROUND_ZERO_MS, LocalSigner, Nip55Signer, SignerSlot, nobleSecp, signedAsAsked, type Nip55Port } from '../src';
import { nodeCrypto } from '../src/node';

const fresh = () => new LocalSigner(nodeCrypto.randomBytes(32));
const zeroed = (s: LocalSigner) => s.nip44Encrypt(s.pubkey(), 'x').then(() => false, (e: Error) => e.message.includes('zeroed'));

describe('the phone’s signer slot (mobile spec 3.4, 7.1)', () => {
  afterEach(() => jest.useRealTimers());

  test('a local key let go of is zeroed: replaced or dropped', async () => {
    const slot = new SignerSlot();
    const a = fresh();
    const b = fresh();
    slot.set(a);
    slot.set(a);
    expect(await zeroed(a)).toBe(false);
    slot.set(b);
    expect(await zeroed(a)).toBe(true);
    expect(slot.get()).toBe(b);
    slot.set(null);
    expect(await zeroed(b)).toBe(true);
    expect(slot.get()).toBeNull();
  });

  test('five minutes in the background zero the local key; a shorter absence keeps it', async () => {
    jest.useFakeTimers();
    const slot = new SignerSlot();
    const s = fresh();
    slot.set(s);
    slot.background();
    jest.advanceTimersByTime(BACKGROUND_ZERO_MS - 1);
    slot.foreground();
    jest.advanceTimersByTime(BACKGROUND_ZERO_MS);
    expect(slot.get()).toBe(s);
    expect(await zeroed(s)).toBe(false);
    slot.background();
    jest.advanceTimersByTime(BACKGROUND_ZERO_MS);
    expect(slot.get()).toBeNull();
    expect(await zeroed(s)).toBe(true);
  });

  test('a timer held up in the background is made good on return', async () => {
    const slot = new SignerSlot(1000);
    const s = fresh();
    slot.set(s);
    slot.background(0);
    slot.foreground(1000);
    expect(slot.get()).toBeNull();
    expect(await zeroed(s)).toBe(true);
  });

  test('a signer app stays through the background: it holds no key here', () => {
    jest.useFakeTimers();
    const slot = new SignerSlot();
    const app = new Nip55Signer({} as Nip55Port, 'com.example.signer', 'ab'.repeat(32));
    slot.set(app);
    slot.background();
    jest.advanceTimersByTime(BACKGROUND_ZERO_MS * 2);
    slot.foreground();
    expect(slot.get()).toBe(app);
  });
});

describe('a signer app’s answer is the event asked for (F46)', () => {
  const s = fresh();
  const asked = { kind: 30078, created_at: 1_700_000_000, tags: [['d', 'kefli/item/x'], ['t', 'kefli']], content: 'c', pubkey: s.pubkey() };
  const verify = nobleSecp.verify;

  test('the signed event passes', async () => {
    expect(signedAsAsked(asked, await s.signEvent(asked), verify)).toBe(true);
  });

  test('another event, another key, a broken id or signature, or odd hex are refused', async () => {
    const good = await s.signEvent(asked);
    const other = await fresh().signEvent(asked);
    const changed = await s.signEvent({ ...asked, content: 'not c' });
    expect(signedAsAsked(asked, changed, verify)).toBe(false);
    expect(signedAsAsked(asked, await s.signEvent({ ...asked, tags: [] }), verify)).toBe(false);
    expect(signedAsAsked(asked, await s.signEvent({ ...asked, created_at: 1 }), verify)).toBe(false);
    expect(signedAsAsked(asked, other, verify)).toBe(false);
    expect(signedAsAsked(asked, { ...good, id: changed.id }, verify)).toBe(false);
    expect(signedAsAsked(asked, { ...good, sig: changed.sig }, verify)).toBe(false);
    expect(signedAsAsked(asked, { ...good, sig: good.sig.toUpperCase() }, verify)).toBe(false);
    expect(signedAsAsked(asked, { ...good, sig: '+' + good.sig.slice(1) }, verify)).toBe(false);
    expect(signedAsAsked(asked, null as never, verify)).toBe(false);
  });
});
