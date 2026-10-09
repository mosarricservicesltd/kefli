// The browser-page popup (saved.html, decision 59): on pages where no toast can run, the background opens this under the
// toolbar button with the save's state in storage.session, and updates it there as Saving… becomes Saved. It is the
// toast's anatomy in the page's own scheme; it closes after eight seconds and on Escape or ✕, and the browser closes it
// when it loses focus.
import { icon } from './icons';
import { markDelay, toastCopy, type ToastCopy, type ToastState } from './toastCopy';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ShelfCover = require('../../../shared/cover/cover-v1.js') as { svg(h: string, o?: { draw?: boolean }): string; leaves(h: string): unknown[]; lineInk(h: string, s: string, t: string): string; css: string };

const COUNTDOWN_MS = 8000;
const card = document.getElementById('popup')!;
const row = card.querySelector('.row')!;
const live = document.getElementById('live')!;
let state: ToastState | null = null;
let drawnHash: string | null = null;
let drawnAt = 0;
let closeAt: ReturnType<typeof setTimeout> | undefined;
let left = COUNTDOWN_MS;
let since = 0;

document.head.insertAdjacentHTML('beforeend', `<style>${ShelfCover.css}</style>`);
const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const MARKS = { ok: icon('check', 12, 'stroke-width="3"'), bad: icon('bang', 12, 'stroke-width="3"'), off: icon('wifioff', 12, 'stroke-width="2.25"') };

/** The leading slot: the save's cover, kept while Saving… becomes Saved so its drawing isn't restarted, and its mark. */
function paintLead(t: ToastCopy): void {
  let el = row.querySelector<HTMLElement>('.lead');
  if (!el) {
    row.insertAdjacentHTML('afterbegin', '<div class="lead"></div>');
    el = row.querySelector<HTMLElement>('.lead')!;
  }
  if (!t.cover || t.cover !== drawnHash || !el.querySelector('.cv')) {
    el.innerHTML = t.cover ? `<span class="cv" aria-hidden="true">${ShelfCover.svg(t.cover, { draw: true })}</span>` : `<span class="tile ${t.tone === 'bad' ? 'bad' : ''}" aria-hidden="true">${icon(t.tile ?? 'undo', 20)}</span>`;
    drawnHash = t.cover ?? null;
    drawnAt = performance.now();
  }
  el.querySelector('.mk')?.remove();
  if (!t.cover || !t.mark) return;
  const delay = Math.max(0, markDelay(ShelfCover.leaves(t.cover).length) - (performance.now() - drawnAt));
  el.insertAdjacentHTML('beforeend', `<span class="mk ${t.mark}" style="--mk-delay:${Math.round(delay)}ms" aria-hidden="true">${MARKS[t.mark]}</span>`);
}

function paint(s: ToastState): void {
  const t = toastCopy(s);
  paintLead(t);
  row.querySelectorAll(':scope > :not(.lead)').forEach((n) => n.remove());
  row.insertAdjacentHTML('beforeend', `<div class="tx"><b>${esc(t.title)}</b>${t.sub ? `<span class="${t.wrap ? 'wrap2' : ''}">${esc(t.sub)}</span>` : ''}</div>${t.action ? `<button class="act" data-act="${t.action.toLowerCase()}">${t.action}</button>` : ''}<button class="x" data-act="close" aria-label="Close">${icon('x', 18)}</button>`);
  const cs = getComputedStyle(card);
  card.style.setProperty('--ink', t.cover ? ShelfCover.lineInk(t.cover, cs.getPropertyValue('--surface').trim(), cs.getPropertyValue('--text').trim()) : '');
  card.querySelector('.timer')!.innerHTML = t.timed ? '<i></i>' : '';
  live.textContent = '';
  if (t.say) setTimeout(() => (live.textContent = t.say), 80);
  clearTimeout(closeAt);
  left = COUNTDOWN_MS;
  if (t.timed) run();
}

function run(): void {
  since = performance.now();
  closeAt = setTimeout(() => window.close(), left);
}

function pause(on: boolean): void {
  card.classList.toggle('paused', on);
  if (!card.querySelector('.timer i')) return;
  if (on) {
    clearTimeout(closeAt);
    left -= performance.now() - since;
  } else run();
}

card.addEventListener('click', (e) => {
  const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'close') window.close();
  if (act === 'undo' && state?.id) void chrome.runtime.sendMessage({ type: 'undo', id: state.id });
  if (act === 'options') void chrome.runtime.sendMessage({ type: 'options' });
});
card.addEventListener('keydown', (e) => e.key === 'Escape' && window.close());
card.addEventListener('mouseenter', () => pause(true));
card.addEventListener('mouseleave', () => pause(false));

chrome.storage.session.onChanged.addListener((changes) => {
  if (!changes.popup?.newValue) return;
  state = changes.popup.newValue as ToastState;
  paint(state);
});
void chrome.storage.session.get('popup').then((r) => {
  state = (r.popup as ToastState | undefined) ?? null;
  if (state) paint(state);
});
