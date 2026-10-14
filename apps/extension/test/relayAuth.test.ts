// A browser's wrap goes out on a connection AUTHed as its device key (contract 3.2, F9), through nostr-tools' own Relay
// over a scripted socket: the challenge on connect, late or never, and an AUTH the relay takes or refuses.
import { hexToBytes } from '@noble/hashes/utils.js';
import { useWebSocketImplementation } from 'nostr-tools/relay';
import { verifyEvent } from 'nostr-tools/pure';
import { LocalSigner, type NostrEvent } from '../../../packages/protocol/src/signer';
import { AUTH_WAIT_MS, publish } from '../src/relay';

const device = new LocalSigner(hexToBytes('22'.repeat(32)));

/** How each test's relay behaves, by host: when it sends its challenge (never if undefined), and whether AUTH is taken. */
interface Script { challengeAfter?: number; authOk?: boolean }
const scripts = new Map<string, Script>();
const sockets: FakeSocket[] = [];

class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: ((e: object) => void) | null = null;
  onerror: (() => void) | null = null;
  /** What the client sent, in order, each EVENT marked with the key its connection had AUTHed as when it came. */
  readonly got: { type: string; event: NostrEvent; authed: string | null }[] = [];
  authed: string | null = null;
  readonly script: Script;

  constructor(readonly url: string) {
    this.script = scripts.get(new URL(url).host) ?? {};
    sockets.push(this);
    setTimeout(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
      const after = this.script.challengeAfter;
      if (after !== undefined) setTimeout(() => this.say(['AUTH', `challenge-${this.url}`]), after);
    }, 0);
  }

  send(raw: string) {
    const [type, event] = JSON.parse(raw) as [string, NostrEvent];
    if (type === 'REQ') return this.say(['EOSE', (event as unknown as string)]);
    if (type === 'CLOSE') return;
    this.got.push({ type, event, authed: this.authed });
    if (type === 'AUTH') {
      const ok = this.script.authOk !== false;
      if (ok) this.authed = event.pubkey;
      return this.say(['OK', event.id, ok, ok ? '' : 'restricted: not today']);
    }
    this.say(['OK', event.id, true, '']);
  }

  close() {
    this.readyState = FakeSocket.CLOSED;
  }

  say(msg: unknown[]) {
    setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), 0);
  }
}

useWebSocketImplementation(FakeSocket);

/** A stand-in wrap: the fake relay only reads its id. */
const wrap = (n: number) => ({ id: n.toString(16).padStart(64, '0'), kind: 1059, pubkey: 'ee'.repeat(32), created_at: 1, tags: [], content: '', sig: '00'.repeat(64) }) as NostrEvent;

let n = 0;
/** A relay of its own for each test, since connections are held between saves. */
function relay(script: Script): string {
  const host = `relay-${++n}.example`;
  scripts.set(host, script);
  return `wss://${host}`;
}
const socketOf = (url: string) => sockets.find((s) => s.url.startsWith(url))!;

// every relay goes away at the end, so the pool lets go of its held connections and their timers
afterAll(() => sockets.forEach((s) => (s.close(), s.onclose?.({}))));

test('a wrap goes out after the connection AUTHs as the device, for the relay and its challenge', async () => {
  const url = relay({ challengeAfter: 0 });
  await publish(url, wrap(1), device);
  const s = socketOf(url);
  expect(s.got.map((g) => g.type)).toEqual(['AUTH', 'EVENT']);
  const auth = s.got[0].event;
  expect(verifyEvent(auth as never)).toBe(true);
  expect(auth.kind).toBe(22242);
  expect(auth.pubkey).toBe(device.pubkey());
  expect(auth.tags).toContainEqual(['challenge', `challenge-${s.url}`]);
  expect(auth.tags.find((t) => t[0] === 'relay')?.[1]).toMatch(url);
  expect(s.got[1].authed).toBe(device.pubkey());
});

test('a challenge that comes a moment after connecting is waited for', async () => {
  const url = relay({ challengeAfter: 200 });
  await publish(url, wrap(2), device);
  expect(socketOf(url).got.map((g) => [g.type, g.authed])).toEqual([['AUTH', null], ['EVENT', device.pubkey()]]);
});

test('a held connection AUTHs once, and the next save goes at once', async () => {
  const url = relay({ challengeAfter: 0 });
  await publish(url, wrap(3), device);
  const started = Date.now();
  await publish(url, wrap(4), device);
  expect(Date.now() - started).toBeLessThan(AUTH_WAIT_MS / 2);
  expect(socketOf(url).got.map((g) => g.type)).toEqual(['AUTH', 'EVENT', 'EVENT']);
  expect(sockets.filter((s) => s.url.startsWith(url))).toHaveLength(1);
});

test('a relay that sends no challenge costs one wait, then saves go unAUTHed', async () => {
  const url = relay({});
  const started = Date.now();
  await publish(url, wrap(5), device);
  const waitedFor = Date.now() - started;
  expect(waitedFor).toBeGreaterThanOrEqual(AUTH_WAIT_MS - 50);
  expect(waitedFor).toBeLessThan(AUTH_WAIT_MS * 2);
  const again = Date.now();
  await publish(url, wrap(6), device);
  expect(Date.now() - again).toBeLessThan(AUTH_WAIT_MS / 2);
  expect(socketOf(url).got.map((g) => [g.type, g.authed])).toEqual([['EVENT', null], ['EVENT', null]]);
});

test('a refused AUTH stops nothing: the wrap goes as an unAUTHed one would', async () => {
  const url = relay({ challengeAfter: 0, authOk: false });
  await publish(url, wrap(7), device);
  await publish(url, wrap(8), device);
  expect(socketOf(url).got.map((g) => [g.type, g.authed])).toEqual([['AUTH', null], ['EVENT', null], ['EVENT', null]]);
});

test('without the device key nothing is AUTHed (an Undo’s kind 5)', async () => {
  const url = relay({ challengeAfter: 0 });
  await publish(url, wrap(9));
  expect(socketOf(url).got.map((g) => g.type)).toEqual(['EVENT']);
});
