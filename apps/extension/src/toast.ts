// The toast (extension spec 4, the signed-off mockup's toast and its build contract): a <kefli-toast> host with a closed
// shadow root, so page selectors can't reach inside, carrying its own tokens in the house inverted scheme (decision 57).
// The saved page's cover draws itself in the leading slot and a mark lands on its corner; Undo, ✕ and an eight-second
// countdown that pauses on hover or on focus given to it. It never takes focus by itself; a second press of the
// shortcut reaches Undo (decision 58). One live region, made once, announces what it says.
import { colors, radius, type ThemeColors } from '../../../packages/tokens/src/index';
import { icon } from './icons';
import { markDelay, toastCopy, type ToastState } from './toastCopy';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ShelfCover = require('../../../shared/cover/cover-v1.js') as {
  svg(hash: string, o?: { draw?: boolean }): string;
  leaves(hash: string): unknown[];
  lineInk(hash: string, surface: string, text: string): string;
  css: string;
};

const COUNTDOWN_MS = 8000;

function roles(t: ThemeColors): string {
  return `--text:${t.text};--muted:${t.muted};--success:${t.success};--error:${t.error};--on-fill:${t.onFill};--focus:${t.focus};--line:${t.line};--cover-edge:${t.coverEdge};`;
}
/** The flip: on a light page the toast takes the dark set's roles on the light text colour, and the reverse. */
function flipped(page: ThemeColors, other: ThemeColors): string {
  return `${roles(other)}--toast-bg:${page.text};--toast-fg:${page.background};--toast-shadow:${page.shadowFloat};--ring:${page.text};`;
}

const CSS = `
:host{all:initial !important;position:fixed !important;right:16px !important;bottom:16px !important;left:auto !important;top:auto !important;z-index:2147483647 !important;margin:0 !important;padding:0 !important;border:0 !important;background:none !important;overflow:visible !important;inset:auto 16px 16px auto !important}
.toast{${flipped(colors.light, colors.dark)}
  --motion-enter:250ms cubic-bezier(.2,.8,.2,1);--motion-exit:200ms cubic-bezier(.4,0,1,1);
  color-scheme:light dark;width:336px;max-width:calc(100vw - 32px);box-sizing:border-box;
  background:var(--toast-bg);color:var(--toast-fg);border-radius:${radius.container}px;box-shadow:var(--toast-shadow);
  font:15px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;letter-spacing:normal;text-transform:none;text-align:left;direction:ltr;
  overflow:hidden;transition:opacity var(--motion-enter),transform var(--motion-enter)}
@media (prefers-color-scheme:dark){.toast{${flipped(colors.dark, colors.light)}}}
@starting-style{.toast{opacity:0;transform:translateY(24px)}}
.toast.leave{opacity:0;transform:translateY(24px);transition:opacity var(--motion-exit),transform var(--motion-exit);pointer-events:none}
*{box-sizing:border-box}
button{font:inherit;color:inherit;background:none;border:0;margin:0;padding:0;cursor:pointer}
.row{position:relative;display:flex;align-items:center;gap:12px;padding:12px 8px 12px 12px;min-height:64px}
.lead{position:relative;width:40px;height:40px;flex:none}
.cv{display:block;position:relative;overflow:hidden;width:40px;height:40px;border-radius:${radius.control}px}
.cv svg{display:block;width:100%;height:100%}
.cv::after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px var(--cover-edge);pointer-events:none}
.tile{width:40px;height:40px;border-radius:${radius.control}px;box-shadow:inset 0 0 0 1px var(--muted);display:flex;align-items:center;justify-content:center;color:var(--muted)}
.tile.bad{color:var(--error)}
.mk{position:absolute;right:-5px;bottom:-5px;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 0 0 2px var(--ring);animation:markIn 200ms cubic-bezier(.2,.8,.2,1) var(--mk-delay,0ms) both}
.mk.ok{background:var(--success);color:var(--on-fill)}
.mk.bad{background:var(--error);color:var(--on-fill)}
.mk.off{background:var(--ring);color:var(--toast-fg);box-shadow:inset 0 0 0 1px var(--muted),0 0 0 2px var(--ring)}
@keyframes markIn{from{opacity:0;transform:scale(.4)}}
@keyframes markFade{from{opacity:0}}
.tx{flex:1;min-width:0}
.tx b{display:block;font-size:15px;font-weight:620;line-height:1.3}
.tx span{display:block;font-size:13px;color:var(--muted);line-height:1.35;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tx span.wrap2{white-space:normal}
.act{height:36px;padding:0 12px;border-radius:${radius.control}px;font-weight:620;font-size:13px;line-height:1;flex:none;display:inline-flex;align-items:center;color:var(--toast-fg)}
.x{width:32px;height:32px;border-radius:${radius.control}px;display:inline-flex;align-items:center;justify-content:center;color:var(--muted);flex:none}
.act:hover,.x:hover{background:color-mix(in srgb, var(--toast-fg) 12%, transparent)}
button:focus-visible,.viakey button:focus{outline:2px solid var(--focus);outline-offset:-2px}
.timer{height:2px;overflow:hidden}
.timer i{display:block;height:100%;background:var(--ink, var(--toast-fg));animation:countdown ${COUNTDOWN_MS}ms linear forwards}
.paused .timer i{animation-play-state:paused}
@keyframes countdown{to{transform:translateX(-100%)}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media (prefers-reduced-motion:reduce){@starting-style{.toast{transform:none}}.toast.leave{transform:none}.mk{animation:markFade 150ms both}}
@media (forced-colors:active){.toast,.tile,.mk{border:1px solid CanvasText}.act,.x{border:1px solid ButtonText}.timer i{forced-color-adjust:none;background:CanvasText}.cv{forced-color-adjust:none}}
`;

const MARKS = { ok: icon('check', 12, 'stroke-width="3"'), bad: icon('bang', 12, 'stroke-width="3"'), off: icon('wifioff', 12, 'stroke-width="2.25"') };

interface Mounted {
  host: HTMLElement;
  card: HTMLElement;
  live: HTMLElement;
  hash: string | null;
  timer?: ReturnType<typeof setTimeout>;
  left: number;
  started: number;
  returnTo: Element | null;
  state: ToastState | null;
}
let m: Mounted | null = null;

function mount(): Mounted {
  const host = document.createElement('kefli-toast');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `<style>${CSS}${ShelfCover.css}</style><div class="toast" role="group" aria-label="Kefli"><div class="row"></div><div class="timer"></div></div><div class="sr" role="status" aria-live="polite"></div>`;
  const card = root.querySelector<HTMLElement>('.toast')!;
  const parent = document.fullscreenElement ?? document.documentElement;
  parent.appendChild(host);
  if ('showPopover' in host) {
    host.setAttribute('popover', 'manual');
    (host as HTMLElement & { showPopover(): void }).showPopover();
  }
  const mm: Mounted = { host, card, live: root.querySelector('.sr')!, hash: null, left: COUNTDOWN_MS, started: 0, returnTo: null, state: null };
  card.addEventListener('click', (e) => onClick(e));
  card.addEventListener('keydown', (e) => e.key === 'Escape' && dismiss());
  card.addEventListener('mouseenter', () => pause(true));
  card.addEventListener('mouseleave', () => pause(false));
  card.addEventListener('focusout', (e) => !card.contains(e.relatedTarget as Node) && returnFocus());
  return mm;
}

function lead(t: ReturnType<typeof toastCopy>): void {
  const slot = m!.card.querySelector<HTMLElement>('.lead');
  if (t.cover && slot && m!.hash === t.cover) {
    slot.querySelector('.mk')?.remove();
  } else {
    slot?.remove();
    const el = document.createElement('div');
    el.className = 'lead';
    el.innerHTML = t.cover ? `<span class="cv" aria-hidden="true">${ShelfCover.svg(t.cover, { draw: true })}</span>` : `<span class="tile ${t.tone === 'bad' ? 'bad' : ''}" aria-hidden="true">${icon(t.tile ?? 'undo', 20)}</span>`;
    m!.card.querySelector('.row')!.prepend(el);
    m!.hash = t.cover ?? null;
    m!.started = performance.now();
  }
  if (t.cover && t.mark) {
    const delay = Math.max(0, markDelay(ShelfCover.leaves(t.cover).length) - (performance.now() - m!.started));
    m!.card.querySelector('.lead')!.insertAdjacentHTML('beforeend', `<span class="mk ${t.mark}" style="--mk-delay:${Math.round(delay)}ms" aria-hidden="true">${MARKS[t.mark]}</span>`);
  }
}

function paint(s: ToastState): void {
  const t = toastCopy(s);
  lead(t);
  const row = m!.card.querySelector('.row')!;
  row.querySelectorAll(':scope > :not(.lead)').forEach((n) => n.remove());
  row.insertAdjacentHTML('beforeend', `<div class="tx"><b>${esc(t.title)}</b>${t.sub ? `<span class="${t.wrap ? 'wrap2' : ''}">${esc(t.sub)}</span>` : ''}</div>${t.action ? `<button class="act" data-act="${t.action.toLowerCase()}">${t.action}</button>` : ''}<button class="x" data-act="close" aria-label="Close">${icon('x', 18)}</button>`);
  m!.card.style.setProperty('--ink', t.cover ? ShelfCover.lineInk(t.cover, getComputedStyle(m!.card).getPropertyValue('--toast-bg').trim(), getComputedStyle(m!.card).getPropertyValue('--toast-fg').trim()) : '');
  m!.card.querySelector('.timer')!.innerHTML = t.timed ? '<i></i>' : '';
  say(t.say);
  clearTimeout(m!.timer);
  m!.left = COUNTDOWN_MS;
  if (t.timed) countdown();
}

const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function say(text: string): void {
  const live = m!.live;
  live.textContent = '';
  if (text) setTimeout(() => (live.textContent = text), 80);
}

let since = 0;
function countdown(): void {
  since = performance.now();
  m!.timer = setTimeout(dismiss, m!.left);
}

function pause(on: boolean): void {
  if (!m) return;
  m.card.classList.toggle('paused', on);
  if (on) {
    clearTimeout(m.timer);
    m.left -= performance.now() - since;
  } else if (m.card.querySelector('.timer i')) countdown();
}

function returnFocus(): void {
  if (!m) return;
  m.card.classList.remove('viakey');
  pause(false);
  (m.returnTo as HTMLElement | null)?.focus?.();
  m.returnTo = null;
}

function dismiss(): void {
  if (!m) return;
  const gone = m;
  m = null;
  if (gone.returnTo) (gone.returnTo as HTMLElement).focus?.();
  gone.card.classList.add('leave');
  setTimeout(() => gone.host.remove(), 260);
}

function onClick(e: Event): void {
  const act = (e.target as Element).closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'close') return dismiss();
  if (act === 'undo' && m?.state?.id) void chrome.runtime.sendMessage({ type: 'undo', id: m.state.id });
  if (act === 'options') void chrome.runtime.sendMessage({ type: 'options' });
}

/** Shows or updates the toast; the same cover stays when Saving… becomes Saved, so its drawing isn't restarted. */
function show(s: ToastState): void {
  if (!m) m = mount();
  m.state = s;
  paint(s);
}

/** The second press of the shortcut: focus moves to Undo, and leaving the toast hands it back (decision 58). */
function reach(): boolean {
  const undo = m?.card.querySelector<HTMLElement>('[data-act="undo"]');
  if (!m || !undo) return false;
  m.returnTo = document.activeElement;
  m.card.classList.add('viakey');
  pause(true);
  undo.focus();
  return true;
}

// Injected again for every save: the first copy on a page stays in charge, so there is only ever one toast.
const g = globalThis as { kefliToast?: unknown };
g.kefliToast ??= { show, reach };
