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
