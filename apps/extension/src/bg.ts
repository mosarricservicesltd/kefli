// The background (extension spec 2 and 4): the toolbar button, the shortcut and the link menu all save; Undo, the queue's
// minute-by-minute retry and the badge. Whatever must outlive a service worker or event page restart is in storage. The
// work on a save is in worker.ts; this file joins it to the browser.
import { isWebAddress, linkOnly, orAfter, type Captured } from './captured';
import { BROWSER, DEFAULTS_URL, FLAVOUR } from './config';
import { webCrypto } from './crypto';
import { loadDefaults } from './defaults';
import { deviceSigner } from './device';
import { applyMove, followMoves } from './move';
import { queued, waiting } from './queue';
import { collected, fetchWraps, publish } from './relay';
import { fetchNet, type SaveContext } from './save';
import { chromeStore, KEYS, type Pairing } from './store';
import type { ToastState } from './toastCopy';
import { background, type Where } from './worker';

const store = chromeStore(chrome.storage.local);
const session = chromeStore(chrome.storage.session);
const now = () => Math.floor(Date.now() / 1000);
const MENU = BROWSER === 'firefox' ? 'Save Link to Kefli' : 'Save link to Kefli';

// Created at the top level, not in onInstalled, so it survives Firefox's event page restarts (spec 6).
chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: 'save-link', title: MENU, contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*'] }));

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') void chrome.runtime.openOptionsPage();
  void badge();
  void watchMoves().then(() => work.flushQueue());
});
// a save the browser closed on mid-send is still in the queue, and Firefox doesn't keep the alarm across a restart (F23)
chrome.runtime.onStartup.addListener(() => void watchMoves().then(() => work.flushQueue()));

/** How often the background looks for a move while the browser runs, and how soon after one look a send may look again. */
const MOVES_EVERY_MINUTES = 30;
const MOVES_AFTER_SEND = 300;

/**
 * Following a move (contract 4.4 and 4.8): the gift wraps addressed to this browser since the last look, less NIP-59's two
 * days of backdating, are checked for a pair-ack from the current user carrying moved_from; one that is found replaces
 * the pairing and wraps the queue again for the new key. A service worker can't hold a subscription open, so the
 * background looks at start, every half hour and after sending (ruling, extension spec 15).
 */
async function checkMoves(): Promise<void> {
  const pairing = await store.get<Pairing>(KEYS.pairing);
  const defaults = pairing ? await loadDefaults(store, DEFAULTS_URL) : null;
  if (!pairing || !defaults) return;
  const device = await deviceSigner(store, webCrypto);
  const since = ((await store.get<number>(KEYS.movesChecked)) ?? pairing.paired_at) - 172_800 - 300;
  const wraps = await fetchWraps(defaults.operator.relay, device, since).catch(() => null);
  if (!wraps) return;
  const ack = await followMoves(device, wraps, pairing.user_pubkey);
  if (ack) await applyMove(store, device, ack, now());
  await store.set(KEYS.movesChecked, now());
}

async function watchMoves(): Promise<void> {
  await chrome.alarms.create('moves', { periodInMinutes: MOVES_EVERY_MINUTES });
  await checkMoves();
}

async function checkMovesSoon(): Promise<void> {
  const last = (await store.get<number>(KEYS.movesChecked)) ?? 0;
  if (now() - last > MOVES_AFTER_SEND) await checkMoves();
}

/** What a save needs, or null before pairing; the caller decides whether that opens the options page (F10). */
async function context(): Promise<SaveContext | null> {
  const pairing = await store.get<Pairing>(KEYS.pairing);
  const defaults = pairing ? await loadDefaults(store, DEFAULTS_URL) : null;
  if (!pairing || !defaults) return null;
  return { pairing, defaults, device: await deviceSigner(store, webCrypto), crypto: webCrypto, now: now() };
}

/** Firefox's reader view saves the page it shows (mockup build notes). */
function tabUrl(url: string): string {
  return url.startsWith('about:reader?') ? (new URL(url).searchParams.get('url') ?? url) : url;
}

/**
 * How long the capture may take before the save goes as the page's address alone, through the popup. The capture runs
 * on the page's own thread, so a page that keeps it busy, or never finishes loading (an injection waits for that), held
 * the save before it was queued, until the browser stopped the worker and lost it.
 */
const CAPTURE_WAIT_MS = 30_000;
/**
 * How long the shortcut waits to learn whether a toast took the press for its Undo: a page too busy to say has none
 * showing. Two seconds outlasts the long tasks of a heavy page, which would otherwise turn a press meant for Undo into
 * a second save.
 */
const REACH_WAIT_MS = 2_000;

/** Tabs whose page is still being read: another press there (the shortcut held down, a page slow to read) is that save. */
const reading = new Set<number>();

/** The page as the capture script reads it, or null where no script can run (browser pages, PDFs, reader view) or in time. */
async function captureTab(tabId: number): Promise<Captured | null> {
  reading.add(tabId);
  const read = (async () => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['parser.js', 'capture.js'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => (globalThis as unknown as { kefliCapture(): Captured }).kefliCapture() });
    return (r?.result as Captured | undefined) ?? null;
  })()
    .catch(() => null)
    .finally(() => reading.delete(tabId));
  return orAfter(read, CAPTURE_WAIT_MS, null);
}

async function shortcutWords(): Promise<string | null> {
  return (await chrome.commands.getAll()).find((c) => c.name === 'save-page')?.shortcut || null;
}

async function toast(where: Where, s: Omit<ToastState, 'shortcut'>): Promise<void> {
  if (where === null) return;
  const state: ToastState = { ...s, shortcut: await shortcutWords() };
  if (where === 'popup') return void (await session.set('popup', state));
  const tabId = where;
  const shown = await (async () => {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['toast.js'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: (st: ToastState) => (globalThis as unknown as { kefliToast: { show(s: ToastState): boolean } }).kefliToast.show(st), args: [state] });
    return r?.result === true;
  })().catch(() => false);
  if (shown) return;
  // a page where no toast can run (an SVG, a page that took the toast's element name for its own, one with no root):
  // the popup says it instead, as on a browser's own page (decision 59), so even a save refused there is heard
  await session.set('popup', state);
  void openSavedPopup();
}

/** The badge counts offline saves in neutral grey (decisions 30 and 64); the dev build says DEV when nothing waits. */
async function badge(): Promise<void> {
  const n = waiting(await queued(store));
  await chrome.action.setBadgeBackgroundColor({ color: '#5C5B56' });
  await chrome.action.setBadgeText({ text: n ? String(n) : FLAVOUR === 'dev' ? 'DEV' : '' });
  await chrome.action.setTitle({ title: n ? `Save to Kefli (${n} waiting to send)` : 'Save to Kefli' });
}

/**
 * The popup under the toolbar button, for a save made where no toast can run (decision 59, mockup build notes): set it,
 * open it, then clear it so the next click still saves. Chrome before 127 can't open it; the tick alone stays there.
 */
async function openSavedPopup(): Promise<void> {
  try {
    await chrome.action.setPopup({ popup: 'saved.html' });
    await chrome.action.openPopup();
  } catch {
    // no popup on this browser: the tick says it
  } finally {
    await chrome.action.setPopup({ popup: '' });
  }
}

/** A green tick for four seconds, for a save made where no toast can run (decision 59). */
async function tick(): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: '#1E7A4A' });
  await chrome.action.setBadgeText({ text: '✓' });
  setTimeout(() => void badge(), 4000);
}

/** The minute alarm, made only when it isn't already set, so saves made every few seconds don't keep putting it off. */
async function flushAlarm(on: boolean): Promise<void> {
  if (!on) return void (await chrome.alarms.clear('flush'));
  if (!(await chrome.alarms.get('flush'))) await chrome.alarms.create('flush', { periodInMinutes: 1 });
}

const work = background({
  store, session, net: fetchNet(publish), now, online: () => navigator.onLine, context,
  openOptions: () => void chrome.runtime.openOptionsPage(),
  toast, tick, badge, flushAlarm, checkMovesSoon, collected,
  wait: (ms) => new Promise((r) => setTimeout(r, ms)),
});

async function saveTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || !tab.url || reading.has(tab.id)) return;
  const c = await captureTab(tab.id);
  if (c) return work.save(c, tab.id, false);
  const url = tabUrl(tab.url);
  await session.set('popup', null);
  void openSavedPopup();
  if (isWebAddress(url)) return work.save(linkOnly(url), 'popup', true);
  await toast('popup', { kind: 'browserpage', title: '', host: '', link: true });
}

chrome.action.onClicked.addListener((tab) => void saveTab(tab));

chrome.commands.onCommand.addListener((name, tab) => {
  if (name !== 'save-page' || !tab?.id) return;
  // a second press while a Saved toast shows reaches its Undo (decision 58)
  const reached = chrome.scripting
    .executeScript({ target: { tabId: tab.id }, func: () => (globalThis as unknown as { kefliToast?: { reach(): boolean } }).kefliToast?.reach() ?? false })
    .then(([r]) => r?.result === true, () => false);
  void orAfter(reached, REACH_WAIT_MS, false).then((undo) => (undo ? undefined : saveTab(tab)));
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-link' && info.linkUrl) void work.save(linkOnly(info.linkUrl), tab?.id ?? null, true);
});

chrome.runtime.onMessage.addListener((msg: { type: string; id?: string; all?: boolean }, sender, reply) => {
  const done = () => reply(true);
  if (msg.type === 'undo' && msg.id) void work.undo(msg.id, sender.tab?.id ?? 'popup').then(done, done);
  else if (msg.type === 'options') void chrome.runtime.openOptionsPage().then(done, done);
  // Retry answers whether its save went, under whatever wrap it went (v1.12), so the options page says Sent only then
  else if (msg.type === 'retry') void work.flushQueue(true, msg.id).then((sent) => reply(sent.length > 0), () => reply(false));
  else return false;
  return true;
});

// Disconnect on the options page removes the pairing; the background lets the alarm go with it (F10)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && KEYS.pairing in changes && !changes[KEYS.pairing].newValue) void work.disconnected();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'flush') void work.flushQueue();
  if (a.name === 'moves') void checkMoves();
});
self.addEventListener('online', () => void work.flushQueue());
void badge();
