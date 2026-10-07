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
