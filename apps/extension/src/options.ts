// The options page (extension spec 3, mockup's options page): Connect to your phone with a QR and a typed code, then
// Connected with the ways to save, Advanced and Disconnect. Pairing runs here while the page is open; the logic is in
// pair.ts, this file only draws.
import { toQR } from 'toqr';
import LOGO from '../../../shared/brand/out/extension/options-logo-28.svg';
import { BROWSER, DEFAULTS_URL } from './config';
import { webCrypto } from './crypto';
import { loadDefaults, type Defaults } from './defaults';
import { deviceSigner } from './device';
import { icon } from './icons';
import { browserLabel, formatCode, listenForAck, OFFER_LIFE, pairingFrom, postOffer, type Listening, type Offer } from './pair';
import { chromeStore, KEYS, type Pairing } from './store';

const store = chromeStore(chrome.storage.local);
const root = document.getElementById('opts')!;
const live = document.getElementById('live')!;
const RETRY_MS = 10_000;

type View = { kind: 'loading' } | { kind: 'show'; offer: Offer; left: number } | { kind: 'expired' } | { kind: 'offline' } | { kind: 'connected'; pairing: Pairing; confirm: boolean; advanced: boolean };
let view: View = { kind: 'loading' };
let listening: Listening | null = null;
let ticker: ReturnType<typeof setInterval> | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const say = (msg: string) => { live.textContent = ''; setTimeout(() => (live.textContent = msg), 80); };
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const now = () => Math.floor(Date.now() / 1000);
const label = () => browserLabel(navigator.userAgent, ((navigator as { userAgentData?: { brands: { brand: string }[] } }).userAgentData?.brands ?? []).map((b) => b.brand));

function qrSvg(text: string, size: number): string {
  const m = toQR(text);
  const n = Math.sqrt(m.length);
  let d = '';
  for (let i = 0; i < m.length; i++) if (m[i]) d += `M${i % n} ${Math.floor(i / n)}h1v1h-1z`;
  return `<svg width="${size}" height="${size}" viewBox="-1 -1 ${n + 2} ${n + 2}" fill="currentColor" shape-rendering="crispEdges" role="img" aria-label="Connection code"><path d="${d}"/></svg>`;
}

const head = () => `<div class="brandrow"><span class="lg">${LOGO}</span>Kefli</div>`;

function pairHTML(): string {
  const dim = view.kind !== 'show';
  const qr = view.kind === 'show' ? qrSvg(view.offer.qr, 168) : `<svg width="168" height="168" role="img" aria-label="Connection code, not available"></svg>`;
  const code = view.kind === 'show' ? `<div class="code" id="paircode">${formatCode(view.offer.code)}</div>` : '<div class="code" aria-hidden="true">––––-––––</div>';
  const status = view.kind === 'expired'
    ? `<div class="status plain"><div class="errline" style="margin:0;flex:1">${icon('alert', 16)}<span>This code has expired.</span></div><button class="btn primary" data-act="newcode">${icon('refresh', 18)}Show a new one</button></div>`
    : view.kind === 'show' ? `<div class="status"><span class="pdot" aria-hidden="true"></span>Waiting for your phone<span class="cd">Code expires in <span id="cd">${mmss(view.left)}</span></span></div>` : '';
  const err = view.kind === 'offline' ? `<div class="errline">${icon('alert', 16)}<span>Can’t connect right now. Check your connection. Trying again every ten seconds.</span></div>` : '';
  return `<div class="in">${head()}<h1 tabindex="-1">Connect to your phone</h1>${err}
    <p class="lead">Pages you save here arrive in Kefli on your phone. Your phone decides which browsers it trusts, so you connect them from there.</p>
    <div class="card"><div class="seg first last edge-t edge-b"><div class="pair">
      <div class="qr ${dim ? 'faded' : ''}" data-theme="light">${qr}${code}</div>
      <ol class="steps"><li>Open Kefli on your phone.</li><li>Go to <strong>You</strong>, then <strong>Connected browsers</strong>, then <strong>Connect a browser</strong>.</li><li>Scan the code, or type the code under it.</li><li>Check that your phone names this browser <strong>${esc(label())}</strong>, then tap <strong>Connect</strong>.</li></ol>
    </div>${status}</div></div></div>`;
}

function connectedHTML(v: Extract<View, { kind: 'connected' }>, shortcut: string | null): string {
  const since = new Date(v.pairing.paired_at * 1000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  const key = shortcut
    ? `<div class="li"><span class="ic">${icon('keyboard')}</span><span class="t">Press a shortcut<small>Press it again to reach Undo</small></span><span class="keys">${shortcut.split('+').map((k) => `<span class="kbd">${esc(k)}</span>`).join('')}</span></div>`
    : `<div class="li"><span class="ic">${icon('keyboard')}</span><span class="t">No shortcut set</span><button class="chip" data-act="setkey">Set a shortcut</button></div>`;
  const menu = BROWSER === 'firefox' ? 'Save Link to Kefli' : 'Save link to Kefli';
  const relays = v.advanced ? `<section class="sect" style="margin-top:var(--space-8)"><h2>Relays</h2><div class="list">${v.pairing.write_relays.map((r, i) => `<div class="li${i === 0 ? ' edge-t' : ''}${i === v.pairing.write_relays.length - 1 ? ' edge-b' : ''}"><span class="ic">${icon('server')}</span><span class="t">${i === 0 ? 'Kefli' : `Backup ${i}`}<small>${esc(r.replace(/^wss?:\/\//, ''))}</small></span></div>`).join('')}</div><p class="fine">Set by your phone when you connected this browser.</p></section>` : '';
  const unpair = v.confirm
    ? `<div class="confirm" role="group" aria-labelledby="unpairhead"><h2 id="unpairhead">Disconnect this browser?</h2><p>This browser will stop sending saves to your phone. To stop it completely, also remove it under Connected browsers on your phone.</p><div class="row"><button class="btn secondary" data-act="unpair-cancel">Cancel</button><button class="btn danger" data-act="unpair-yes">Disconnect</button></div></div>`
    : `<button class="btn secondary destructive" data-act="unpair">Disconnect this browser</button><p class="fine">To stop this browser completely, also remove it under Connected browsers on your phone. If you undo a save your phone already picked up, remove it there too.</p>`;
  return `<div class="in">${head()}
    <div class="titlerow"><span class="ok">${icon('check', 20, 'stroke-width="2.5"')}</span><h1 tabindex="-1">Connected to your phone</h1></div>
    <p class="lead">Since ${since} · your phone shows this browser as “${esc(v.pairing.label)}”</p>
    <section class="sect"><h2>Ways to save</h2><div class="list">
      <div class="li edge-t"><span class="ic">${icon('bookmark')}</span><span class="t">Click the Kefli button in the toolbar</span></div>${key}
      <div class="li edge-b"><span class="ic">${icon('mouse')}</span><span class="t">Right-click a link, then ${menu}</span></div></div></section>
    <details class="adv" ${v.advanced ? 'open' : ''}><summary data-act="adv"><span class="ic">${icon('settings')}</span><span class="t">Advanced</span><span class="chev"><span class="chevr">${icon('chev', 18)}</span></span></summary>${relays}</details>
    <div class="sect">${unpair}</div></div>`;
}

async function shortcut(): Promise<string | null> {
  const cmds = await chrome.commands.getAll();
  return cmds.find((c) => c.name === 'save-page')?.shortcut || null;
}

async function render() {
  root.innerHTML = view.kind === 'connected' ? connectedHTML(view, await shortcut()) : view.kind === 'loading' ? '' : pairHTML();
}

function stopPairing() {
  listening?.stop();
  listening = null;
  clearInterval(ticker);
  clearTimeout(retry);
}

async function connected(pairing: Pairing) {
  stopPairing();
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

const ACTIONS: Record<string, () => void | Promise<void>> = {
  newcode: startPairing,
  adv: () => { if (view.kind === 'connected') { view.advanced = !view.advanced; void render(); } },
  unpair: () => { if (view.kind === 'connected') { view.confirm = true; void render(); } },
  'unpair-cancel': () => { if (view.kind === 'connected') { view.confirm = false; void render(); } },
  'unpair-yes': async () => { await store.remove(KEYS.pairing); },
  setkey: () => { void chrome.tabs.create({ url: BROWSER === 'firefox' ? 'about:addons' : 'chrome://extensions/shortcuts' }); },
};

root.addEventListener('click', (e) => {
  const el = (e.target as Element).closest<HTMLElement>('[data-act]');
  if (!el) return;
  if (el.dataset.act === 'adv') e.preventDefault();
  void ACTIONS[el.dataset.act!]?.();
});

// The pairing record is the one source: the phone's ack, a Disconnect here, or the background replacing it after a move.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(KEYS.pairing in changes)) return;
  const p = changes[KEYS.pairing].newValue as Pairing | undefined;
  if (p) void connected(p);
  else void startPairing();
});

async function start() {
  const p = await store.get<Pairing>(KEYS.pairing);
  if (p) await connected(p);
  else await startPairing();
}
void start();
