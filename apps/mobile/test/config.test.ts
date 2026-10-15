import { ANSWER_MAX_BYTES } from '../src/net/http';
import { freshState, pickDefaults, validDefaults, type Defaults, type DefaultsPorts } from '../src/services/defaultsPick';

const mk = (api: string): Defaults => ({
  v: 1, operator: { relay: 'wss://relay.x', blossom: 'https://blossom.x', api }, relays: ['wss://a', 'wss://b'], indexer: ['wss://i'], mirrors: ['https://m'],
});
const BAKED = mk('https://baked');
const FRESH = mk('https://fresh');

function ports(answer: () => Promise<Response>, kept: string | null = null) {
  let clock = 1_000_000;
  let store = kept;
  let calls = 0;
  const p: DefaultsPorts = {
    url: 'https://api.x/defaults.json', baked: BAKED, now: () => clock,
    fetch: (async () => (calls++, answer())) as unknown as typeof fetch,
    read: () => store, write: (j) => (store = j),
  };
  return { p, tick: (ms: number) => (clock += ms), calls: () => calls, kept: () => store };
}
const ok = (d: unknown) => async () => new Response(JSON.stringify(d), { status: 200 });
const down = async (): Promise<Response> => { throw new Error('unreachable'); };

describe('defaults.json (contract 3.1, F1)', () => {
  test('a fresh copy is used and kept, and fetched again only after a day', async () => {
    const w = ports(ok(FRESH));
    const s = freshState();
    expect(await pickDefaults(w.p, s)).toEqual(FRESH);
    expect(JSON.parse(w.kept()!)).toEqual(FRESH);
    w.tick(3_600_000);
    await pickDefaults(w.p, s);
    expect(w.calls()).toBe(1);
    w.tick(86_400_000);
    await pickDefaults(w.p, s);
    expect(w.calls()).toBe(2);
  });

  test('with the operator unreachable: the kept copy, else the baked one, never a throw', async () => {
    expect(await pickDefaults(ports(down, JSON.stringify(FRESH)).p, freshState())).toEqual(FRESH);
    expect(await pickDefaults(ports(down).p, freshState())).toEqual(BAKED);
    expect(await pickDefaults(ports(async () => new Response('nope', { status: 503 })).p, freshState())).toEqual(BAKED);
  });

  test('a copy that doesn’t parse as contract 3.1 says is ignored, fetched or kept', async () => {
    expect(await pickDefaults(ports(ok({ v: 1, operator: { relay: 'x' } }), '{"v":2}').p, freshState())).toEqual(BAKED);
    expect(validDefaults({ ...FRESH, relays: ['wss://only-one'] })).toBe(false);
  });

  test('after a failure it waits five minutes before trying again', async () => {
    const w = ports(down);
    const s = freshState();
    await pickDefaults(w.p, s);
    await pickDefaults(w.p, s);
    expect(w.calls()).toBe(1);
    w.tick(300_000);
    await pickDefaults(w.p, s);
    expect(w.calls()).toBe(2);
  });

  test('with nothing fetched, kept or baked it says so', async () => {
    const w = ports(down);
    await expect(pickDefaults({ ...w.p, baked: null }, freshState())).rejects.toThrow('no defaults');
  });
});

describe('defaults.json is asked as a server is: hops by hand, a deadline over its body, a cap (net/http serverFetch)', () => {
  afterEach(() => jest.useRealTimers());
  type Route = { status?: number; location?: string; body?: BodyInit };
  /**
   * A fetch over routes that follows a redirect itself, as OkHttp's own following did, unless asked for
   * redirect: 'manual', when it hands back the 3xx. Every address asked is recorded, with how.
   */
  function web(routes: Record<string, Route>) {
    const asked: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit = {}) => {
      let at = url;
      for (;;) {
        asked.push({ url: at, init });
        const r = routes[at];
        if (!r) throw new Error('unknown host');
        if (!r.location || init.redirect === 'manual') {
          return new Response(r.body ?? null, { status: r.status ?? 200, headers: r.location ? { location: r.location } : {} });
        }
        at = new URL(r.location, at).href;
      }
    }) as unknown as typeof fetch;
    return { f, asked, urls: () => asked.map((a) => a.url) };
  }
  const at = (url: string, f: typeof fetch, localStack?: boolean): DefaultsPorts => ({
    url, baked: BAKED, now: () => 1_000_000, fetch: f, read: () => null, write: () => undefined, ...(localStack === undefined ? {} : { localStack }),
  });

  test("asked without cookies, its redirects followed by hand: one into the phone's own network is never asked", async () => {
    const w = web({
      'https://api.x/defaults.json': { status: 302, location: 'http://192.168.1.1/defaults.json' },
      'http://192.168.1.1/defaults.json': { body: JSON.stringify(FRESH) },
    });
    // followed as OkHttp followed it, whatever answered at 192.168.1.1 named the phone's servers, with the jar's cookies
    expect(await pickDefaults(at('https://api.x/defaults.json', w.f), freshState())).toEqual(BAKED);
    expect(w.urls()).toEqual(['https://api.x/defaults.json']);
    expect([w.asked[0].init.credentials, w.asked[0].init.redirect]).toEqual(['omit', 'manual']);
  });

  test('a public redirect is followed, as OkHttp followed it; one to loopback only on the local stack', async () => {
    const cdn = web({ 'https://api.x/defaults.json': { status: 301, location: 'https://cdn.x/d.json' }, 'https://cdn.x/d.json': { body: JSON.stringify(FRESH) } });
    expect(await pickDefaults(at('https://api.x/defaults.json', cdn.f), freshState())).toEqual(FRESH);
    const routes = {
      'http://localhost:8447/defaults.json': { status: 307, location: 'http://127.0.0.1:8447/v1/defaults.json' },
      'http://127.0.0.1:8447/v1/defaults.json': { body: JSON.stringify(FRESH) },
    };
    for (const localStack of [true, false]) {
      const w = web(routes);
      expect([localStack, await pickDefaults(at('http://localhost:8447/defaults.json', w.f, localStack), freshState())]).toEqual([localStack, localStack ? FRESH : BAKED]);
      expect([localStack, w.asked.length]).toEqual([localStack, localStack ? 2 : 1]);
    }
  });

  test("a body that doesn't end is refused at an answer's cap as it streams, never read whole", async () => {
    const CHUNK = 65_536;
    let pulls = 0;
    // 8 MB of it, handed out as fast as it is read
    const stream = new ReadableStream<Uint8Array>({
      pull: (c) => void (pulls++ === 128 ? c.close() : c.enqueue(new Uint8Array(CHUNK).fill(32))),
    }, { highWaterMark: 0 });
    const f = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    expect(await pickDefaults(at('https://api.x/defaults.json', f), freshState())).toEqual(BAKED);
    expect(pulls * CHUNK).toBeLessThanOrEqual(ANSWER_MAX_BYTES + 2 * CHUNK);
  });

  test('a body that stalls after its headers is given up at ten seconds, by a fetch that pays its abort no heed', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
    const stalled = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode('{"v":1,')) });
    const f = (async () => new Response(stalled, { status: 200 })) as unknown as typeof fetch;
    const s = freshState();
    let got: Defaults | null = null;
    void pickDefaults(at('https://api.x/defaults.json', f), s).then((d) => (got = d));
    await jest.advanceTimersByTimeAsync(9_000);
    expect(got).toBeNull();
    await jest.advanceTimersByTimeAsync(2_000);
    // the baked copy serves, and the ask isn't left under way, which every later ask would wait on
    expect([got, s.inflight]).toEqual([BAKED, null]);
  });
});
