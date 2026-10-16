/**
 * @jest-environment jsdom
 */
// The extension's own pages as the DOM they draw: the options page connected and pairing, the browser-page popup and the
// toast, each in its states for a few inputs, serialised and kept as a snapshot. A change to how a page is built (its
// markup strings became elements, for the store's linter) has to keep every element, class, attribute and text as it was.
// Whitespace between tags is folded before comparing, since the markup strings carried their indentation as text.
import { resetSeed } from './pageWorld';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hexToBytes } from '@noble/hashes/utils.js';
import { LocalSigner } from '../../../packages/protocol/src/signer';
import { webCrypto } from '../src/crypto';
import type { Defaults } from '../src/defaults';
import { enqueue } from '../src/queue';
import { prepare } from '../src/save';
import { chromeStore, KEYS, type Pairing } from '../src/store';
import type { ToastState } from '../src/toastCopy';

const g = globalThis as Record<string, unknown>;
const NOW = 1_791_979_200;
const DEVICE_HEX = '22'.repeat(32);
const device = new LocalSigner(hexToBytes(DEVICE_HEX));
const user = new LocalSigner(hexToBytes('11'.repeat(32)));
const DEFAULTS: Defaults = { v: 1, operator: { relay: 'wss://relay.example', blossom: 'https://blossom.example', api: 'https://api.example' }, relays: ['wss://a.example'], mirrors: ['https://m.example'] };
const PAIRING: Pairing = {
  v: 1, user_pubkey: user.pubkey(), write_relays: ['wss://relay.example', 'wss://a.example/', 'wss://mine.example'], blossom_servers: ['https://blossom.example'], token: 'ab'.repeat(32), label: 'Chrome on a “Mac”', paired_at: NOW,
};
const HASH = 'ab'.repeat(32);
const HASH2 = 'cd'.repeat(32);
/** The custom properties the pages read for the cover's line colour; jsdom computes none. */
const COLOURS: Record<string, string> = { '--toast-bg': '#1B1B1B', '--toast-fg': '#F4F4F2', '--surface': '#FFFFFF', '--text': '#1B1B1B' };

type Listener = (...args: never[]) => unknown;

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

/** The browser a page runs in: whether Kefli is on the toolbar, the shortcut, and what the background answers a message. */
function browser(w: { pinned: boolean; shortcut: string | null; answer?: (m: unknown) => Promise<unknown> }) {
  const on: Record<string, Listener> = {};
  const event = (name: string) => ({ addListener: (f: Listener) => void (on[name] = f) });
  const local = area();
  const session = area();
  g.chrome = {
    storage: { local, session: { ...session, onChanged: event('session') }, onChanged: event('changed') },
    action: { getUserSettings: async () => ({ isOnToolbar: w.pinned }) },
    commands: { getAll: async () => (w.shortcut ? [{ name: 'save-page', shortcut: w.shortcut }] : []) },
    runtime: { getManifest: () => ({ version: '1.0.1' }), sendMessage: (m: unknown) => (w.answer ? w.answer(m) : Promise.resolve(undefined)) },
    tabs: { create: async () => undefined },
  };
  return { on, local, session };
}

/** A page's body as its HTML file has it, without the script the build adds. */
const body = (file: string) => readFileSync(join(__dirname, '..', 'src', file), 'utf8').match(/<body>([\s\S]*)<\/body>/)![1].replace(/<script[^>]*><\/script>/g, '');
/** Whitespace between tags folded: the markup strings carried their indentation as text nodes. */
const html = (s: string) => s.replace(/>\s+</g, '><').trim();
const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
/** Lets the page's storage and crypto run until a condition holds. */
async function until(ok: () => boolean, ms = 30_000): Promise<void> {
  for (let waited = 0; waited < ms && !ok(); waited += 10) await tick();
  if (!ok()) throw new Error(`the page did not reach that state; it shows ${document.body.innerHTML.slice(0, 600)}`);
}
const click = (root: ParentNode, sel: string) => root.querySelector<HTMLElement>(sel)!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
/** What a browser gives a page and jsdom doesn't: the computed custom properties, and a clock the mark's delay is read from. */
function stubPaint() {
  jest.spyOn(window, 'getComputedStyle').mockImplementation(() => ({ getPropertyValue: (p: string) => COLOURS[p] ?? '' }) as unknown as CSSStyleDeclaration);
  jest.spyOn(performance, 'now').mockReturnValue(1_000);
}

// scrypt for the typed code and the sealed saves take a while on a loaded machine
jest.setTimeout(120_000);
beforeEach(() => {
  resetSeed();
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});
afterEach(() => jest.restoreAllMocks());

describe('the options page', () => {
  const page = (url: string, title: string | null) => ({ url, canonical: null, hero: null, title, site: null, byline: null, lang: 'en', html: '<p>Hello there</p>' });
  const ctx = { device, defaults: DEFAULTS, pairing: PAIRING, crypto: webCrypto, now: NOW };

  /** The page loaded fresh; `before` runs in its module registry, for a relay it should talk to. */
  function mount(before?: () => void) {
    document.body.innerHTML = body('options.html');
    jest.isolateModules(() => {
      before?.();
      require('../src/options');
    });
    return document.getElementById('opts')!;
  }

  test('connected: saves that couldn’t send and saves waiting, the ways to save, Advanced, Retry and Disconnect', async () => {
    let answer!: (went: unknown) => void;
    // the wraps' backdated times come from the clock, and their ids are in the page
    jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
    const b = browser({ pinned: false, shortcut: 'Alt+Shift+S', answer: () => new Promise((r) => (answer = r)) });
    const store = chromeStore(b.local as unknown as chrome.storage.StorageArea);
    await store.set(KEYS.device, DEVICE_HEX);
    await store.set(KEYS.defaults, DEFAULTS);
    await store.set(KEYS.pairing, PAIRING);
    const a = (await prepare(page('https://example.com/a', 'A page & its <title>'), ctx)).pending;
    const stopped = (await prepare(page('https://www.example.org/b', null), ctx)).pending;
    await enqueue(store, a, 'reach');
    await enqueue(store, stopped, 'reach');
    await enqueue(store, (await prepare(page('https://example.com/c', 'C'), ctx)).pending, 'offline');
    await enqueue(store, (await prepare(page('https://example.com/d', 'D'), ctx)).pending, 'offline');
    // the second gave up after 200 attempts, so its line says Retry to send it
    (b.local.data.get('queue') as { id: string; stopped: boolean }[]).find((e) => e.id === stopped.id)!.stopped = true;
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => undefined }, configurable: true });

    const root = mount();
    await until(() => root.querySelector('h1')?.textContent === 'Connected to your phone' && root.querySelectorAll('.saves .li').length === 2);
    expect(html(root.innerHTML)).toMatchSnapshot('connected, not pinned, Advanced closed');

    click(root, '[data-act="adv"]');
    await until(() => root.querySelector('details.adv')?.hasAttribute('open') === true);
    expect(html(root.innerHTML)).toMatchSnapshot('Advanced open');

    click(root, '[data-act="debug"]');
    await until(() => root.querySelector('[data-act="debug"]')?.textContent === 'Copied');
    expect(html(root.innerHTML)).toMatchSnapshot('debug info copied');

    click(root, `[data-act="retry"][data-id="${a.id}"]`);
    await until(() => root.querySelector(`[data-id="${a.id}"]`)?.getAttribute('aria-busy') === 'true');
    expect(html(root.innerHTML)).toMatchSnapshot('Retry pressed, before its dots');
    await until(() => root.querySelector(`[data-id="${a.id}"]`)?.classList.contains('showbusy') === true, 2_000);
    expect(html(root.innerHTML)).toMatchSnapshot('Retry sending, with dots');
    answer(true);
    await until(() => !!root.querySelector('.saves .sent'));
    expect(html(root.innerHTML)).toMatchSnapshot('Retry sent');

    click(root, '[data-act="unpair"]');
    await until(() => !!root.querySelector('.confirm'));
    expect(html(root.innerHTML)).toMatchSnapshot('Disconnect, asked to confirm with saves waiting');
    click(root, '[data-act="unpair-cancel"]');
    await until(() => !root.querySelector('.confirm'));
  });

  test('connected: pinned, no shortcut, nothing waiting, and Disconnect alone', async () => {
    const b = browser({ pinned: true, shortcut: null });
    const store = chromeStore(b.local as unknown as chrome.storage.StorageArea);
    await store.set(KEYS.device, DEVICE_HEX);
    await store.set(KEYS.pairing, PAIRING);
    const root = mount();
    await until(() => root.querySelector('h1')?.textContent === 'Connected to your phone');
    expect(html(root.innerHTML)).toMatchSnapshot('connected, pinned, no shortcut');
    click(root, '[data-act="unpair"]');
    await until(() => !!root.querySelector('.confirm'));
    expect(html(root.innerHTML)).toMatchSnapshot('Disconnect, asked to confirm');
  });

  describe('pairing', () => {
    /** A relay that opens and answers every REQ with EOSE: enough for the page to wait on it. */
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
      constructor(readonly url: string) {
        setTimeout(() => {
          this.readyState = FakeSocket.OPEN;
          this.onopen?.();
        }, 0);
      }
      send(raw: string) {
        const [type, sub] = JSON.parse(raw) as [string, string];
        if (type === 'REQ') setTimeout(() => this.onmessage?.({ data: JSON.stringify(['EOSE', sub]) }), 0);
      }
      close() {
        this.readyState = FakeSocket.CLOSED;
      }
    }
    const ok = { ok: true, status: 200, headers: { get: () => null }, body: null, json: async () => ({ v: 1 }) } as unknown as Response;

    test('a code to scan, then expired', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
      // the operator's defaults can't be fetched, so the kept copy stands in; the offer posts
      g.fetch = (url: string) => (String(url).endsWith('/pair-offers') ? Promise.resolve(ok) : Promise.reject(new Error('offline')));
      const b = browser({ pinned: true, shortcut: null });
      const store = chromeStore(b.local as unknown as chrome.storage.StorageArea);
      await store.set(KEYS.device, DEVICE_HEX);
      await store.set(KEYS.defaults, DEFAULTS);
      // the page's own copy of nostr-tools takes the fake relay, not this file's
      const root = mount(() => (require('nostr-tools/relay') as { useWebSocketImplementation(ws: unknown): void }).useWebSocketImplementation(FakeSocket));
      await until(() => !!root.querySelector('#paircode'));
      expect(html(root.innerHTML)).toMatchSnapshot('a code to scan');
      jest.spyOn(Date, 'now').mockReturnValue((NOW + 301) * 1000);
      await until(() => !!root.querySelector('.status.plain'), 5_000);
      expect(html(root.innerHTML)).toMatchSnapshot('expired');
    });

    test('can’t connect right now', async () => {
      g.fetch = () => Promise.reject(new Error('offline'));
      const b = browser({ pinned: false, shortcut: null });
      const store = chromeStore(b.local as unknown as chrome.storage.StorageArea);
      await store.set(KEYS.device, DEVICE_HEX);
      const root = mount();
      await until(() => !!root.querySelector('.errline'));
      expect(html(root.innerHTML)).toMatchSnapshot('offline, not pinned');
    });
  });
});

const base = { id: 'w1', hash: HASH, title: 'A page & its <title>', host: 'example.com', link: false, shortcut: 'Alt+Shift+S' };
const STATES: [string, ToastState][] = [
  ['saving', { ...base, kind: 'saving' }],
  ['saved: the same cover kept, its mark added', { ...base, kind: 'saved' }],
  ['offline', { ...base, kind: 'offline' }],
  ['undone', { ...base, kind: 'undone' }],
  ['failed', { ...base, kind: 'failed' }],
  ['full', { ...base, kind: 'full' }],
  ['browser page, a link', { ...base, kind: 'browserpage', link: true }],
  ['saved again: a new cover', { ...base, kind: 'saved', hash: HASH2 }],
];

describe('the toast', () => {
  test('each state, then reached by the shortcut', async () => {
    let shadow: ShadowRoot | null = null;
    const attach = Element.prototype.attachShadow;
    jest.spyOn(Element.prototype, 'attachShadow').mockImplementation(function (this: Element, init: ShadowRootInit) {
      return (shadow = attach.call(this, init));
    });
    stubPaint();
    jest.isolateModules(() => require('../src/toast'));
    const toast = (globalThis as { kefliToast?: { show(s: ToastState): boolean; reach(): boolean } }).kefliToast!;
    for (const [name, s] of STATES) {
      expect(toast.show(s)).toBe(true);
      expect(html(shadow!.innerHTML)).toMatchSnapshot(name);
    }
    expect(toast.reach()).toBe(true);
    expect(html(shadow!.innerHTML)).toMatchSnapshot('reached: Undo has focus');
    await tick(100);
    expect(shadow!.querySelector('.sr')!.textContent).toBe('Saved to Kefli. Press Alt+Shift+S again to reach Undo.');
  });
});

describe('the browser-page popup', () => {
  test('each state, from the save in session storage', async () => {
    const b = browser({ pinned: true, shortcut: null });
    await b.session.set({ popup: STATES[0][1] });
    document.body.innerHTML = body('saved.html');
    stubPaint();
    jest.isolateModules(() => require('../src/saved'));
    const card = document.getElementById('popup')!;
    await until(() => !!card.querySelector('.tx'));
    expect(html(document.head.innerHTML)).toMatchSnapshot('the cover’s stylesheet');
    expect(html(card.outerHTML)).toMatchSnapshot(STATES[0][0]);
    for (const [name, s] of STATES.slice(1)) {
      b.on.session({ popup: { newValue: s } } as never);
      expect(html(card.outerHTML)).toMatchSnapshot(name);
    }
    await tick(100);
    expect(document.getElementById('live')!.textContent).toBe('Saved to Kefli. Press Alt+Shift+S again to reach Undo.');
  });
});
