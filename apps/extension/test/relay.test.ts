// Whether the phone has collected a save, when the relay can't be reached at all (F40): an answer, not an error.
import { collected } from '../src/relay';

jest.mock('nostr-tools/relay', () => ({ Relay: { connect: () => Promise.reject(new Error('connection failed')) } }));

test('a relay that refuses the connection reads as not collected', async () => {
  await expect(collected('wss://relay.example', 'ab'.repeat(32), 'cd'.repeat(32))).resolves.toBe(false);
});
