// The NIP-55 port (modules/kefli-nip55/src) on Node, the native module stood in for: what the signer app answers
// to sign_event is checked before Kefli takes it (F46).
import { LocalSigner, nobleSecp, type NostrEvent } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';

const mockAnswer: { make: (asked: NostrEvent) => Promise<unknown> } = { make: async () => null };

jest.mock('expo-modules-core', () => ({
  requireNativeModule: (name: string) => (name === 'KefliSecp'
    ? { verify: jest.requireActual('@kefli/protocol').nobleSecp.verify }
    : { signEvent: async (_pkg: string, json: string) => JSON.stringify(await mockAnswer.make(JSON.parse(json))) }),
}), { virtual: true });

import { nip55Port } from '../modules/kefli-nip55/src';

const user = new LocalSigner(nodeCrypto.randomBytes(32), nobleSecp);
const asked = JSON.stringify({ kind: 30078, created_at: 1_700_000_000, tags: [['t', 'kefli']], content: 'c', pubkey: user.pubkey() });

describe('a signer app’s signed event (mobile spec 8.4, F46)', () => {
  test('the event asked for, signed by the user’s key, is taken', async () => {
    mockAnswer.make = (e) => user.signEvent(e);
    const out = JSON.parse(await nip55Port.signEvent('com.example.signer', asked, user.pubkey(), false)) as NostrEvent;
    expect(out.pubkey).toBe(user.pubkey());
  });

  test('an answer with a forged signature, or another event, is refused', async () => {
    mockAnswer.make = async (e) => ({ ...(await user.signEvent(e)), sig: 'ab'.repeat(64) });
    await expect(nip55Port.signEvent('com.example.signer', asked, user.pubkey(), false)).rejects.toThrow('not the event asked for');
    mockAnswer.make = (e) => user.signEvent({ ...e, content: 'something else' });
    await expect(nip55Port.signEvent('com.example.signer', asked, user.pubkey(), false)).rejects.toThrow('not the event asked for');
    mockAnswer.make = async () => 'not an event';
    await expect(nip55Port.signEvent('com.example.signer', asked, user.pubkey(), false)).rejects.toThrow('not the event asked for');
  });
});
