// A browser's wrap goes out on a connection AUTHed as its device key (contract 3.2, F9), through nostr-tools' own Relay
// over a scripted socket: the challenge on connect, late or never, and an AUTH the relay takes or refuses. Then a relay
// that misbehaves: one that never answers, a challenge nostr-tools can't sign, a flood of wraps, an odd CLOSED.
import { hexToBytes } from '@noble/hashes/utils.js';
import { useWebSocketImplementation } from 'nostr-tools/relay';
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { LocalSigner, type NostrEvent } from '../../../packages/protocol/src/signer';
import { listenForAck } from '../src/pair';
import { AUTH_WAIT_MS, authAs, fetchWraps, publish, PUBLISH_TIMEOUT_MS, WRAPS_MAX } from '../src/relay';

const device = new LocalSigner(hexToBytes('22'.repeat(32)));

/**
 * How each test's relay behaves, by host: when it sends its challenge (never if undefined) and what it is, whether AUTH
 * is taken, whether its first connection answers no EVENT, and what it says to a REQ (EOSE alone if nothing is set).
 */
interface Script { challengeAfter?: number; challenge?: unknown; authOk?: boolean; firstSilent?: boolean; neverOpens?: boolean; onReq?: (s: FakeSocket, sub: string) => void }
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

  /** The first connection to a relay scripted firstSilent answers no EVENT. */
  readonly silent: boolean;

  constructor(readonly url: string) {
    this.script = scripts.get(new URL(url).host) ?? {};
    this.silent = !!this.script.firstSilent && !sockets.some((s) => s.url === url);
    sockets.push(this);
    if (this.script.neverOpens) return;
    setTimeout(() => {
      this.readyState = FakeSocket.OPEN;
      this.onopen?.();
      const after = this.script.challengeAfter;
      if (after !== undefined) setTimeout(() => this.say(['AUTH', 'challenge' in this.script ? this.script.challenge : `challenge-${this.url}`]), after);
    }, 0);
  }

  send(raw: string) {
    const [type, event] = JSON.parse(raw) as [string, NostrEvent];
    if (type === 'REQ') return (this.script.onReq ?? ((s, sub) => s.say(['EOSE', sub])))(this, event as unknown as string);
    if (type === 'CLOSE') return;
    this.got.push({ type, event, authed: this.authed });
    if (type === 'AUTH') {
      const ok = this.script.authOk !== false;
      if (ok) this.authed = event.pubkey;
      return this.say(['OK', event.id, ok, ok ? '' : 'restricted: not today']);
    }
    if (!this.silent) this.say(['OK', event.id, true, '']);
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

describe('a relay that misbehaves', () => {
  const socketsOf = (url: string) => sockets.filter((s) => s.url.startsWith(url));
  const sender = hexToBytes('33'.repeat(32));
  /** A real wrap addressed to the device, which nostr-tools' signature check passes. */
  const wrapTo = (i: number) => finalizeEvent({ kind: 1059, created_at: 1_791_600_000 + i, tags: [['p', device.pubkey()]], content: `wrap ${i}` }, sender) as NostrEvent;

  test('a connection that never answers a wrap is let go, so the next save connects afresh', async () => {
    const url = relay({ firstSilent: true });
    await expect(publish(url, wrap(20))).rejects.toThrow(/timed out|timeout/);
    await publish(url, wrap(21));
    expect(socketsOf(url)).toHaveLength(2);
    expect(socketsOf(url)[1].got.map((g) => g.event.id)).toEqual([wrap(21).id]);
  }, 20_000);

  test('an AUTH that never settles costs one wait: later saves on the connection go at once', async () => {
    const stuck = { auth: () => new Promise<string>(() => undefined) };
    let started = Date.now();
    expect(await authAs(stuck, device, 0, 500)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
    started = Date.now();
    expect(await authAs(stuck, device, 0, 500)).toBe(false);
    expect(Date.now() - started).toBeLessThan(250);
  });

  test('a challenge nostr-tools can’t sign holds the first save on a connection once, and the wrap still goes', async () => {
    const url = relay({ challengeAfter: 0, challenge: { not: 'a string' } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await publish(url, wrap(22), device);
    const again = Date.now();
    await publish(url, wrap(23), device);
    warn.mockRestore();
    expect(Date.now() - again).toBeLessThan(AUTH_WAIT_MS);
    expect(socketOf(url).got.map((g) => [g.type, g.authed])).toEqual([['EVENT', null], ['EVENT', null]]);
  }, 20_000);

  test('the same wrap sent five thousand times is kept once, without checking each copy', async () => {
    const w = wrapTo(1);
    const url = relay({
      onReq: (s, sub) => {
        for (let i = 0; i < 5000; i++) s.say(['EVENT', sub, w]);
        s.say(['EOSE', sub]);
      },
    });
    const started = Date.now();
    expect((await fetchWraps(url, device, 0)).map((e) => e.id)).toEqual([w.id]);
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 30_000);

  test('a flood of wraps is read only as far as WRAPS_MAX', async () => {
    const flood = Array.from({ length: WRAPS_MAX + 20 }, (_, i) => wrapTo(i + 10));
    const url = relay({
      onReq: (s, sub) => {
        for (const w of flood) s.say(['EVENT', sub, w]);
        s.say(['EOSE', sub]);
      },
    });
    // a slow machine checks fewer signatures before nostr-tools' own wait for EOSE (4.4 s) ends the look; never more
    const got = await fetchWraps(url, device, 0);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThanOrEqual(WRAPS_MAX);
  }, 60_000);

  test('a relay that takes the connection and never opens it is given up on, and the socket closed', async () => {
    const url = relay({ neverOpens: true });
    // nostr-tools rejects with a string, "connection timed out", which delivery reads as unreachable
    await expect(publish(url, wrap(30))).rejects.toBeDefined();
    expect(socketOf(url).readyState).toBe(FakeSocket.CLOSED);
  }, PUBLISH_TIMEOUT_MS + 10_000);

  test('the pairing page’s wait on a relay that never opens ends, so the page can say it can’t connect', async () => {
    const url = relay({ neverOpens: true });
    const started = Date.now();
    await expect(listenForAck(url, device, 'n', 0, () => undefined, () => undefined, 100)).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('a CLOSED whose reason isn’t a string ends the look at once', async () => {
    const url = relay({ onReq: (s, sub) => s.say(['CLOSED', sub, 42]) });
    const started = Date.now();
    expect(await fetchWraps(url, device, 0)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
