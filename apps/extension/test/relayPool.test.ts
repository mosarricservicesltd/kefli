// Connections held between saves (extension spec 4 and 6), with a fake relay and Jest's clock.
import { HOLD_MS, PING_MS, RelayPool, type PooledRelay } from '../src/relayPool';

class FakeRelay implements PooledRelay {
  connected = true;
  onclose: (() => void) | null = null;
  pings = 0;
  closed = false;
  close() {
    this.connected = false;
    this.closed = true;
  }
  subscribe(_f: object[], p: { oneose?: () => void }) {
    this.pings++;
    queueMicrotask(() => p.oneose?.());
    return { close() {} };
  }
  /** The relay going away by itself. */
  drop() {
    this.connected = false;
    this.onclose?.();
  }
}

function pool() {
  const made: FakeRelay[] = [];
  let fail = false;
  const p = new RelayPool<FakeRelay>(async () => {
    if (fail) throw new Error('refused');
    const r = new FakeRelay();
    made.push(r);
    return r;
  });
  return { p, made, failNext: (v: boolean) => (fail = v) };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test('consecutive saves share one connection', async () => {
  const { p, made } = pool();
  const a = await p.get('wss://r');
  const b = await p.get('wss://r');
  expect(a).toBe(b);
  expect(made).toHaveLength(1);
  const [c, d] = await Promise.all([p.get('wss://s'), p.get('wss://s')]);
  expect(c).toBe(d);
  expect(made).toHaveLength(2);
});

test('it closes 60 seconds after its last use, each use starting the 60 again', async () => {
  const { p, made } = pool();
  await p.get('wss://r');
  jest.advanceTimersByTime(HOLD_MS - 1000);
  await p.get('wss://r');
  jest.advanceTimersByTime(HOLD_MS - 1000);
  expect(made[0].closed).toBe(false);
  jest.advanceTimersByTime(1000);
  await Promise.resolve(); // the close itself waits on the connection's promise
  expect(made[0].closed).toBe(true);
  expect(p.size()).toBe(0);
});

test('while held it pings every 20 seconds, and stops when it closes', async () => {
  const { p, made } = pool();
  await p.get('wss://r');
  jest.advanceTimersByTime(PING_MS * 2);
  expect(made[0].pings).toBe(2);
  jest.advanceTimersByTime(HOLD_MS);
  const after = made[0].pings;
  jest.advanceTimersByTime(PING_MS * 3);
  expect(made[0].pings).toBe(after);
});

test('a connection the relay dropped is replaced; a failed connect is not kept', async () => {
  const { p, made, failNext } = pool();
  await p.get('wss://r');
  made[0].drop();
  expect(p.size()).toBe(0);
  const again = await p.get('wss://r');
  expect(again).toBe(made[1]);
  made[1].connected = false;
  await p.get('wss://r');
  expect(made).toHaveLength(3);
  p.close('wss://r');
  failNext(true);
  await expect(p.get('wss://r')).rejects.toThrow('refused');
  expect(p.size()).toBe(0);
  failNext(false);
  expect(await p.get('wss://r')).toBe(made[3]);
});
