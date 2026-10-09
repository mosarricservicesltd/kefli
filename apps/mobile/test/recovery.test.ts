import { LocalSigner, buildRelayList } from '@shelf/protocol';
import { nodeCrypto } from '@shelf/protocol/node';
import { findShelf, type FindPorts } from '../src/services/recovery';

const D = { operator: { relay: 'ws://op' }, relays: ['ws://a'], indexer: ['ws://idx'] };

async function world() {
  const s = new LocalSigner(nodeCrypto.randomBytes(32));
  const item = await s.signEvent({ kind: 30078, created_at: 1, tags: [['d', 'kefli/item/' + 'ab'.repeat(32)], ['t', 'kefli']], content: 'x' });
  const devices = await s.signEvent({ kind: 30078, created_at: 1, tags: [['d', 'kefli/devices'], ['t', 'kefli']], content: 'x' });
  const list = await buildRelayList(s, [{ url: 'ws://moved', read: true, write: true }], 1);
  const held: Record<string, unknown[]> = {};
  const down = new Set<string>();
  const asked: string[] = [];
  const p: FindPorts = {
    defaults: D,
    query: async (relay, filters) => {
      asked.push(`${relay} ${filters[0].kinds[0]}`);
      if (down.has(relay)) throw new Error('down');
      return (held[relay] ?? []).filter((e) => (e as { kind: number }).kind === filters[0].kinds[0]) as never;
    },
  };
  return { s, item, devices, list, held, down, asked, p };
}

describe('the recovery code’s first pass (mobile spec 5.3, contract 8)', () => {
  test('a save on any default relay is found', async () => {
    const w = await world();
    w.held['ws://a'] = [w.item];
    expect(await findShelf(w.p, w.s.pubkey())).toBe('found');
  });

  test('a shelf whose relays moved is found through its 10002', async () => {
    const w = await world();
    w.held['ws://idx'] = [w.list];
    w.held['ws://moved'] = [w.item];
    expect(await findShelf(w.p, w.s.pubkey())).toBe('found');
    expect(w.asked).toContain('ws://moved 30078');
  });

  test('nothing saved is none; only a devices record is none; nothing reachable is offline', async () => {
    const w = await world();
    expect(await findShelf(w.p, w.s.pubkey())).toBe('none');
    w.held['ws://op'] = [w.devices];
    expect(await findShelf(w.p, w.s.pubkey())).toBe('none');
    for (const r of ['ws://op', 'ws://a', 'ws://idx']) w.down.add(r);
    expect(await findShelf(w.p, w.s.pubkey())).toBe('offline');
  });
});
