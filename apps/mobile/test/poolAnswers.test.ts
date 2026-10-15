import { LocalSigner, nobleSecp } from '@kefli/protocol';
import { CutShort, QUERY_MAX_MS, QUERY_QUIET_MS, RelayPool } from '../src/net/pool';
import { watch } from './inward';
import { relaySockets, type Step } from './relaySocket';

// The deploy check's probe (r3/deploy-r, 15 October 2026), as a test: how a query ends an answer the relay is slow to
// send, or doesn't finish. Then, nostr-tools' own EOSE timer (4.4 s from the REQ) ended a slow answer of 500 wraps
// after 100 and the query returned them as whole, and so did a connection closed after 200; against strfry, 428, 131,
// 189, 150 and 362 of 500 came back so. Only the relay's EOSE makes an answer whole now (net/pool CutShort).

const owner = 'a'.repeat(64);
const wrap = (i: number) => ({
  id: i.toString(16).padStart(64, '0'), pubkey: 'b'.repeat(64), kind: 1059, created_at: 1_700_000_000 - i, tags: [['p', owner]], content: 'x',
  sig: 'c'.repeat(128),
});
const held = Array.from({ length: 500 }, (_, i) => wrap(i));
const filter = [{ kinds: [1059], '#p': [owner], limit: 500 }];
const URL = 'wss://op.example';

function poolFor(plan: (before: number) => Step[], challenge = false) {
  const relay = relaySockets({ holds: () => held, plan: (_url, _f, before) => plan(before), challenge });
  const signer = new LocalSigner(new Uint8Array(32).fill(7), nobleSecp);
  return { pool: new RelayPool({ verify: () => true, signer: async () => signer, WebSocket: relay.Socket }), sockets: relay.sockets };
}

describe('a query is whole only once the relay sends EOSE (net/pool)', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  test('an answer still coming after nostr-tools’ own EOSE timer is waited for, while the relay keeps sending', async () => {
    // the probe's slow answer: 100 wraps at once, the other 400 and EOSE six seconds later
    const { pool } = poolFor(() => [{ send: 100 }, { wait: 6_000 }, {}, 'eose']);
    const got = watch(pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(5_000);
    expect(got.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1_500);
    expect(got.value).toHaveLength(500);
    pool.close();
  });

  test('an answer cut off by the connection closing fails the query, rather than returning what came as whole', async () => {
    const { pool } = poolFor(() => [{ send: 200 }, { wait: 200 }, 'drop']);
    const got = watch(pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(500);
    expect(got.error).toBeInstanceOf(CutShort);
    expect(got.error).toMatchObject({ received: 200, why: 'closed: relay connection closed' });
    pool.close();
  });

  test('a relay that sends part of an answer and then nothing fails the query once it has been quiet for QUERY_QUIET_MS', async () => {
    const { pool } = poolFor(() => [{ send: 300 }]);
    const got = watch(pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(QUERY_QUIET_MS - 1);
    expect(got.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    expect(got.error).toMatchObject({ name: 'CutShort', received: 300 });
    // and nothing is left running: not the pool's timers, nor nostr-tools' own EOSE timer
    expect(jest.getTimerCount()).toBe(0);
    pool.close();
  });

  test('a CLOSED part way through an answer fails the query', async () => {
    const { pool } = poolFor(() => [{ send: 50 }, { closed: 'error: shutting down' }]);
    const got = watch(pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(100);
    expect(got.error).toMatchObject({ name: 'CutShort', received: 50, why: 'closed: error: shutting down' });
    expect(jest.getTimerCount()).toBe(0);
    pool.close();
  });

  test('an answer that trickles on past QUERY_MAX_MS fails there, however steadily it comes', async () => {
    // a wrap every seven seconds, each inside the quiet time, for 140 seconds: nine of them before the minute is up
    const { pool } = poolFor(() => [...Array.from({ length: 20 }, (): Step[] => [{ send: 1 }, { wait: 7_000 }]).flat(), 'eose']);
    const got = watch(pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(QUERY_MAX_MS - 1);
    expect(got.settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    expect(got.error).toMatchObject({ name: 'CutShort', received: 9, why: `no EOSE within ${QUERY_MAX_MS} ms` });
    pool.close();
  });

  test('a relay that still refuses after AUTH fails the query, rather than answering that it holds nothing', async () => {
    const { pool, sockets } = poolFor(() => [{ closed: 'auth-required: who are you' }], true);
    const got = watch(pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(100);
    expect(sockets[0].reqs).toHaveLength(2);
    expect(got.error).toMatchObject({ name: 'CutShort', received: 0, why: 'closed: auth-required: who are you' });
    pool.close();
  });

  test('a whole answer comes back at once, and so does one after AUTH, leaving nothing running', async () => {
    const plain = poolFor(() => [{}, 'eose']);
    const got = watch(plain.pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(10);
    expect(got.value).toHaveLength(500);
    expect(jest.getTimerCount()).toBe(0);
    plain.pool.close();
    const authed = poolFor((before) => (before === 0 ? [{ closed: 'auth-required: who are you' }] : [{ send: 3 }, 'eose']), true);
    const after = watch(authed.pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(100);
    expect(after.value).toHaveLength(3);
    expect(jest.getTimerCount()).toBe(0);
    authed.pool.close();
  });
});

// A connection the network has dropped without a word, as a NAT that forgot an idle one does, takes every REQ and
// answers none, and nothing tells the phone: nostr-tools sends no pings here. While nostr-tools' timer passed for EOSE,
// each query on it came back empty, as if whole; with the timer past the pool's limits, each was cut short instead, the
// next on the same connection too, until the system gave up on the socket minutes later.
describe('a relay that answers nothing at all is let go of (net/pool)', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  test('the next query asks on a new connection, and a live subscription on the old one is dropped to be opened again', async () => {
    // the first connection gone dead under the phone; any other answers
    const { pool, sockets } = poolFor(() => (sockets.length === 1 ? [] : [{}, 'eose']));
    const dropped = jest.fn();
    const live = watch(pool.watch(URL, filter, () => undefined, dropped));
    await jest.advanceTimersByTimeAsync(10);
    expect(live.settled).toBe(true);
    const first = watch(pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(QUERY_QUIET_MS + 1);
    expect(first.error).toMatchObject({ name: 'CutShort', received: 0, why: `nothing for ${QUERY_QUIET_MS} ms` });
    expect(sockets[0].readyState).toBe(3);
    expect(dropped).toHaveBeenCalledTimes(1);
    const again = watch(pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(2);
    expect(again.value).toHaveLength(500);
    pool.close();
  });

  test('a relay that went quiet part way through an answer keeps its connection', async () => {
    // events came, so the connection was there: the next query is asked on it
    const { pool, sockets } = poolFor((before) => (before === 0 ? [{ send: 300 }] : [{}, 'eose']));
    const got = watch(pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(QUERY_QUIET_MS + 1);
    expect(got.error).toMatchObject({ name: 'CutShort', received: 300 });
    const again = watch(pool.query(URL, filter));
    await jest.advanceTimersByTimeAsync(10);
    expect(again.value).toHaveLength(500);
    expect(sockets).toHaveLength(1);
    pool.close();
  });
});
