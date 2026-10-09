// The background (extension spec 2 and 4): the toolbar button, the shortcut and the link menu all save; Undo, the queue's
// minute-by-minute retry and the badge. Whatever must outlive a service worker or event page restart is in storage.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { linkOnly, type Captured } from './captured';
import { BROWSER, DEFAULTS_URL, FLAVOUR } from './config';
import { webCrypto } from './crypto';
import { loadDefaults } from './defaults';
import { deviceSigner } from './device';
import { dequeue, enqueue, flush, queued, waiting, whyNot } from './queue';
import { publish } from './relay';
import { deliver, fetchNet, prepare, retract, type SaveContext } from './save';
import { chromeStore, KEYS, type Pairing } from './store';
import type { ToastKind, ToastState } from './toastCopy';

const store = chromeStore(chrome.storage.local);
const session = chromeStore(chrome.storage.session);
const net = fetchNet(publish);
const UNDO_WINDOW = 12; // seconds: the toast's eight, and time to press
const now = () => Math.floor(Date.now() / 1000);
const MENU = BROWSER === 'firefox' ? 'Save Link to Kefli' : 'Save link to Kefli';

// Created at the top level, not in onInstalled, so it survives Firefox's event page restarts (spec 6).
chrome.contextMenus.removeAll(() => chrome.contextMenus.create({ id: 'save-link', title: MENU, contexts: ['link'] }));

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') void chrome.runtime.openOptionsPage();
  void badge();
});

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

async function toast(tabId: number | null, s: Omit<ToastState, 'shortcut'>): Promise<void> {
  if (tabId === null) return;
  const state: ToastState = { ...s, shortcut: await shortcutWords() };
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

async function save(c: Captured, tabId: number | null, link: boolean): Promise<void> {
  const ctx = await context();
  if (!ctx) return;
  const { pending, wrapKey } = await prepare(c, ctx);
  const base = { id: pending.id, hash: pending.hash, title: pending.title, host: pending.host, link };
  await toast(tabId, { ...base, kind: 'saving' });
  await session.set(`undo:${pending.id}`, { key: bytesToHex(wrapKey), sha256: pending.sha256, until: now() + UNDO_WINDOW });
  const d = navigator.onLine ? await deliver(pending, ctx.defaults.operator.blossom, ctx.defaults.operator.relay, ctx.device, net) : 'unreachable';
  if (d === 'sent') {
    await toast(tabId, { ...base, kind: sentKind(c) });
    if (tabId === null) await tick();
    return;
  }
  const why = whyNot(d, navigator.onLine);
  if ((await enqueue(store, pending, why)) === 'full') {
    await toast(tabId, { ...base, kind: 'full' });
    return;
  }
  await chrome.alarms.create('flush', { periodInMinutes: 1 });
  await badge();
  await toast(tabId, { ...base, kind: why === 'offline' ? 'offline' : 'failed' });
}

async function saveTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || !tab.url) return;
  const c = await captureTab(tab.id);
  await save(c ?? linkOnly(tabUrl(tab.url)), c ? tab.id : null, !c);
}

async function undo(id: string, tabId: number | undefined): Promise<void> {
  const ctx = await context();
  const where = tabId ?? null;
  if (!ctx) return;
  const waitingSave = (await queued(store)).find((e) => e.id === id);
  if (waitingSave && (await dequeue(store, id))) {
    await badge();
    await toast(where, { kind: 'unqueued', title: waitingSave.title, host: waitingSave.host, link: false });
    return;
  }
  const kept = await session.get<{ key: string; sha256: string | null; until: number }>(`undo:${id}`);
  if (!kept || kept.until < now()) return;
  await retract({ id, sha256: kept.sha256 }, hexToBytes(kept.key), ctx.defaults.operator.blossom, ctx.defaults.operator.relay, ctx.device, net, now());
  await session.remove(`undo:${id}`);
  await toast(where, { kind: 'undone', title: '', host: '', link: false });
}

async function flushQueue(all = false): Promise<void> {
  const ctx = await context();
  if (!ctx) return;
  await flush(store, (p) => deliver(p, ctx.defaults.operator.blossom, ctx.defaults.operator.relay, ctx.device, net), navigator.onLine, all);
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
  if (msg.type === 'undo' && msg.id) void undo(msg.id, sender.tab?.id).then(done, done);
  else if (msg.type === 'options') void chrome.runtime.openOptionsPage().then(done, done);
  else if (msg.type === 'retry') void flushQueue(true).then(done, done);
  else return false;
  return true;
});

chrome.alarms.onAlarm.addListener((a) => a.name === 'flush' && void flushQueue());
self.addEventListener('online', () => void flushQueue());
void badge();
