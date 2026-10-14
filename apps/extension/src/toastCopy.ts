// What the toast and the browser-page popup say, from the signed-off mockup's table (docs/design/mockups/extension.html,
// TOASTS). A link save names its host, since there is no page title yet. Page-title sub-lines have no full stop;
// sentence sub-lines do. `say` is what the live region announces, text only.
import { QUEUE_MAX } from './queue';

export type ToastKind = 'saving' | 'saved' | 'notext' | 'offline' | 'undone' | 'unqueued' | 'full' | 'failed' | 'browserpage' | 'onphone' | 'undofailed' | 'toolong';

export interface ToastState {
  kind: ToastKind;
  /** The save's wrap id, which Undo names. */
  id?: string;
  /** The save's d-tag hash, for its cover. */
  hash?: string;
  title: string;
  host: string;
  /** A right-click or browser-page save: the address alone. */
  link: boolean;
  /** The live shortcut, in words, or null when none is set. */
  shortcut: string | null;
}

export interface ToastCopy {
  cover?: string;
  mark?: 'ok' | 'off' | 'bad';
  tile?: 'undo' | 'alert';
  tone?: 'bad';
  title: string;
  sub: string;
  wrap?: boolean;
  action?: 'Undo' | 'Options';
  timed: boolean;
  say: string;
}

type Make = (s: ToastState, line: string) => ToastCopy;

const COPY: Record<ToastKind, Make> = {
  saving: (s, line) => ({ cover: s.hash, title: 'Saving…', sub: line, timed: false, say: '' }),
  saved: (s, line) => ({ cover: s.hash, mark: 'ok', title: 'Saved to Kefli', sub: line, action: 'Undo', timed: true, say: 'Saved to Kefli' }),
  notext: (s) => ({ cover: s.hash, mark: 'ok', title: 'Saved to Kefli', sub: `${s.host} · your phone will fetch the text`, wrap: true, action: 'Undo', timed: true, say: 'Saved to Kefli. Your phone will fetch the text.' }),
  offline: (s, line) => ({ cover: s.hash, mark: 'off', title: 'Saved — will send when you’re online', sub: line, action: 'Undo', timed: true, say: 'Saved. It will send when you’re online.' }),
  undone: () => ({ tile: 'undo', title: 'Removed from Kefli', sub: 'If your phone already has it, remove it there.', wrap: true, timed: true, say: 'Removed from Kefli. If your phone already has it, remove it there.' }),
  unqueued: (_s, line) => ({ tile: 'undo', title: 'Removed from Kefli', sub: line, timed: true, say: 'Removed from Kefli' }),
  full: () => ({ tile: 'alert', tone: 'bad', title: `Not saved: ${QUEUE_MAX} are already waiting`, sub: 'They’ll send when you’re online. Save this again then.', wrap: true, timed: true, say: `Not saved: ${QUEUE_MAX} are already waiting. They’ll send when you’re online. Save this again then.` }),
  failed: (s) => ({ cover: s.hash, mark: 'bad', title: 'Couldn’t send this save', sub: 'It’s kept here, and Kefli will keep trying.', wrap: true, action: 'Options', timed: true, say: 'Couldn’t send this save. It’s kept here, and Kefli will keep trying.' }),
  // contract 4.4, decision 101: Undo found the phone had already collected the save, so it is in the library
  onphone: (s) => ({ cover: s.hash, mark: 'ok', title: 'Already on your phone', sub: 'Remove it from your phone’s Saves.', wrap: true, timed: true, say: 'Already on your phone. Remove it from your phone’s Saves.' }),
  // decision 100: a browser's own page has no web address to save
  browserpage: () => ({ tile: 'alert', tone: 'bad', title: 'Can’t save this page', sub: 'Kefli saves web pages, and this one belongs to the browser.', wrap: true, timed: true, say: 'Can’t save this page. Kefli saves web pages, and this one belongs to the browser.' }),
  // F40: Undo couldn't retract the save (the relay refused or was out of reach) and the phone hasn't collected it, so it
  // may still arrive. Drafted, needs Richard's read; on the prototype and the flow map (decision 116).
  undofailed: (s) => ({ cover: s.hash, mark: 'bad', tile: 'alert', tone: 'bad', title: 'Couldn’t undo this save', sub: 'If it reaches your phone, remove it there.', wrap: true, timed: true, say: 'Couldn’t undo this save. If it reaches your phone, remove it there.' }),
  // F39: an address too long to send even with everything else left out, so nothing is saved. Drafted, needs Richard's
  // read; on the prototype and the flow map (decision 116).
  toolong: () => ({ tile: 'alert', tone: 'bad', title: 'Can’t save this page', sub: 'Its address is too long to send to your phone.', wrap: true, timed: true, say: 'Can’t save this page. Its address is too long to send to your phone.' }),
};

/** When the corner mark lands: with the cover's last leaf (520 ms, then 34 ms a leaf), and never later than 1 s. */
export function markDelay(leaves: number): number {
  return Math.min(1000, 520 + 34 * Math.max(0, leaves - 1));
}

/** A Saved toast tells keyboard users how to reach Undo with the live binding; with no binding the sentence is dropped. */
export function toastCopy(s: ToastState): ToastCopy {
  const t = COPY[s.kind](s, s.link ? s.host : s.title);
  if (t.action === 'Undo' && s.shortcut) t.say = `${t.say.replace(/\.?$/, '.')} Press ${s.shortcut} again to reach Undo.`;
  return t;
}
