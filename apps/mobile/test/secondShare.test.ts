// A share that arrives while the last one is still saving (mobile spec 5.4, 8.5). Found on the Pixel on 16 October
// 2026: nine pages shared from adb fifteen seconds apart, the eighth a Substack page whose save ran through the slow
// browser engine; the ninth never appeared, not even as a pending save. Each `am start` carries NEW_TASK alone, and
// Android's rule for that flag is that a task already rooted at the activity, with a root intent of the same filter
// (SEND, text/plain, ShareActivity), is brought to the front and nothing is started: no onCreate, so no spool, and a
// standard-mode activity has no onNewIntent to receive it. Android's own share sheet adds NEW_DOCUMENT and
// MULTIPLE_TASK, so it never showed this. Node can't run the system: these read the manifest and the Kotlin, as
// spool.test.ts does, play Android's rule over them, and run the sheets' saves as the sheets run them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalSigner } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import type { SqlDb } from '../src/data/db';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import type { PagePorts } from '../src/services/page';
import { kotlinSource } from './kotlin';
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
/** The spool folder, as Spool.kt keeps it: written by onCreate, read by the sheet. */
const mockSpools = new Map<string, string>();
jest.mock('expo-modules-core', () => ({
  requireNativeModule: () => ({
    readSpool: (id: string) => mockSpools.get(id) ?? null,
    deleteSpool: (id: string) => mockSpools.delete(id),
    listSpools: () => [...mockSpools.keys()],
    finish: () => true,
  }),
}), { virtual: true });

// eslint-disable-next-line import/first
import { saveLink, type Queued } from '../src/services/save';
// eslint-disable-next-line import/first
import { activeSpools, sheetLink } from '../src/share/pickup';

const SUBSTACK = 'https://letters.example/p/an-open-letter';
const GUTENBERG = 'https://books.example/files/11/11-h/11-h.htm';
const WORDS = `${Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ')}\n`;

const manifest = readFileSync(join(__dirname, '..', 'modules', 'kefli-share', 'android', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
const activity = kotlinSource('kefli-share', 'share', 'ShareActivity.kt');
const attribute = (name: string) => new RegExp(`android:${name}="([^"]*)"`).exec(manifest)?.[1] ?? null;

type Flag = 'NEW_TASK' | 'NEW_DOCUMENT' | 'MULTIPLE_TASK';
/** A sheet up on the phone: its task, rooted at ShareActivity with a SEND intent, and the save its JavaScript runs. */
type Sheet = { spoolId: string; save: Promise<Queued> };

/**
 * Android starting ShareActivity for a SEND intent, as ActivityStarter reads the manifest. documentLaunchMode
 * "always" adds NEW_DOCUMENT and MULTIPLE_TASK to every launch, and NEW_DOCUMENT puts it in a new task. NEW_TASK
 * without MULTIPLE_TASK looks for a task rooted at the activity whose root intent has the same filter, and every
 * share's has: found, a standard-mode activity is brought to the front and nothing is started (the rule in
 * FLAG_ACTIVITY_NEW_TASK's own documentation, and adb's "Activity not started, its current task has been brought to
 * the front"); singleTop and singleTask would hand the intent to onNewIntent, which only an override can keep.
 * Started, onCreate spools the share and the sheet opens on the spool.
 */
function launch(sent: Flag[], up: Sheet[], text: string): Sheet | 'brought to the front' {
  const flags = new Set(sent);
  if (attribute('documentLaunchMode') === 'always') {
    flags.add('NEW_DOCUMENT');
    flags.add('MULTIPLE_TASK');
  }
  if (flags.has('NEW_DOCUMENT')) flags.add('NEW_TASK');
  const reuses = flags.has('NEW_TASK') && !flags.has('MULTIPLE_TASK') && up.length > 0;
  if (reuses) {
    const mode = attribute('launchMode') ?? 'standard';
    if (mode === 'standard' || !/override fun onNewIntent\(/.test(activity)) return 'brought to the front';
  }
  // onCreate: Spool.write, then the "share" surface on the spool's id
  const spoolId = `spool-${mockSpools.size + 1}`;
  mockSpools.set(spoolId, JSON.stringify({ v: 1, id: spoolId, text, subject: null, referrer: null, receivedAt: Date.now() }));
  // SavedSheet: the spool is its own, and its link's save runs as it rises
  activeSpools.add(spoolId);
  const opened = sheetLink(spoolId);
  if (opened.url === null) throw new Error(`the sheet opened on ${opened.why}`);
  return { spoolId, save: saveLink(opened.url, () => undefined) };
}

/** Pages: one whose fetch waits until open() is called, as the browser engine's 10 to 20 s does, and the rest at once. */
function pages(slow: string): { page: PagePorts; open: () => void } {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const page: PagePorts = {
    fetch: (async (url: string) => {
      if (url === slow) await gate;
      const res = new Response('<article><p>x</p></article>', { status: 200, headers: { 'content-type': 'text/html' } });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as never,
    parse: async (_b: string, _t: string, url: string) => ({ ok: true, title: url === slow ? 'An open letter' : 'Alice', byline: null, site: null, lang: 'en', hero: null, canonical: null, readerable: true, markdown: WORDS }),
  };
  return { page, open };
}

function setUp(): void {
  mockWorld.db = memoryDb();
  migrate(mockWorld.db);
  mockWorld.signer = new LocalSigner(nodeCrypto.randomBytes(32));
  ensureIdentityRow(mockWorld.db, 1, mockWorld.signer.pubkey(), 'new', true);
  mockSpools.clear();
  activeSpools.clear();
}

/** Two shares, the second arriving while the first's page is still being fetched; the saves the phone holds after both. */
async function twoShares(flags: Flag[]): Promise<{ second: Sheet | 'brought to the front'; urls: string[] }> {
  setUp();
  const { page, open } = pages(SUBSTACK);
  mockWorld.page = page;
  const up: Sheet[] = [];
  const first = launch(flags, up, SUBSTACK);
  if (first === 'brought to the front') throw new Error('the first share found no sheet to reuse');
  up.push(first);
  await new Promise((r) => setTimeout(r, 20));
  const second = launch(flags, up, GUTENBERG);
  if (second !== 'brought to the front') up.push(second);
  open();
  await Promise.all(up.map((s) => s.save));
  const urls = mockWorld.db.all('SELECT url FROM items ORDER BY url').map((r) => (r as { url: string }).url);
  return { second, urls };
}

describe('a share that arrives while the last is still saving (5.4, 8.5)', () => {
  test('sent with NEW_TASK alone, as adb and an app starting the sheet itself send it, both are saved', async () => {
    // the ninth of nine shares from adb, sent while the eighth's sheet was still fetching through the browser
    // engine, was never spooled or saved: Android brought the eighth's task to the front and dropped the intent
    const { second, urls } = await twoShares(['NEW_TASK']);
    expect(second).not.toBe('brought to the front');
    expect(urls).toEqual([GUTENBERG, SUBSTACK]);
  });

  test("sent as Android's share sheet sends it, in a task of its own, both are saved, as before", async () => {
    const { urls } = await twoShares(['NEW_TASK', 'NEW_DOCUMENT', 'MULTIPLE_TASK']);
    expect(urls).toEqual([GUTENBERG, SUBSTACK]);
  });

  test('every share opens its own sheet, so a sheet still up never stands in for the next share', () => {
    // the manifest's word for what the share sheet's flags did: a new task for every launch, whatever the sender sends
    expect(attribute('documentLaunchMode')).toBe('always');
    // which Android allows for the standard launch mode alone, the mode Back relies on (flow decision 39)
    expect(attribute('launchMode')).toBe('standard');
  });
});
