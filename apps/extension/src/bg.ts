// The background (extension spec 2 and 4): the toolbar button, the shortcut and the link menu all save; Undo, the queue's
// minute-by-minute retry and the badge. Whatever must outlive a service worker or event page restart is in storage.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { isWebAddress, linkOnly, type Captured } from './captured';
import { BROWSER, DEFAULTS_URL, FLAVOUR } from './config';
import { webCrypto } from './crypto';
import { loadDefaults } from './defaults';
import { record, type Outcome } from './debug';
import { deviceSigner } from './device';
import { applyMove, followMoves } from './move';
import { dequeue, enqueue, flush, queued, waiting, whyNot } from './queue';
import { collected, fetchWraps, publish } from './relay';
import { deliver, fetchNet, prepare, retract, type SaveContext } from './save';
import { chromeStore, KEYS, type Pairing } from './store';
import type { ToastKind, ToastState } from './toastCopy';
import { settleUndo } from './undo';

const store = chromeStore(chrome.storage.local);
const session = chromeStore(chrome.storage.session);
const net = fetchNet(publish);
const UNDO_WINDOW = 12; // seconds: the toast's eight, and time to press
const now = () => Math.floor(Date.now() / 1000);
const MENU = BROWSER === 'firefox' ? 'Save Link to Kefli' : 'Save link to Kefli';

// Created at the top level, not in onInstalled, so it survives Firefox's event page restarts (spec 6).
chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: 'save-link', title: MENU, contexts: ['link'], targetUrlPatterns: ['http://*/*', 'https://*/*'] }));

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') void chrome.runtime.openOptionsPage();
  void badge();
  void watchMoves();
});
chrome.runtime.onStartup.addListener(() => void watchMoves());

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

async function context(): Promise<SaveContext | null> {
  const pairing = await store.get<Pairing>(KEYS.pairing);
  const defaults = pairing ? await loadDefaults(store, DEFAULTS_URL) : null;
  if (!pairing || !defaults) {
    void chrome.runtime.openOptionsPage();
    return null;
  }
  return { pairing, defaults, device: await deviceSigner(store, webCrypto), crypto: webCrypto, now: now() };
}

/** Firefox's reader view saves the page it shows (mockup build notes). */
function tabUrl(url: string): string {
  return url.startsWith('about:reader?') ? (new URL(url).searchParams.get('url') ?? url) : url;
}

/** The page as the capture script reads it, or null where no script can run (browser pages, PDFs, reader view). */
async function captureTab(tabId: number): Promise<Captured | null> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['parser.js', 'capture.js'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => (globalThis as unknown as { kefliCapture(): Captured }).kefliCapture() });
    return (r?.result as Captured | undefined) ?? null;
  } catch {
    return null;
  }
}

async function shortcutWords(): Promise<string | null> {
  return (await chrome.commands.getAll()).find((c) => c.name === 'save-page')?.shortcut || null;
}

/** Where a save's notices go: the tab's toast, the toolbar popup where no toast can run, or nowhere (a link menu). */
type Where = number | 'popup' | null;

async function toast(where: Where, s: Omit<ToastState, 'shortcut'>): Promise<void> {
  if (where === null) return;
  const state: ToastState = { ...s, shortcut: await shortcutWords() };
  if (where === 'popup') return void (await session.set('popup', state));
  const tabId = where;
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['toast.js'] });
    await chrome.scripting.executeScript({ target: { tabId }, func: (st: ToastState) => (globalThis as unknown as { kefliToast: { show(s: ToastState): void } }).kefliToast.show(st), args: [state] });
  } catch {
    // a page where no toast can run: the badge says it instead
  }
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

/** A save with no HTML is fetched by the phone itself, and the toast says so. */
function sentKind(c: Captured): ToastKind {
  return c.html === null ? 'notext' : 'saved';
}

const WAITING: Record<ReturnType<typeof whyNot>, Outcome> = { offline: 'waiting, offline', reach: 'waiting, couldn’t reach', blocked: 'waiting, blocked' };

async function save(c: Captured, tabId: Where, link: boolean): Promise<void> {
  // a move found now means this save is wrapped for the new key from the start
  await checkMovesSoon();
  const ctx = await context();
  if (!ctx) return;
  const { pending, wrapKey } = await prepare(c, ctx);
  const base = { id: pending.id, hash: pending.hash, title: pending.title, host: pending.host, link };
  await toast(tabId, { ...base, kind: 'saving' });
  await session.set(`undo:${pending.id}`, { key: bytesToHex(wrapKey), sha256: pending.sha256, hash: pending.hash, until: now() + UNDO_WINDOW });
  const d = navigator.onLine ? await deliver(pending, ctx.defaults.operator.blossom, ctx.defaults.operator.relay, ctx.device, net) : 'unreachable';
  if (d === 'sent') {
    await record(store, now(), pending.id, c.html === null ? 'sent, no text' : 'sent', link);
    await toast(tabId, { ...base, kind: sentKind(c) });
    if (tabId === 'popup') await tick();
    return;
  }
  const why = whyNot(d, navigator.onLine);
  if ((await enqueue(store, pending, why)) === 'full') {
    await record(store, now(), pending.id, 'queue full', link);
    await toast(tabId, { ...base, kind: 'full' });
    return;
  }
  await record(store, now(), pending.id, WAITING[why], link);
  await chrome.alarms.create('flush', { periodInMinutes: 1 });
  await badge();
  await toast(tabId, { ...base, kind: why === 'offline' ? 'offline' : 'failed' });
  if (tabId === 'popup' && why === 'offline') await tick();
}

async function saveTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || !tab.url) return;
  const c = await captureTab(tab.id);
  if (c) return save(c, tab.id, false);
  const url = tabUrl(tab.url);
  await session.set('popup', null);
  void openSavedPopup();
  if (isWebAddress(url)) return save(linkOnly(url), 'popup', true);
  await toast('popup', { kind: 'browserpage', title: '', host: '', link: true });
}

async function undo(id: string, where: Where): Promise<void> {
  const ctx = await context();
  if (!ctx) return;
  const waitingSave = (await queued(store)).find((e) => e.id === id);
  if (waitingSave && (await dequeue(store, id))) {
    await record(store, now(), id, 'undo: off the queue');
    await badge();
    await toast(where, { kind: 'unqueued', title: waitingSave.title, host: waitingSave.host, link: false });
    return;
  }
  const kept = await session.get<{ key: string; sha256: string | null; hash: string; until: number }>(`undo:${id}`);
  if (!kept || kept.until < now()) return;
  const { relay, blossom } = ctx.defaults.operator;
  const outcome = await settleUndo(
    () => retract({ id, sha256: kept.sha256 }, hexToBytes(kept.key), blossom, relay, ctx.device, net, now()),
    () => collected(relay, id, ctx.pairing.user_pubkey),
    (ms) => new Promise((r) => setTimeout(r, ms)),
  );
  await session.remove(`undo:${id}`);
  await record(store, now(), id, outcome === 'onphone' ? 'undo: on the phone' : 'undo: retracted');
  await toast(where, { kind: outcome, hash: kept.hash, title: '', host: '', link: false });
}

async function flushQueue(all = false, only?: string): Promise<void> {
  // a save queued before a move must go to the new key, so a waiting queue looks for one first
  await checkMovesSoon();
  const ctx = await context();
  if (!ctx) return;
  const stoppedBefore = new Set((await queued(store)).filter((e) => e.stopped).map((e) => e.id));
  const sent = await flush(store, (p) => deliver(p, ctx.defaults.operator.blossom, ctx.defaults.operator.relay, ctx.device, net), navigator.onLine, all, only);
  for (const id of sent) await record(store, now(), id, 'sent from queue');
  for (const e of await queued(store)) if (e.stopped && !stoppedBefore.has(e.id)) await record(store, now(), e.id, 'stopped');
  if (!(await queued(store)).length) await chrome.alarms.clear('flush');
  await badge();
}

chrome.action.onClicked.addListener((tab) => void saveTab(tab));

chrome.commands.onCommand.addListener((name, tab) => {
  if (name !== 'save-page' || !tab?.id) return;
  // a second press while a Saved toast shows reaches its Undo (decision 58)
  void chrome.scripting
    .executeScript({ target: { tabId: tab.id }, func: () => (globalThis as unknown as { kefliToast?: { reach(): boolean } }).kefliToast?.reach() ?? false })
    .then(
      ([r]) => (r?.result ? undefined : saveTab(tab)),
      () => saveTab(tab),
    );
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'save-link' && info.linkUrl) void save(linkOnly(info.linkUrl), tab?.id ?? null, true);
});

chrome.runtime.onMessage.addListener((msg: { type: string; id?: string; all?: boolean }, sender, reply) => {
  const done = () => reply(true);
  if (msg.type === 'undo' && msg.id) void undo(msg.id, sender.tab?.id ?? 'popup').then(done, done);
  else if (msg.type === 'options') void chrome.runtime.openOptionsPage().then(done, done);
  else if (msg.type === 'retry') void flushQueue(true, msg.id).then(done, done);
  else return false;
  return true;
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'flush') void flushQueue();
  if (a.name === 'moves') void checkMoves();
});
self.addEventListener('online', () => void flushQueue());
void badge();
