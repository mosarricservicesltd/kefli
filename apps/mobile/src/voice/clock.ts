// The listening clock and choices (mobile spec 5.7), platform-free: on-device speech has no duration, so time is
// the word reached over words a second at the rate. The speed pill steps 1, 1.5, 2, 0.5 and back to 1 (FD 107).
// Where a session starts: the saved word if it is on screen, otherwise the first word in view (FD 19).
export const RATES = [0.5, 1, 1.5, 2] as const;
/** Words a second at rate 1, before a voice is measured (T§2). */
export const WPS_SEED = 3.9;

/**
 * The step nearest a rate. The engine keeps the rate as a 32-bit float, so a step can come back as
 * 1.2000000476837158; a rate is snapped wherever it enters, or the pill would print it whole and lose its place.
 */
export function snapRate(rate: number): number {
  return RATES.reduce((best, r) => (Math.abs(rate - best) > Math.abs(rate - r) ? r : best), 1 as number);
}

export function nextRate(rate: number): number {
  const i = (RATES as readonly number[]).indexOf(snapRate(rate));
  return RATES[(i + 1) % RATES.length];
}

export function seconds(word: number, wps: number, rate: number): number {
  'worklet'; // also run by the card's ruler on the UI thread (FD 115)
  return Math.max(0, Math.round(word / (wps * rate)));
}

const pad2 = (n: number) => String(Math.floor(n)).padStart(2, '0');

/** m:ss, and h:mm:ss from an hour (the prototype's fmt). */
export function clock(s: number): string {
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad2((s % 3600) / 60)}:${pad2(s % 60)}` : `${Math.floor(s / 60)}:${pad2(s % 60)}`;
}

export function rateLabel(rate: number): string {
  return `${snapRate(rate)}×`;
}

/** The start word: the saved word when it lies in view, else the first word in view; a finished article from 0. */
export function startWord(saved: number, inView: { first: number; last: number }, words: number): number {
  if (words === 0 || saved >= words - 1) return inView.first >= words - 1 ? 0 : inView.first;
  return saved >= inView.first && saved <= inView.last ? saved : inView.first;
}

/** A stored speed or words-a-second value, checked; a speed from the old steps (0.8, 1.2) reads as 1. */
export function readRate(v: string | null): number {
  const n = Number(v);
  return (RATES as readonly number[]).includes(n) ? n : 1;
}

export function readWps(v: string | null): number {
  const n = Number(v);
  return n >= 1 && n <= 8 ? n : WPS_SEED;
}

/**
 * Where a voice's words a second at a rate are kept (FD 107). A voice's speed doesn't scale with the rate, so each
 * rate has its own; 1× keeps the key it always had, so what was learned before stays.
 */
export function wpsKey(voice: string, rate: number): string {
  const r = snapRate(rate);
  return r === 1 ? `voice.wps.${voice}` : `voice.wps.${voice}@${r}`;
}

/**
 * How a rate's words a second stand to 1×'s before it has been heard, from Google's en-GB voice on the Pixel
 * (11 October 2026: 0.5× reads at about 0.65×, as the voice goes no slower; 2× is tuned in the engine to a true
 * 2×). RULED: a seed only; the engine learns the real value.
 */
const RATE_SEED: Record<number, number> = { 0.5: 1.3, 1: 1, 1.5: 1, 2: 1 };

/** A voice's words a second at a rate: its own once measured, else 1×'s scaled by the seed. */
export function wpsFor(get: (key: string) => string | null, voice: string, rate: number): number {
  const own = get(wpsKey(voice, rate));
  if (own !== null && readWps(own) === Number(own)) return Number(own);
  return readWps(get(wpsKey(voice, 1))) * (RATE_SEED[snapRate(rate)] ?? 1);
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
  const inView = cardInView(card, scrollY, viewH);
  if (was && 0.4 > inView) return false;
  if (!was && inView > 0.6) return true;
  return was;
}

/** The share of the card in view (FD 52's measure); a card not yet laid out counts as in view. */
export function cardInView(card: { y: number; h: number }, scrollY: number, viewH: number): number {
  if (!card.h) return 1;
  return Math.max(0, Math.min(card.y + card.h, scrollY + viewH) - Math.max(card.y, scrollY)) / card.h;
}

/**
 * The word at a point on the card's ruler (FD 115): the share of the article's words the point is across, to the
 * word, as a double-tap in the Reader lands (FD 107), within the article.
 */
export function wordAt(share: number, words: number): number {
  'worklet'; // also run by the card's ruler on the UI thread (FD 115)
  if (!(words > 0) || !Number.isFinite(share)) return 0;
  return Math.max(0, Math.min(words - 1, Math.round(share * words)));
}

/** A screen reader's step on the ruler (FD 115): a twentieth of the article, at least a word, within it. */
export function stepWord(word: number, words: number, dir: 1 | -1): number {
  if (!(words > 0)) return 0;
  return Math.max(0, Math.min(words - 1, word + dir * Math.max(1, Math.round(words / 20))));
}

/** The ruler's value for a screen reader (FD 115): the card's two clocks, elapsed and total. */
export function positionClocks(word: number, words: number, wps: number, rate: number): [string, string] {
  return [clock(seconds(word, wps, rate)), clock(seconds(words, wps, rate))];
}
