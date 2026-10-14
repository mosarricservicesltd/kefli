// A share's save (mobile spec 5.4, contract 4.1): two shares of one link at once, as two sheets or the start-up pickup
// and a sheet run them, must agree on which one made the save, so the second's Undo never takes the first's away.
import { LocalSigner } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import type { SqlDb } from '../src/data/db';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow, undoSave } from '../src/data/saves';
import type { PagePorts } from '../src/services/page';
import { memoryDb } from './sqlite';

const mockWorld = {} as { db: SqlDb; page: PagePorts; signer: LocalSigner };
const mockDefaults = {
  v: 1, operator: { relay: 'wss://op.example', blossom: 'https://blossom.example', api: 'https://api.example' },
  relays: ['wss://a.example', 'wss://b.example'], indexer: ['wss://idx.example'], mirrors: ['https://m1.example'],
};

jest.mock('../src/services/pagePorts', () => ({ phonePagePorts: () => mockWorld.page }));
jest.mock('../src/crypto/port', () => ({ phoneCrypto: jest.requireActual('@kefli/protocol/node').nodeCrypto }));
jest.mock('../src/services/config', () => ({ loadDefaults: async () => mockDefaults }));
jest.mock('../src/services/identity', () => ({ ensureSigner: async () => mockWorld.signer }));
jest.mock('../src/services/staging', () => ({ stageBlob: (sha: string) => `/staged/${sha}` }));
jest.mock('../src/services/textFiles', () => ({ textFiles: { writeText: () => undefined } }));
jest.mock('../src/services/store', () => ({ store: () => mockWorld.db }));

// eslint-disable-next-line import/first
import { saveLink } from '../src/services/save';

const URL_A = 'https://news.example/story';
const WORDS = `${Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ')}\n`;

/** A page whose fetch waits until open() is called, so two shares can both be fetching it at once. */
function gatedPage(readable: boolean): { page: PagePorts; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const page: PagePorts = {
    fetch: (async (url: string) => {
      await gate;
      const res = readable
        ? new Response('<article><p>x</p></article>', { status: 200, headers: { 'content-type': 'text/html' } })
        : new Response('gone', { status: 404, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as never,
    parse: async () => ({ ok: true, title: 'A story', byline: null, site: 'News', lang: 'en', hero: null, canonical: null, readerable: true, markdown: WORDS }),
  };
  return { page, open };
}

function setUp(): string {
  mockWorld.db = memoryDb();
  migrate(mockWorld.db);
  mockWorld.signer = new LocalSigner(nodeCrypto.randomBytes(32));
  const owner = mockWorld.signer.pubkey();
  ensureIdentityRow(mockWorld.db, 1, owner, 'new', true);
  return owner;
}

async function twice(readable: boolean) {
  const owner = setUp();
  const { page, open } = gatedPage(readable);
  mockWorld.page = page;
  const a = saveLink(URL_A, () => undefined);
  const b = saveLink(URL_A, () => undefined);
  await new Promise((r) => setTimeout(r, 20));
  open();
  const [first, second] = await Promise.all([a, b]);
  return { owner, first, second };
}

describe('two shares of one link at once (G2, FD 89)', () => {
  test('a page that can’t be read: the second is a repeat, and its Undo leaves the first', async () => {
    const { owner, first, second } = await twice(false);
    expect(first).toMatchObject({ kind: 'saved', prior: null });
    expect(first.held.length).toBeGreaterThan(0);
    expect(second).toMatchObject({ kind: 'again', held: [], prior: { state: 'unread' } });
    undoSave(mockWorld.db, owner, second.hash!, second.held, second.prior);
    expect(mockWorld.db.all('SELECT url, text_state FROM items')).toEqual([{ url: URL_A, text_state: 'failed' }]);
    expect(mockWorld.db.all("SELECT op FROM outbox WHERE state = 'held'")).toEqual([{ op: 'publish_item' }]);
  });

  test('a page that parses: the second is a repeat, and its Undo leaves the first, its text and its sends', async () => {
    const { owner, first, second } = await twice(true);
    expect(first).toMatchObject({ kind: 'saved', prior: null, title: 'A story' });
    expect(second).toMatchObject({ kind: 'again', held: [], prior: { state: 'unread' } });
    undoSave(mockWorld.db, owner, second.hash!, second.held, second.prior);
    expect(mockWorld.db.all('SELECT url, text_state, title FROM items')).toEqual([{ url: URL_A, text_state: 'cached', title: 'A story' }]);
    expect(mockWorld.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM blobs')!.n).toBe(1);
    expect(mockWorld.db.all("SELECT op FROM outbox WHERE state = 'held' ORDER BY id").map((r) => (r as { op: string }).op))
      .toEqual(['upload_blob', 'mirror_blob', 'publish_item']);
  });

  test('one share alone is a new save, and its Undo takes it away', async () => {
    const owner = setUp();
    const { page, open } = gatedPage(true);
    mockWorld.page = page;
    open();
    const r = await saveLink(URL_A, () => undefined);
    expect(r).toMatchObject({ kind: 'saved', prior: null });
    undoSave(mockWorld.db, owner, r.hash!, r.held, r.prior);
    expect(mockWorld.db.all('SELECT 1 FROM items')).toEqual([]);
  });
});
