// The listening clock and choices (mobile spec 5.7), platform-free: on-device speech has no duration, so time is
// the word reached over words a second at the rate. The speed pill steps 0.8, 1, 1.2, 1.5, 2 and wraps. Where a
// session starts: the saved word if it is on screen, otherwise the first word in view (FD 19).
export const RATES = [0.8, 1, 1.2, 1.5, 2] as const;
/** Words a second at rate 1, before a voice is measured (T§2). */
export const WPS_SEED = 3.9;

export function nextRate(rate: number): number {
  const i = RATES.indexOf(rate as (typeof RATES)[number]);
  return RATES[(i + 1) % RATES.length];
}

export function seconds(word: number, wps: number, rate: number): number {
  return Math.max(0, Math.round(word / (wps * rate)));
}

const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** m:ss, and h:mm:ss from an hour (the prototype's fmt). */
export function clock(s: number): string {
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad2((s % 3600) / 60)}:${pad2(s % 60)}` : `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

export function rateLabel(rate: number): string {
  return `${rate}×`;
}

/** The start word: the saved word when it lies in view, else the first word in view; a finished article from 0. */
export function startWord(saved: number, inView: { first: number; last: number }, words: number): number {
  if (words === 0 || saved >= words - 1) return inView.first >= words - 1 ? 0 : inView.first;
  return saved >= inView.first && saved <= inView.last ? saved : inView.first;
}

/** A stored speed or words-a-second value, checked. */
export function readRate(v: string | null): number {
  const n = Number(v);
  return (RATES as readonly number[]).includes(n) ? n : 1;
}

export function readWps(v: string | null): number {
  const n = Number(v);
  return n >= 1 && n <= 8 ? n : WPS_SEED;
}

export type Ruler = { numbers: { at: number; label: string }[]; ticks: { at: number; major: boolean }[] };

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120];

/**
 * The word meter's ruler (FD 68; prototype rulerHTML): minute numbers over the line, a major tick at each and three
 * minor ticks between. The prototype's one-minute step suits its short articles; a long one widens the step so
 * there are at most nine numbers (RULED: the step from 1, 2, 5, 10, 15, 30, 60 and 120 minutes).
 */
export function ruler(durationSec: number): Ruler {
  const minutes = Math.max(1, durationSec / 60);
  const step = STEPS.find((s) => 8 >= Math.floor(minutes / s)) ?? STEPS[STEPS.length - 1];
  const numbers: Ruler['numbers'] = [];
  const ticks: Ruler['ticks'] = [];
  if (durationSec <= 0) return { numbers, ticks };
  for (let m = 0; m * 60 <= durationSec; m += step) numbers.push({ at: (m * 60) / durationSec, label: String(m) });
  const minor = (step * 60) / 4;
  for (let s = 0, k = 0; s <= durationSec; s += minor, k++) ticks.push({ at: s / durationSec, major: k % 4 === 0 });
  return { numbers, ticks };
}

/** The sentence a word is in, by binary search over the sentences' first words. */
export function sentenceOf(firstWords: number[], word: number): number {
  let lo = 0;
  let hi = firstWords.length - 1;
  while (hi > lo) {
    const mid = (lo + hi + 1) >> 1;
    if (firstWords[mid] <= word) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}

/** The word meter (FD 68): one mark per word of the sentence, lit up to the spoken word; unlit without word timing. */
export function meter(first: number, words: number, word: number, wordTiming: boolean): { marks: number; lit: number } {
  return { marks: words, lit: wordTiming ? Math.max(0, Math.min(words, word - first + 1)) : 0 };
}

/**
 * Whether Listen's Now playing card counts as on screen (FD 52): it stops once under 40% of it is in view and
 * starts again once over 60% is, so the mini doesn't flicker at one edge.
 */
export function cardOnScreen(was: boolean, card: { y: number; h: number }, scrollY: number, viewH: number): boolean {
  if (!card.h) return was;
  const inView = Math.max(0, Math.min(card.y + card.h, scrollY + viewH) - Math.max(card.y, scrollY)) / card.h;
  if (was && 0.4 > inView) return false;
  if (!was && inView > 0.6) return true;
  return was;
}
