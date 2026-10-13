import { LocalSigner, nobleSecp, verifyEventWith, type Signer } from '@kefli/protocol';
import { RelayPool } from '../src/net/pool';

// AUTH that fails (F13): a relay that challenges on connect and closes every REQ with auth-required until it is
// authenticated, as Kefli's own strfry does for kind 1059 reads, and refuses every EVENT the same way.
const verify = (e: Parameters<typeof verifyEventWith>[1]) => verifyEventWith(nobleSecp, e);
const sockets: Relay[] = [];

class Relay {
  static OPEN = 1;
  onopen: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  readyState = 0;
  authed = false;
  closed = false;
  constructor(readonly url: string) {
    sockets.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.onopen?.();
      this.msg(['AUTH', `challenge-${sockets.length}`]);
    }, 0);
  }
  msg(m: unknown) {
    this.onmessage?.({ data: JSON.stringify(m) });
  }
  send(raw: string) {
    const m = JSON.parse(raw);
    if (m[0] === 'AUTH') {
      this.authed = true;
      setTimeout(() => this.msg(['OK', m[1].id, true, '']), 0);
    }
    if (m[0] === 'EVENT') setTimeout(() => this.msg(['OK', m[1].id, this.authed, this.authed ? '' : 'auth-required: who are you']), 0);
    if (m[0] === 'REQ') setTimeout(() => this.msg(this.authed ? ['EOSE', m[1]] : ['CLOSED', m[1], 'auth-required: who are you']), 0);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
}

const good = new LocalSigner(new Uint8Array(32).fill(7), nobleSecp);
/** A signer whose answers come from script, in turn: 'fail' throws as an out-of-sight refusal does, 'hang' never answers. */
function scripted(...script: ('fail' | 'hang' | 'sign')[]) {
  const asked = { n: 0 };
  const signer = {
    pubkey: () => good.pubkey(),
    signEvent: async (t: Parameters<Signer['signEvent']>[0]) => {
      const step = script[asked.n++] ?? 'sign';
      if (step === 'fail') throw Object.assign(new Error('background'), { code: 'background' });
      if (step === 'hang') return new Promise<never>(() => undefined);
      return good.signEvent(t);
    },
  } as unknown as Signer;
  return { signer, asked };
}

const pending = Symbol('pending');
const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<typeof pending>((ok) => setTimeout(() => ok(pending), ms))]);
const inbox = [{ kinds: [1059] }];

describe('AUTH that fails lets go of the connection (F13)', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    sockets.length = 0;
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  test('a challenge on connect asks nothing of the signer', async () => {
    const { signer, asked } = scripted();
    const pool = new RelayPool({ verify, signer: async () => signer, WebSocket: Relay as unknown as typeof WebSocket });
    await pool.relay('wss://op.example');
    await new Promise((r) => setTimeout(r, 20));
    expect(asked.n).toBe(0);
    pool.close();
  });

  test('a signer that refuses fails the query at once, and the next one connects afresh and is answered', async () => {
    const { signer, asked } = scripted('fail');
    const pool = new RelayPool({ verify, signer: async () => signer, WebSocket: Relay as unknown as typeof WebSocket });
    const first = await within(pool.query('wss://op.example', inbox, 500).catch((e: Error) => e.message), 2000);
    expect(first).toBe('background');
    expect(sockets[0].closed).toBe(true);
    expect(await within(pool.query('wss://op.example', inbox, 500), 2000)).toEqual([]);
    expect(sockets).toHaveLength(2);
    expect(asked.n).toBe(2);
    pool.close();
  });

  test('a signer that never answers fails at the AUTH timeout, for every caller waiting on it', async () => {
    const { signer, asked } = scripted('hang');
    const note = await good.signEvent({ kind: 1, created_at: 1, tags: [], content: '' });
    const pool = new RelayPool({ verify, signer: async () => signer, WebSocket: Relay as unknown as typeof WebSocket, authTimeoutMs: 300 });
    const a = pool.query('wss://op.example', inbox, 500).catch((e: Error) => e.message);
    const b = pool.publish('wss://op.example', note).catch((e: Error) => e.message);
    expect(await within(a, 2000)).toBe('timeout');
    expect(await within(b, 2000)).toBe('timeout');
    // one connection and one AUTH, shared by both
    expect(sockets).toHaveLength(1);
    expect(asked.n).toBe(1);
    expect(sockets[0].closed).toBe(true);
    pool.close();
  });

  test('the socket closing while the signer is asked fails the waiter too', async () => {
    const { signer } = scripted('hang');
    const pool = new RelayPool({ verify, signer: async () => signer, WebSocket: Relay as unknown as typeof WebSocket });
    const q = pool.query('wss://op.example', inbox, 500).catch((e: Error) => e.message);
    await new Promise((r) => setTimeout(r, 30));
    sockets[0].close();
    expect(await within(q, 2000)).toBe('relay connection closed');
    pool.close();
  });

  test('with no signer at all, the query fails rather than waits', async () => {
    const pool = new RelayPool({ verify, signer: async () => null, WebSocket: Relay as unknown as typeof WebSocket });
    expect(await within(pool.query('wss://op.example', inbox, 500).catch((e: Error) => e.message), 2000)).toBe('no signer for AUTH');
    pool.close();
  });

  test('a live watch whose AUTH fails is a drop', async () => {
    const { signer } = scripted('fail');
    const pool = new RelayPool({ verify, signer: async () => signer, WebSocket: Relay as unknown as typeof WebSocket });
    const dropped = new Promise<string>((ok) => void pool.watch('wss://op.example', inbox, () => undefined, () => ok('dropped')));
    expect(await within(dropped, 2000)).toBe('dropped');
    pool.close();
  });
});
