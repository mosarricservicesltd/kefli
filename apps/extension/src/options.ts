// The options page (extension spec 3, the signed-off mockup's options page): Connect to your phone with a QR and a typed
// code, then Connected with any saves waiting or that couldn't send, the ways to save, Advanced and Disconnect. Pairing
// runs here while the page is open; the logic is in pair.ts and queue.ts, this file only draws.
import { toQR } from 'toqr';
import LOGO from '../../../shared/brand/out/extension/options-logo-28.svg';
import { BROWSER, COMMIT, DEFAULTS_URL, FLAVOUR } from './config';
import { webCrypto } from './crypto';
import { debugText, history } from './debug';
import { loadDefaults } from './defaults';
import { deviceSigner } from './device';
import { icon } from './icons';
import { browserLabel, formatCode, listenForAck, OFFER_LIFE, pairingFrom, postOffer, type Listening, type Offer } from './pair';
import { failed, queued, waiting, type Queued } from './queue';
import { chromeStore, KEYS, type Pairing } from './store';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ShelfCover = require('../../../shared/cover/cover-v1.js') as { svg(h: string): string };

const store = chromeStore(chrome.storage.local);
const root = document.getElementById('opts')!;
const live = document.getElementById('live')!;
const RETRY_MS = 10_000;
const BUSY_AFTER_MS = 150;
const SENT_HOLD_MS = 1500;

type View = { kind: 'loading' } | { kind: 'show'; offer: Offer; left: number } | { kind: 'expired' } | { kind: 'offline' } | { kind: 'connected'; pairing: Pairing; confirm: boolean; advanced: boolean };
let view: View = { kind: 'loading' };
let listening: Listening | null = null;
let ticker: ReturnType<typeof setInterval> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let queue: Queued[] = [];
let pinned = true;
/** Copy debug info reads Copied for 1.5 s after a copy. */
let copied = false;
/** Retry in flight (busy shows its dots once the wait passes 150 ms), and rows holding Sent before they leave. */
const sending = new Map<string, { dots: boolean }>();
const sent = new Map<string, Queued>();

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const say = (msg: string) => { live.textContent = ''; setTimeout(() => (live.textContent = msg), 80); };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const now = () => Math.floor(Date.now() / 1000);
const label = () => browserLabel(navigator.userAgent, ((navigator as { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands ?? []).map((b) => b.brand));
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function qrSvg(text: string, size: number): string {
  const m = toQR(text);
  const n = Math.sqrt(m.length);
  let d = '';
  for (let i = 0; i < m.length; i++) if (m[i]) d += `M${i % n} ${Math.floor(i / n)}h1v1h-1z`;
  return `<svg width="${size}" height="${size}" viewBox="-1 -1 ${n + 2} ${n + 2}" fill="currentColor" shape-rendering="crispEdges" role="img" aria-label="Connection code"><path d="${d}"/></svg>`;
}

/** Rows of a group: the first carries the group's top edge, the last its bottom (the mockup's plates). */
function list(rows: string[], cls = 'list'): string {
  return `<div class="${cls}">${rows.map((r, i) => r.replace('class="li', `class="li${i === 0 ? ' edge-t' : ''}${i === rows.length - 1 ? ' edge-b' : ''}`)).join('')}</div>`;
}

const head = () => `<div class="brandrow"><span class="lg">${LOGO}</span>Kefli</div>`;
const PIN = `<span class="ic">${icon('puzzle')}</span><span class="t">Pin Kefli to your toolbar: click the puzzle piece, then the pin next to Kefli.</span>`;
const WHY = {
  reach: 'Couldn’t reach Kefli’s server. It will keep trying.',
  blocked: 'Something in this browser is blocking Kefli’s server. See Advanced.',
  stopped: 'Couldn’t reach Kefli’s server. Retry to send it.',
};

function pairHTML(): string {
  const dim = view.kind !== 'show';
  const qr = view.kind === 'show' ? qrSvg(view.offer.qr, 168) : `<svg width="168" height="168" role="img" aria-label="Connection code, not available"></svg>`;
  const code = view.kind === 'show' ? `<div class="code" id="paircode">${formatCode(view.offer.code)}</div>` : '<div class="code" aria-hidden="true">––––-––––</div>';
  const status = view.kind === 'expired'
    ? `<div class="status plain"><div class="errline" style="margin:0;flex:1">${icon('alert', 16)}<span>This code has expired.</span></div><button class="btn primary" data-act="newcode">${icon('refresh', 18)}Show a new one</button></div>`
    : view.kind === 'show' ? `<div class="status"><span class="pdot" aria-hidden="true"></span>Waiting for your phone<span class="cd">Code expires in <span id="cd">${mmss(view.left)}</span></span></div>` : '';
  const err = view.kind === 'offline' ? `<div class="errline">${icon('alert', 16)}<span>Can’t connect right now. Check your connection. Trying again every ten seconds.</span></div>` : '';
  const pin = pinned ? '' : `<div class="seg pinseg first edge-t"><div class="li pinline">${PIN}</div></div>`;
  return `<div class="in">${head()}<h1 tabindex="-1">Connect to your phone</h1>${err}
    <p class="lead">Pages you save here arrive in Kefli on your phone. Your phone decides which browsers it trusts, so you connect them from there.</p>
    <div class="card">${pin}<div class="seg ${pinned ? 'first edge-t' : ''} last edge-b"><div class="pair">
      <div class="qr ${dim ? 'faded' : ''}" data-theme="light">${qr}${code}</div>
      <ol class="steps"><li>Open Kefli on your phone.</li><li>Go to <strong>You</strong>, then <strong>Connected browsers</strong>, then <strong>Connect a browser</strong>.</li><li>Scan the code, or type the code under it.</li><li>Check that your phone names this browser <strong>${esc(label())}</strong>, then tap <strong>Connect</strong>.</li></ol>
    </div>${status}</div></div></div>`;
}

function retryChip(e: Queued): string {
  const s = sending.get(e.id);
  return `<button class="chip stack${s?.dots ? ' showbusy' : ''}" data-act="retry" data-id="${e.id}"${s ? ' aria-busy="true"' : ''} aria-label="${s ? 'Sending' : 'Retry'} ${esc(e.title)}"><span class="lbl-idle">Retry</span><span class="lbl-busy" aria-hidden="true"><span class="dots inbtn"><i></i><i></i><i></i></span>Sending</span></button>`;
}

function failRow(e: Queued): string {
  const done = sent.has(e.id);
  const end = done ? `<span class="sent">${icon('check')}</span>` : retryChip(e);
  return `<div class="li"><span class="cv" aria-hidden="true">${ShelfCover.svg(e.hash)}</span><span class="t">${esc(e.title)}<small>${esc(e.host)} · ${done ? 'Sent' : WHY[e.stopped ? 'stopped' : e.why === 'blocked' ? 'blocked' : 'reach']}</small></span>${end}</div>`;
}

function failedHTML(): string {
  const rows = [...failed(queue), ...[...sent.values()].filter((e) => !queue.some((q) => q.id === e.id))];
  return rows.length ? `<section class="sect" aria-labelledby="failhead"><h2 id="failhead">Couldn’t send</h2>${list(rows.map(failRow), 'list saves')}</section>` : '';
}

function noticeHTML(): string {
  const n = waiting(queue);
  if (!n) return '';
  return `<div class="notice">${icon('wifioff', 16)}<span>${n === 1 ? '1 save waiting to send. It’ll send when you’re online.' : `${n} saves waiting to send. They’ll send when you’re online.`}</span></div>`;
}

function waysHTML(shortcut: string | null): string {
  const key = shortcut
    ? `<div class="li"><span class="ic">${icon('keyboard')}</span><span class="t">Press a shortcut<small>Press it again to reach Undo</small></span><span class="keys">${shortcut.split('+').map((k) => `<span class="kbd">${esc(k)}</span>`).join('')}</span></div>`
    : `<div class="li"><span class="ic">${icon('keyboard')}</span><span class="t">No shortcut set</span><button class="chip" data-act="setkey">Set a shortcut</button></div>`;
  const menu = BROWSER === 'firefox' ? 'Save Link to Kefli' : 'Save link to Kefli';
  const rows = [
    ...(pinned ? [] : [`<div class="li">${PIN}</div>`]),
    `<div class="li"><span class="ic">${icon('bookmark')}</span><span class="t">Click the Kefli button in the toolbar</span></div>`,
    key,
    `<div class="li"><span class="ic">${icon('mouse')}</span><span class="t">Right-click a link, then ${menu}</span></div>`,
  ];
  return `<section class="sect"><h2>Ways to save</h2>${list(rows)}</section>`;
}

function advancedHTML(p: Pairing, open: boolean): string {
  const blocked = queue.some((e) => e.why === 'blocked');
  const relays = p.write_relays.map((r, i) => `<div class="li"><span class="ic">${icon('server')}</span><span class="t">${i === 0 ? 'Kefli' : `Backup ${i}`}<small>${esc(r.replace(/^wss?:\/\//, ''))}</small></span>${i === 0 && blocked ? '<span class="sdot bad">Blocked in this browser</span>' : ''}</div>`);
  const build = `<div class="li"><span class="ic">${icon('info')}</span><span class="t">Kefli ${esc(chrome.runtime.getManifest().version)}<small>${FLAVOUR} · ${esc(COMMIT)}</small></span><button class="chip" data-act="debug">${copied ? 'Copied' : 'Copy debug info'}</button></div>`;
  const body = open
    ? `<section class="sect" style="margin-top:var(--space-8)"><h2>Relays</h2>${list(relays)}<p class="fine">Set by your phone when you connected this browser.</p></section>
      <section class="sect"><h2>This browser</h2>${list([build])}<p class="fine">For a bug report. It lists what became of your last twenty saves, without their addresses or titles, and nothing that could open them.</p></section>`
    : '';
  return `<details class="adv" ${open ? 'open' : ''}><summary data-act="adv"><span class="ic">${icon('settings')}</span><span class="t">Advanced</span><span class="chev"><span class="chevr">${icon('chev', 18)}</span></span></summary>${body}</details>`;
}

function unpairHTML(confirm: boolean): string {
  const n = queue.length;
  if (!confirm) return `<button class="btn secondary destructive" data-act="unpair">Disconnect this browser</button><p class="fine">To stop this browser completely, also remove it under Connected browsers on your phone. If you undo a save your phone already picked up, remove it there too.</p>`;
  const unsent = n ? `${n} ${plural(n, 'save hasn’t', 'saves haven’t')} reached your phone yet. Disconnecting deletes ${plural(n, 'it', 'them')} from this browser. ` : '';
  const yes = n ? `Disconnect and delete ${plural(n, '1 save', `${n} saves`)}` : 'Disconnect';
  return `<div class="confirm" role="group" aria-labelledby="unpairhead"><h2 id="unpairhead">Disconnect this browser?</h2><p>${unsent}This browser will stop sending saves to your phone. To stop it completely, also remove it under Connected browsers on your phone.</p><div class="row"><button class="btn secondary" data-act="unpair-cancel">Cancel</button><button class="btn danger" data-act="unpair-yes">${yes}</button></div></div>`;
}

function connectedHTML(v: Extract<View, { kind: 'connected' }>, shortcut: string | null): string {
  const since = new Date(v.pairing.paired_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  return `<div class="in">${head()}
    <div class="titlerow"><span class="ok">${icon('check', 20, 'stroke-width="2.5"')}</span><h1 tabindex="-1">Connected to your phone</h1></div>
    ${noticeHTML()}
    <p class="lead">Since ${since} · your phone shows this browser as “${esc(v.pairing.label)}”</p>
    ${failedHTML()}${waysHTML(shortcut)}${advancedHTML(v.pairing, v.advanced)}
    <div class="sect">${unpairHTML(v.confirm)}</div></div>`;
}

async function shortcut(): Promise<string | null> {
  const cmds = await chrome.commands.getAll();
  return cmds.find((c) => c.name === 'save-page')?.shortcut || null;
}

async function render() {
  root.innerHTML = view.kind === 'connected' ? connectedHTML(view, await shortcut()) : view.kind === 'loading' ? '' : pairHTML();
}

/** Whether Kefli is on the toolbar (Chrome 91+, Firefox 118+); the pin line goes once it is (mockup build notes). */
async function checkPinned() {
  const settings = await chrome.action.getUserSettings?.().catch(() => null);
  const was = pinned;
  pinned = settings?.isOnToolbar ?? true;
  if (was !== pinned) void render();
}

function stopPairing() {
  listening?.stop();
  listening = null;
  clearInterval(ticker);
  clearTimeout(retry);
}

async function connected(pairing: Pairing) {
  stopPairing();
  queue = await queued(store);
  view = { kind: 'connected', pairing, confirm: false, advanced: false };
  await render();
  say('Connected to your phone');
}

/** Makes an offer and waits for the phone; any failure to reach the operator shows the offline line and tries again. */
async function startPairing() {
  stopPairing();
  try {
    const defaults = await loadDefaults(store, DEFAULTS_URL);
    if (!defaults) throw new Error('no defaults');
    const device = await deviceSigner(store, webCrypto);
    const offer = await postOffer(device, defaults, label(), webCrypto, now());
    listening = await listenForAck(defaults.operator.relay, device, offer.offer.nonce, now(), (ack) => void store.set(KEYS.pairing, pairingFrom(ack, offer.offer.label, now())), offline);
    view = { kind: 'show', offer, left: OFFER_LIFE };
    ticker = setInterval(countdown, 1000);
    await render();
  } catch {
    offline();
  }
}

function offline() {
  stopPairing();
  view = { kind: 'offline' };
  void render();
  retry = setTimeout(startPairing, RETRY_MS);
}

function countdown() {
  if (view.kind !== 'show') return;
  view.left = Math.max(0, view.offer.offer.expires - now());
  const cd = document.getElementById('cd');
  if (cd) cd.textContent = mmss(view.left);
  if (view.left > 0) return;
  stopPairing();
  view = { kind: 'expired' };
  void render();
  say('This code has expired.');
}

/** Retry: busy from the tap, its dots after 150 ms; once sent the row holds Sent for 1.5 s, then leaves. */
async function retryOne(id: string) {
  if (sending.has(id)) return;
  const entry = queue.find((e) => e.id === id);
  sending.set(id, { dots: false });
  void render();
  const dots = setTimeout(() => { const s = sending.get(id); if (s) { s.dots = true; void render(); } }, BUSY_AFTER_MS);
  await chrome.runtime.sendMessage({ type: 'retry', id }).catch(() => undefined);
  clearTimeout(dots);
  sending.delete(id);
  queue = await queued(store);
  if (entry && !queue.some((e) => e.id === id)) {
    sent.set(id, entry);
    say(`Sent ${entry.title}`);
    setTimeout(() => { sent.delete(id); void render(); }, SENT_HOLD_MS);
  }
  void render();
}

/** Copy debug info (decision 108): the build, the connection and the last twenty outcomes, as plain text. */
async function copyDebug() {
  const pairing = await store.get<Pairing>(KEYS.pairing);
  const text = debugText({
    version: chrome.runtime.getManifest().version, flavour: FLAVOUR, commit: COMMIT, browser: label(), userAgent: navigator.userAgent,
    online: navigator.onLine, defaultsUrl: DEFAULTS_URL, devicePubkey: (await deviceSigner(store, webCrypto)).pubkey(), pairing: pairing ?? null,
    queue: await queued(store), movesChecked: (await store.get<number>(KEYS.movesChecked)) ?? null, history: await history(store), now: now(),
  });
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    say('Couldn’t copy. Click the page, then try again.');
    return;
  }
  copied = true;
  void render();
  say('Debug info copied');
  setTimeout(() => { copied = false; void render(); }, SENT_HOLD_MS);
}

function setConnected(change: Partial<Extract<View, { kind: 'connected' }>>) {
  if (view.kind !== 'connected') return;
  Object.assign(view, change);
  void render();
}

const ACTIONS: Record<string, (id?: string) => void | Promise<void>> = {
  newcode: startPairing,
  adv: () => setConnected({ advanced: view.kind === 'connected' && !view.advanced }),
  unpair: () => setConnected({ confirm: true }),
  'unpair-cancel': () => setConnected({ confirm: false }),
  // Disconnecting deletes what hadn't reached the phone, as the confirm said
  // and the save history with them
  'unpair-yes': async () => { await store.remove(KEYS.queue); await store.remove(KEYS.history); await store.remove(KEYS.pairing); },
  debug: copyDebug,
  retry: (id) => (id ? retryOne(id) : undefined),
  setkey: () => { void chrome.tabs.create({ url: BROWSER === 'firefox' ? 'about:addons' : 'chrome://extensions/shortcuts' }); },
};

root.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'adv') e.preventDefault();
  void ACTIONS[el.dataset.act!]?.(el.dataset.id);
});

// The pairing record is the one source: the phone's ack, a Disconnect here, or the background replacing it after a move.
// The queue redraws the waiting notice and the Couldn't send list as the background sends or adds to it.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (KEYS.queue in changes) {
    queue = (changes[KEYS.queue].newValue as Queued[] | undefined) ?? [];
    if (view.kind === 'connected') void render();
  }
  if (!(KEYS.pairing in changes)) return;
  const p = changes[KEYS.pairing].newValue as Pairing | undefined;
  if (p) void connected(p);
  else void startPairing();
});

for (const ev of ['focus', 'visibilitychange']) window.addEventListener(ev, () => void checkPinned());
chrome.action.onUserSettingsChanged?.addListener(() => void checkPinned());

async function start() {
  await checkPinned();
  const p = await store.get<Pairing>(KEYS.pairing);
  if (p) await connected(p);
  else await startPairing();
}
void start();
