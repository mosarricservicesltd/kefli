// The background joined to a browser played by fakes (bg.ts): a page whose capture never returns, a shortcut press on a
// page too busy to answer, a second press while a page is still being read, a page where no toast can run, and the look
// for a move before each save. The browser is offline here, so nothing reaches the network; each save ends in the queue,
// which is what the tests read.
import { hexToBytes } from '@noble/hashes/utils.js';
import { LocalSigner } from '../../../packages/protocol/src/signer';
import type { Defaults } from '../src/defaults';
import type { Queued } from '../src/queue';
import type { Pairing } from '../src/store';
import type { ToastState } from '../src/toastCopy';

const NOW = Math.floor(Date.now() / 1000);
const user = new LocalSigner(hexToBytes('11'.repeat(32)));
const DEFAULTS: Defaults = { v: 1, operator: { relay: 'wss://relay.example', blossom: 'https://blossom.example', api: 'https://api.example' }, relays: [], mirrors: [] };
const PAIRING: Pairing = { v: 1, user_pubkey: user.pubkey(), write_relays: [], blossom_servers: [], token: 'ab'.repeat(32), label: 'Chrome on a Mac', paired_at: NOW };
const PAGE = { url: 'https://example.com/a', canonical: null, hero: null, title: 'A page', site: null, byline: null, lang: 'en', html: '<p>Hello there</p>' };
const TAB = { id: 7, url: 'https://example.com/a' } as chrome.tabs.Tab;

type Listener = (...args: never[]) => unknown;
type Injection = { target: { tabId: number }; files?: string[]; func?: (...a: never[]) => unknown; args?: unknown[] };
/** How the tab answers an injection: the capture, the toast and the shortcut's reach, each by what it runs. */
type Page = (what: 'capture' | 'toast' | 'reach' | 'files', i: Injection) => Promise<unknown>;

function area() {
  const data = new Map<string, unknown>();
  const copy = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    data,
    async get(k: string | null) {
      return k === null ? Object.fromEntries(data) : { [k]: copy(data.get(k)) };
    },
    async set(o: Record<string, unknown>) {
      for (const [k, v] of Object.entries(o)) data.set(k, copy(v));
    },
    async remove(k: string) {
      data.delete(k);
    },
    async clear() {
      data.clear();
    },
  };
}

/** What a test changes in the background's world: when the last whole look began, and the relay's read of the wraps. */
interface World {
  movesChecked?: number;
  fetchWraps?: (url: string, device: unknown, since: number, until?: number) => Promise<unknown>;
}

/** The browser bg.ts runs in, with the page it is given, and the background loaded fresh into it. */
function browser(page: Page, w: World = {}) {
  const on: Record<string, Listener> = {};
  const event = (name: string) => ({ addListener: (f: Listener) => void (on[name] = f) });
  const local = area();
  const session = area();
  const popups = { opened: 0 };
  const injections: string[] = [];
  void local.set({ pairing: PAIRING, defaults: DEFAULTS, movesChecked: w.movesChecked ?? NOW + 3600 });
  const g = globalThis as Record<string, unknown>;
  Object.assign(g, { KEFLI_DEFAULTS_URL: 'https://kefli.example/defaults.json', KEFLI_FLAVOUR: 'beta', KEFLI_BROWSER: 'chrome', KEFLI_COMMIT: 'test' });
  g.self = { addEventListener: () => undefined };
  g.fetch = async () => new Response(JSON.stringify(DEFAULTS), { status: 200 });
  Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
  g.chrome = {
    contextMenus: { removeAll: (done?: () => void) => done?.(), create: () => undefined, onClicked: event('menu') },
    runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'), openOptionsPage: async () => undefined },
    storage: { local, session, onChanged: event('changed') },
    alarms: { create: async () => undefined, get: async () => undefined, clear: async () => true, onAlarm: event('alarm') },
    action: {
      setBadgeBackgroundColor: async () => undefined, setBadgeText: async () => undefined, setTitle: async () => undefined, setPopup: async () => undefined,
      openPopup: async () => void popups.opened++, onClicked: event('clicked'),
    },
    commands: { getAll: async () => [], onCommand: event('command') },
    scripting: {
      async executeScript(i: Injection) {
        const what = i.files ? 'files' : String(i.func).includes('kefliCapture') ? 'capture' : String(i.func).includes('reach') ? 'reach' : 'toast';
        injections.push(what);
        return [{ result: await page(what, i) }];
      },
    },
  };
  jest.isolateModules(() => {
    if (w.fetchWraps) jest.doMock('../src/relay', () => ({ ...jest.requireActual('../src/relay'), fetchWraps: w.fetchWraps }));
    require('../src/bg');
  });
  jest.dontMock('../src/relay');
  const queue = async () => ((await local.get('queue')).queue as Queued[] | undefined) ?? [];
  const popup = async () => ((await session.get('popup')).popup as ToastState | null | undefined)?.kind ?? null;
  return { on, local, session, popups, injections, queue, popup };
}

const never = () => new Promise<never>(() => undefined);
/** Lets the background's storage, crypto and timers run, a little at a time, until a condition holds. */
async function until(ok: () => Promise<boolean>, ms = 60_000): Promise<void> {
  for (let waited = 0; waited < ms && !(await ok()); waited += 50) await jest.advanceTimersByTimeAsync(50);
}

// fake time runs the waits; a loaded machine may still take a while over the crypto and the storage
jest.setTimeout(60_000);
beforeEach(() => jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick', 'setImmediate'] }));
afterEach(() => jest.useRealTimers());

test('a page whose capture never returns is saved as its address alone, through the popup', async () => {
  const b = browser(async (what) => (what === 'capture' ? never() : undefined));
  b.on.clicked(TAB as never);
  await until(async () => (await b.popup()) === 'offline');
  expect(await b.popup()).toBe('offline');
  expect(b.popups.opened).toBeGreaterThan(0);
  expect(await b.queue()).toMatchObject([{ why: 'offline', blob: null }]);
});

test('a shortcut press on a page too busy to answer still saves', async () => {
  const b = browser(async (what) => (what === 'files' ? undefined : never()));
  b.on.command('save-page' as never, TAB as never);
  await until(async () => (await b.queue()).length > 0);
  expect(await b.queue()).toHaveLength(1);
  expect(await b.popup()).toBe('offline');
});

test('a second press while the page is still being read is that save, not a second', async () => {
  let release!: (c: unknown) => void;
  const read = new Promise((r) => (release = r));
  const shown: string[] = [];
  const b = browser(async (what, i) => {
    if (what === 'capture') return read;
    if (what === 'toast') shown.push((i.args![0] as ToastState).kind);
    return what === 'toast' ? true : undefined;
  });
  b.on.clicked(TAB as never);
  await jest.advanceTimersByTimeAsync(100);
  b.on.clicked(TAB as never);
  await jest.advanceTimersByTimeAsync(100);
  release(PAGE);
  await until(async () => (await b.queue()).length > 0 && shown.includes('offline'));
  await jest.advanceTimersByTimeAsync(1000);
  expect(b.injections.filter((w) => w === 'capture')).toHaveLength(1);
  expect(await b.queue()).toHaveLength(1);
  expect(shown).toEqual(['saving', 'offline']);
});

test('a page where no toast can run shows the popup instead, so even a refusal is heard', async () => {
  const b = browser(async (what) => {
    if (what === 'capture') return PAGE;
    if (what === 'toast') throw new Error('Failed to execute attachShadow: This element does not support attachShadow');
    return undefined;
  });
  b.on.clicked(TAB as never);
  await until(async () => (await b.popup()) === 'offline');
  expect(await b.popup()).toBe('offline');
  expect(b.popups.opened).toBeGreaterThan(0);
  // with eight already waiting, the ninth is refused, and the popup says so
  for (let i = 0; i < 8; i++) {
    b.on.clicked({ ...TAB, id: 100 + i, url: `https://example.com/${i}` } as never);
    await until(async () => (await b.queue()).length === i + 2, 20_000);
  }
  await until(async () => (await b.popup()) === 'full');
  expect(await b.popup()).toBe('full');
});

test('a look kept from its whole window, the relay slow to finish its answer, still waits its five minutes before a save looks again', async () => {
  // the relay never finishes its answer within the look's ten seconds, so the window stays unread (move.ts lookForMove)
  const looks: number[] = [];
  const b = browser(async (what) => (what === 'capture' ? PAGE : what === 'toast' ? true : undefined), {
    movesChecked: NOW - 3600,
    fetchWraps: async (_url, _device, since) => (looks.push(since), { events: [], whole: false, full: false, why: 'timeout' }),
  });
  b.on.clicked(TAB as never);
  await until(async () => (await b.queue()).length === 1);
  expect(looks).toHaveLength(1);
  // a minute on, another save: read from the last whole look alone, it looked again, and waited on the relay first
  await jest.advanceTimersByTimeAsync(60_000);
  b.on.clicked({ ...TAB, id: 8, url: 'https://example.com/b' } as never);
  await until(async () => (await b.queue()).length === 2);
  expect(looks).toHaveLength(1);
  // past five minutes from the look, a save looks again, from the same place, since none read the window whole
  await jest.advanceTimersByTimeAsync(5 * 60_000);
  b.on.clicked({ ...TAB, id: 9, url: 'https://example.com/c' } as never);
  await until(async () => (await b.queue()).length === 3);
  expect(looks).toEqual([NOW - 3600 - 172_800 - 300, NOW - 3600 - 172_800 - 300]);
});
