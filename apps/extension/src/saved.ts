// The browser-page popup (saved.html, decision 59): on pages where no toast can run, the background opens this under the
// toolbar button with the save's state in storage.session, and updates it there as Saving… becomes Saved. It is the
// toast's anatomy in the page's own scheme; it closes after eight seconds and on Escape or ✕, and the browser closes it
// when it loses focus.
import { add, el, style, svg } from './dom';
import { icon, MARKS } from './icons';
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

document.head.append(style(ShelfCover.css));

/** The leading slot: the save's cover, kept while Saving… becomes Saved so its drawing isn't restarted, and its mark. */
function paintLead(t: ToastCopy): void {
  let lead = row.querySelector<HTMLElement>('.lead');
  if (!lead) {
    lead = el('div', { class: 'lead' });
    row.prepend(lead);
  }
  if (!t.cover || t.cover !== drawnHash || !lead.querySelector('.cv')) {
    lead.replaceChildren(t.cover
      ? el('span', { class: 'cv', 'aria-hidden': 'true' }, svg(ShelfCover.svg(t.cover, { draw: true })))
      : el('span', { class: `tile ${t.tone === 'bad' ? 'bad' : ''}`, 'aria-hidden': 'true' }, svg(icon(t.tile ?? 'undo', 20))));
    drawnHash = t.cover ?? null;
    drawnAt = performance.now();
  }
  lead.querySelector('.mk')?.remove();
  if (!t.cover || !t.mark) return;
  const delay = Math.max(0, markDelay(ShelfCover.leaves(t.cover).length) - (performance.now() - drawnAt));
  lead.append(el('span', { class: `mk ${t.mark}`, style: `--mk-delay:${Math.round(delay)}ms`, 'aria-hidden': 'true' }, svg(MARKS[t.mark])));
}

function paint(s: ToastState): void {
  const t = toastCopy(s);
  paintLead(t);
  row.querySelectorAll(':scope > :not(.lead)').forEach((n) => n.remove());
  add(row,
    el('div', { class: 'tx' }, el('b', {}, t.title), t.sub ? el('span', { class: t.wrap ? 'wrap2' : '' }, t.sub) : null),
    t.action ? el('button', { class: 'act', 'data-act': t.action.toLowerCase() }, t.action) : null,
    el('button', { class: 'x', 'data-act': 'close', 'aria-label': 'Close' }, svg(icon('x', 18))),
  );
  const cs = getComputedStyle(card);
  card.style.setProperty('--ink', t.cover ? ShelfCover.lineInk(t.cover, cs.getPropertyValue('--surface').trim(), cs.getPropertyValue('--text').trim()) : '');
  card.querySelector('.timer')!.replaceChildren(...(t.timed ? [el('i')] : []));
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
