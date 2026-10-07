import { LocalSigner, verifyEventWith, nobleSecp } from '@shelf/protocol';
import { nodeCrypto } from '@shelf/protocol/node';
import { RelayPool, acceptsUrl, publishAnswer, reconnectDelay } from '../src/net/pool';

const verify = (e: Parameters<typeof verifyEventWith>[1]) => verifyEventWith(nobleSecp, e);

describe('relay pool (mobile spec 4.4)', () => {
  test('reconnects back off from 1 s to 60 s', () => {
    expect([1, 2, 3, 6, 7, 20].map(reconnectDelay)).toEqual([1000, 2000, 4000, 32000, 60000, 60000]);
  });

  test('only wss://, unless the local stack allows ws://', () => {
    expect(acceptsUrl('wss://relay.example')).toBe(true);
    expect(acceptsUrl('ws://localhost:7447')).toBe(false);
    expect(acceptsUrl('ws://localhost:7447', true)).toBe(true);
    expect(acceptsUrl('https://relay.example', true)).toBe(false);
  });

  test('a refused publish is the relay’s answer; anything else is the network', () => {
    expect(publishAnswer(new Error('blocked: not registered'))).toEqual({ ok: false, reason: 'blocked: not registered' });
    expect(publishAnswer('auth-required: who are you')).toEqual({ ok: false, reason: 'auth-required: who are you' });
    expect(() => publishAnswer(new Error('publish timed out'))).toThrow('timed out');
  });

  test('a relay that fails to connect is backed off, then tried again', async () => {
    let clock = 0;
    let opened = 0;
    class Failing {
      onopen: (() => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onclose: ((e: unknown) => void) | null = null;
      onmessage: ((e: unknown) => void) | null = null;
      readyState = 0;
      constructor() {
        opened++;
        setTimeout(() => {
          this.onerror?.(new Error('refused'));
          this.onclose?.({ code: 1006 });
        }, 0);
      }
      send() {}
      close() {}
    }
    const pool = new RelayPool({ verify, signer: async () => null, WebSocket: Failing as unknown as typeof WebSocket, now: () => clock, connectTimeoutMs: 200 });
    await expect(pool.relay('wss://down.example')).rejects.toBeTruthy();
    await expect(pool.relay('wss://down.example')).rejects.toThrow('backing off');
    expect(opened).toBe(1);
    clock += 1000;
    await expect(pool.relay('wss://down.example')).rejects.toBeTruthy();
    expect(opened).toBe(2);
    await expect(pool.relay('ws://insecure.example')).rejects.toThrow('not a wss://');
  });
});

// Against server/dev's relays: SHELF_LOCAL_STACK=1 npx jest -c apps/mobile/jest.config.js pool
const local = process.env.SHELF_LOCAL_STACK === '1' ? describe : describe.skip;
local('relay pool on the local stack', () => {
  const signer = new LocalSigner(nodeCrypto.randomBytes(32));
  const pool = new RelayPool({ verify, signer: async () => signer, allowInsecure: true });
  afterAll(() => pool.close());

  test('publishes to the operator relay and reads it back', async () => {
    const event = await signer.signEvent({ kind: 30078, created_at: Math.floor(Date.now() / 1000), tags: [['d', 'shelf/devices'], ['t', 'shelf']], content: 'x' });
    expect(await pool.publish('ws://localhost:7447', event)).toEqual({ ok: true });
    const back = await pool.query('ws://localhost:7447', [{ ids: [event.id] }]);
    expect(back.map((e) => e.id)).toEqual([event.id]);
  });

  test('a 1059 read on the operator relay authenticates, then is answered (contract 3.2)', async () => {
    const r = await pool.relay('ws://localhost:7447');
    const closed = await new Promise<string>((ok) => {
      const sub = r.subscribe([{ kinds: [1059], '#p': [signer.pubkey()] }], { oneose: () => ok('eose'), onclose: (reason) => ok(reason) });
      setTimeout(() => { sub.close(); ok('timeout'); }, 5000);
    });
    expect(closed).toMatch(/(^|\s)auth-required:/);
    await expect(pool.query('ws://localhost:7447', [{ kinds: [1059], '#p': [signer.pubkey()] }])).resolves.toEqual([]);
  });

  test('a duplicate publish answers as such', async () => {
    const event = await signer.signEvent({ kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'twice' });
    await pool.publish('ws://localhost:7448', event);
    const again = await pool.publish('ws://localhost:7448', event);
    expect(again.ok || /^duplicate:/.test((again as { reason: string }).reason)).toBe(true);
  });
});
