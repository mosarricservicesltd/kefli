// The options page (extension spec 3, the signed-off mockup's options page): Connect to your phone with a QR and a typed
// code, then Connected with any saves waiting or that couldn't send, the ways to save, Advanced and Disconnect. Pairing
// runs here while the page is open; the logic is in pair.ts and queue.ts, this file only draws.
import { toQR } from 'toqr';
import LOGO from '../../../shared/brand/out/extension/options-logo-28.svg';
import { BROWSER, COMMIT, DEFAULTS_URL, FLAVOUR } from './config';
import { webCrypto } from './crypto';
import { debugText, history } from './debug';
import { loadDefaults, relayRows, type Defaults } from './defaults';
import { deviceSigner } from './device';
import { el, svg, type Child } from './dom';
import { icon, type IconName } from './icons';
import type { PairAck } from '../../../packages/protocol/src/pairing';
import { exclusive } from './lock';
import { browserLabel, formatCode, listenForAck, newOffer, pairingFrom, postOffer, tryPairing, type Listening, type Offer } from './pair';
import { failed, queued, shown, waiting, type Queued, type Shown } from './queue';
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
/** The code on show, kept across a try that hit trouble so the next one shows it again rather than posting another. */
const last: { offer: Offer | null } = { offer: null };
/** The operator's defaults as last fetched, which name Kefli's own relay in Advanced (F43). */
let kept: Defaults | null = null;
let queue: Shown[] = [];
let pinned = true;
/** Copy debug info reads Copied for 1.5 s after a copy. */
let copied = false;
/** Retry in flight (busy shows its dots once the wait passes 150 ms), and rows holding Sent before they leave. */
const sending = new Map<string, { dots: boolean }>();
const sent = new Map<string, Shown>();

/** The queue with each save's title, host and hash read from its sealed request, held in this page only (F31). */
const reveal = async (q: Queued[]) => shown(q, await deviceSigner(store, webCrypto));

const say = (msg: string) => { live.textContent = ''; setTimeout(() => (live.textContent = msg), 80); };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const now = () => Math.floor(Date.now() / 1000);
const label = () => browserLabel(navigator.userAgent, ((navigator as { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands ?? []).map((b) => b.brand));
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function qrSvg(text: string, size: number): SVGSVGElement {
  const m = toQR(text);
  const n = Math.sqrt(m.length);
  let d = '';
  for (let i = 0; i < m.length; i++) if (m[i]) d += `M${i % n} ${Math.floor(i / n)}h1v1h-1z`;
  return svg(`<svg width="${size}" height="${size}" viewBox="-1 -1 ${n + 2} ${n + 2}" fill="currentColor" shape-rendering="crispEdges" role="img" aria-label="Connection code"><path d="${d}"/></svg>`);
}

/** Rows of a group: the first carries the group's top edge, the last its bottom (the mockup's plates). */
function list(rows: HTMLElement[], cls = 'list'): HTMLElement {
  rows.forEach((r, i) => (r.className = r.className.replace(/^li/, `li${i === 0 ? ' edge-t' : ''}${i === rows.length - 1 ? ' edge-b' : ''}`)));
  return el('div', { class: cls }, rows);
}

/** A list row led by an icon: the row's text, then anything at its end. */
const iconRow = (name: IconName, text: Child, ...end: Child[]) => el('div', { class: 'li' }, el('span', { class: 'ic' }, svg(icon(name))), el('span', { class: 't' }, text), ...end);

const head = () => el('div', { class: 'brandrow' }, el('span', { class: 'lg' }, svg(LOGO)), 'Kefli');
const pinLine = () => [el('span', { class: 'ic' }, svg(icon('puzzle'))), el('span', { class: 't' }, 'Pin Kefli to your toolbar: click the puzzle piece, then the pin next to Kefli.')];
const WHY = {
  reach: 'Couldn’t reach Kefli’s server. It will keep trying.',
  stopped: 'Couldn’t reach Kefli’s server. Retry to send it.',
};

function pairView(): HTMLElement {
  const dim = view.kind !== 'show';
  const qr = view.kind === 'show' ? qrSvg(view.offer.qr, 168) : svg('<svg width="168" height="168" role="img" aria-label="Connection code, not available"></svg>');
  const code = view.kind === 'show' ? el('div', { class: 'code', id: 'paircode' }, formatCode(view.offer.code)) : el('div', { class: 'code', 'aria-hidden': 'true' }, '––––-––––');
  const status = view.kind === 'expired'
    ? el('div', { class: 'status plain' },
      el('div', { class: 'errline', style: 'margin:0;flex:1' }, svg(icon('alert', 16)), el('span', {}, 'This code has expired.')),
      el('button', { class: 'btn primary', 'data-act': 'newcode' }, svg(icon('refresh', 18)), 'Show a new one'))
    : view.kind === 'show'
      ? el('div', { class: 'status' }, el('span', { class: 'pdot', 'aria-hidden': 'true' }), 'Waiting for your phone', el('span', { class: 'cd' }, 'Code expires in ', el('span', { id: 'cd' }, mmss(view.left))))
      : null;
  const err = view.kind === 'offline' ? el('div', { class: 'errline' }, svg(icon('alert', 16)), el('span', {}, 'Can’t connect right now. Check your connection. Trying again every ten seconds.')) : null;
  const pin = pinned ? null : el('div', { class: 'seg pinseg first edge-t' }, el('div', { class: 'li pinline' }, pinLine()));
  return el('div', { class: 'in' }, head(), el('h1', { tabindex: '-1' }, 'Connect to your phone'), err,
    el('p', { class: 'lead' }, 'Pages you save here arrive in Kefli on your phone. Your phone decides which browsers it trusts, so you connect them from there.'),
    el('div', { class: 'card' }, pin, el('div', { class: `seg ${pinned ? 'first edge-t' : ''} last edge-b` },
      el('div', { class: 'pair' },
        el('div', { class: `qr ${dim ? 'faded' : ''}`, 'data-theme': 'light' }, qr, code),
        el('ol', { class: 'steps' },
          el('li', {}, 'Open Kefli on your phone.'),
          el('li', {}, 'Go to ', el('strong', {}, 'You'), ', then ', el('strong', {}, 'Connected browsers'), ', then ', el('strong', {}, 'Connect a browser'), '.'),
          el('li', {}, 'Scan the code, or type the code under it.'),
          el('li', {}, 'Check that your phone names this browser ', el('strong', {}, label()), ', then tap ', el('strong', {}, 'Connect'), '.'))),
      status)));
}

function retryChip(e: Shown): HTMLElement {
  const s = sending.get(e.id);
  return el('button', { class: `chip stack${s?.dots ? ' showbusy' : ''}`, 'data-act': 'retry', 'data-id': e.id, 'aria-busy': s ? 'true' : null, 'aria-label': `${s ? 'Sending' : 'Retry'} ${e.title}` },
    el('span', { class: 'lbl-idle' }, 'Retry'),
    el('span', { class: 'lbl-busy', 'aria-hidden': 'true' }, el('span', { class: 'dots inbtn' }, el('i'), el('i'), el('i')), 'Sending'));
}

function failRow(e: Shown): HTMLElement {
  const done = sent.has(e.id);
  const end = done ? el('span', { class: 'sent' }, svg(icon('check'))) : retryChip(e);
  return el('div', { class: 'li' },
    el('span', { class: 'cv', 'aria-hidden': 'true' }, svg(ShelfCover.svg(e.hash))),
    el('span', { class: 't' }, e.title, el('small', {}, `${e.host} · ${done ? 'Sent' : WHY[e.stopped ? 'stopped' : 'reach']}`)),
    end);
}

function failedView(): HTMLElement | null {
  const rows = [...failed(queue), ...[...sent.values()].filter((e) => !queue.some((q) => q.id === e.id))];
  return rows.length ? el('section', { class: 'sect', 'aria-labelledby': 'failhead' }, el('h2', { id: 'failhead' }, 'Couldn’t send'), list(rows.map(failRow), 'list saves')) : null;
}

function notice(): HTMLElement | null {
  const n = waiting(queue);
  if (!n) return null;
  return el('div', { class: 'notice' }, svg(icon('wifioff', 16)), el('span', {}, n === 1 ? '1 save waiting to send. It’ll send when you’re online.' : `${n} saves waiting to send. They’ll send when you’re online.`));
}

function ways(shortcut: string | null): HTMLElement {
  const key = shortcut
    ? iconRow('keyboard', ['Press a shortcut', el('small', {}, 'Press it again to reach Undo')], el('span', { class: 'keys' }, shortcut.split('+').map((k) => el('span', { class: 'kbd' }, k))))
    : iconRow('keyboard', 'No shortcut set', el('button', { class: 'chip', 'data-act': 'setkey' }, 'Set a shortcut'));
  const menu = BROWSER === 'firefox' ? 'Save Link to Kefli' : 'Save link to Kefli';
  const rows = [
    ...(pinned ? [] : [el('div', { class: 'li' }, pinLine())]),
    iconRow('bookmark', 'Click the Kefli button in the toolbar'),
    key,
    iconRow('mouse', `Right-click a link, then ${menu}`),
  ];
  return el('section', { class: 'sect' }, el('h2', {}, 'Ways to save'), list(rows));
}

function advanced(p: Pairing, open: boolean): HTMLElement {
  const relays = relayRows(p.write_relays, kept).map((r) => iconRow('server', [r.label, el('small', {}, r.url.replace(/^wss?:\/\//, ''))]));
  const build = iconRow('info', [`Kefli ${chrome.runtime.getManifest().version}`, el('small', {}, `${FLAVOUR} · ${COMMIT}`)], el('button', { class: 'chip', 'data-act': 'debug' }, copied ? 'Copied' : 'Copy debug info'));
  const body = open
    ? [
      el('section', { class: 'sect', style: 'margin-top:var(--space-8)' }, el('h2', {}, 'Relays'), list(relays), el('p', { class: 'fine' }, 'Set by your phone when you connected this browser.')),
      el('section', { class: 'sect' }, el('h2', {}, 'This browser'), list([build]), el('p', { class: 'fine' }, 'For a bug report. It lists what became of your last twenty saves, without their addresses or titles, and nothing that could open them.')),
    ]
    : null;
  return el('details', { class: 'adv', open },
    el('summary', { 'data-act': 'adv' }, el('span', { class: 'ic' }, svg(icon('settings'))), el('span', { class: 't' }, 'Advanced'), el('span', { class: 'chev' }, el('span', { class: 'chevr' }, svg(icon('chev', 18))))),
    body);
}

function unpair(confirm: boolean): Child {
  const n = queue.length;
  if (!confirm) {
    return [
      el('button', { class: 'btn secondary destructive', 'data-act': 'unpair' }, 'Disconnect this browser'),
      el('p', { class: 'fine' }, 'To stop this browser completely, also remove it under Connected browsers on your phone. If you undo a save your phone already picked up, remove it there too.'),
    ];
  }
  const unsent = n ? `${n} ${plural(n, 'save hasn’t', 'saves haven’t')} reached your phone yet. Disconnecting deletes ${plural(n, 'it', 'them')} from this browser. ` : '';
  const yes = n ? `Disconnect and delete ${n} ${plural(n, 'save', 'saves')}` : 'Disconnect';
  return el('div', { class: 'confirm', role: 'group', 'aria-labelledby': 'unpairhead' },
    el('h2', { id: 'unpairhead' }, 'Disconnect this browser?'),
    el('p', {}, `${unsent}This browser will stop sending saves to your phone. To stop it completely, also remove it under Connected browsers on your phone.`),
    el('div', { class: 'row' }, el('button', { class: 'btn secondary', 'data-act': 'unpair-cancel' }, 'Cancel'), el('button', { class: 'btn danger', 'data-act': 'unpair-yes' }, yes)));
}

function connectedView(v: Extract<View, { kind: 'connected' }>, shortcut: string | null): HTMLElement {
  const since = new Date(v.pairing.paired_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  return el('div', { class: 'in' }, head(),
    el('div', { class: 'titlerow' }, el('span', { class: 'ok' }, svg(icon('check', 20, 2.5))), el('h1', { tabindex: '-1' }, 'Connected to your phone')),
    notice(),
    el('p', { class: 'lead' }, `Since ${since} · your phone shows this browser as “${v.pairing.label}”`),
    failedView(), ways(shortcut), advanced(v.pairing, v.advanced),
    el('div', { class: 'sect' }, unpair(v.confirm)));
}

async function shortcut(): Promise<string | null> {
  const cmds = await chrome.commands.getAll();
  return cmds.find((c) => c.name === 'save-page')?.shortcut || null;
}

async function render() {
  root.replaceChildren(...(view.kind === 'connected' ? [connectedView(view, await shortcut())] : view.kind === 'loading' ? [] : [pairView()]));
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
  last.offer = null;
  kept = (await store.get<Defaults>(KEYS.defaults)) ?? null;
  queue = await reveal(await queued(store));
  view = { kind: 'connected', pairing, confirm: false, advanced: false };
  await render();
  say('Connected to your phone');
}

/**
 * Shows a code and waits for the phone; any failure to reach the operator shows the offline line and tries again. A try
 * after trouble shows the same code while it has a minute left, and nothing is posted until the relay answers (F42).
 */
async function startPairing() {
  stopPairing();
  try {
    const defaults = await loadDefaults(store, DEFAULTS_URL);
    if (!defaults) throw new Error('no defaults');
    const device = await deviceSigner(store, webCrypto);
    // under the move's lock, so a move a look found as this browser paired again isn't written over it (move.ts applyMove)
    const onAck = (o: Offer) => (ack: PairAck) => void exclusive('move', () => store.set(KEYS.pairing, pairingFrom(ack, o.offer.label, now())));
    const { offer, listening: l } = await tryPairing(
      last,
      () => newOffer(device, defaults, label(), webCrypto, now()),
      (o) => listenForAck(defaults.operator.relay, device, o.offer.nonce, now(), onAck(o), offline),
      (o) => postOffer(device, defaults, o, webCrypto),
      now(),
    );
    listening = l;
    view = { kind: 'show', offer, left: Math.max(0, offer.offer.expires - now()) };
    ticker = setInterval(countdown, 1000);
    await render();
  } catch {
    offline();
  }
}

/** Show a new one: the expired code is dropped, so the next try makes a fresh offer. */
function newCode() {
  last.offer = null;
  return startPairing();
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
  // the background answers whether the save went: one whose HTML the operator refused may wait on under a new wrap's id
  // (v1.12), and two saves of one page may wait, so what is left in the queue can't tell
  const went: unknown = await chrome.runtime.sendMessage({ type: 'retry', id }).catch(() => false);
  clearTimeout(dots);
  sending.delete(id);
  queue = await reveal(await queued(store));
  if (entry && went === true) {
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
  newcode: newCode,
  adv: () => setConnected({ advanced: view.kind === 'connected' && !view.advanced }),
  unpair: () => setConnected({ confirm: true }),
  'unpair-cancel': () => setConnected({ confirm: false }),
  // Disconnecting deletes what hadn't reached the phone, as the confirm said
  // and the save history with them
  // and the session's Undo keys and last popup save, which would otherwise last until the browser closes (F31);
  // the queue under its lock, so a send the background is finishing can't write it back (F41)
  // and the pairing under the move's, so a move the background is taking can't write it back either (move.ts applyMove)
  'unpair-yes': async () => {
    await exclusive('queue', () => store.remove(KEYS.queue));
    await store.remove(KEYS.history);
    await chrome.storage.session.clear().catch(() => undefined);
    await exclusive('move', () => store.remove(KEYS.pairing));
  },
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
    void reveal((changes[KEYS.queue].newValue as Queued[] | undefined) ?? []).then((q) => {
      queue = q;
      if (view.kind === 'connected') void render();
    });
  }
  if (!(KEYS.pairing in changes)) return;
  const p = changes[KEYS.pairing].newValue as Pairing | undefined;
  if (p) void connected(p);
  else void startPairing();
});

for (const ev of ['focus', 'visibilitychange']) window.addEventListener(ev, () => void checkPinned());
// Chrome alone announces a pin or an unpin; Firefox has no such event and never will, so its build drops this statement by
// its label (build.mjs dropLabels) rather than carry a call to an API it lacks for the store's linter to flag.
CHROME_ONLY: chrome.action.onUserSettingsChanged?.addListener(() => void checkPinned());

async function start() {
  await checkPinned();
  const p = await store.get<Pairing>(KEYS.pairing);
  if (p) await connected(p);
  else await startPairing();
}
void start();
