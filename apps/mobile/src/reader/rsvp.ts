// Speed read (mobile spec 5.6, FD 21, FD 36, FD 71; prototype rsvp), platform-free: the article's words as one stream
// numbered as reading and listening number them, so all three share the one position; the focus letter; each word's
// time; moving by sentence.
import type { Sentence } from '@kefli/protocol';
import type { Block } from './blocks';

export const WPM_KEY = 'speedread.wpm';
export const WPM_MIN = 200;
export const WPM_MAX = 700;
export const WPM_STEP = 50;
export const WPM_DEFAULT = 300;

export type Token = { w: string; paraEnd: boolean };
export type Stream = { tokens: Token[]; starts: number[] };

/** A stored wpm, checked, on the 50 wpm steps (FD 21). */
export function readWpm(v: string | null): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= WPM_MIN && n <= WPM_MAX && n % WPM_STEP === 0 ? n : WPM_DEFAULT;
}

/** The words from the spoken sentences, with the last word of each block marked as a paragraph end. */
export function stream(sentences: Sentence[], blocks: Pick<Block, 'firstWord' | 'words'>[]): Stream {
  const tokens: Token[] = [];
  for (const s of sentences) {
    s.wordStarts.forEach((at, i) => {
      tokens[s.firstWord + i] = { w: s.text.slice(at, s.wordStarts[i + 1] ?? s.text.length).trim(), paraEnd: false };
    });
  }
  for (const b of blocks) if (b.words > 0 && tokens[b.firstWord + b.words - 1]) tokens[b.firstWord + b.words - 1].paraEnd = true;
  // a gap the projection left is never shown as a hole
  for (let i = 0; i < tokens.length; i++) tokens[i] ??= { w: '', paraEnd: false };
  return { tokens, starts: sentences.map((s) => s.firstWord) };
}

const core = (w: string) => w.replace(/[^\p{L}\p{N}]/gu, '');

/** The word split at its focus letter: leading punctuation, then 0 to 4 letters in by the word's length. */
export function orpSplit(w: string): [string, string, string] {
  const lead = (w.match(/^[^\p{L}\p{N}]*/u) ?? [''])[0].length;
  const n = core(w).length;
  const k = lead + (n <= 1 ? 0 : n <= 5 ? 1 : n <= 9 ? 2 : n <= 13 ? 3 : 4);
  return [w.slice(0, k), w.charAt(k), w.slice(k + 1)];
}

/**
 * How long a word shows (5.6 rsvp): 60,000 ÷ wpm, held for long words, numbers and pauses, easing in after a start.
 * No word at all (an article of images alone has none) shows for no time, so Play goes straight to the end.
 */
export function delay(t: Token | undefined, ramp: number, wpm: number): number {
  if (!t) return 0;
  let m = 1;
  if (core(t.w).length >= 9 || /\d/.test(t.w)) m = 1.4;
  if (/[,;:—–]$/.test(t.w)) m = Math.max(m, 1.8);
  if (/[.!?]["”’)\]]?$/.test(t.w)) m = 2.5;
  if (t.paraEnd) m = 3.5;
  if (ramp < 10) m /= 0.6 + 0.04 * ramp;
  return (60000 / wpm) * m;
}

/** The sentence a word is in: its start and the next sentence's. */
export function sentenceAt(s: Stream, i: number): [number, number] {
  let k = 0;
  for (let j = 0; j < s.starts.length; j++) if (s.starts[j] <= i) k = j;
  return [s.starts[k] ?? 0, s.starts[k + 1] ?? s.tokens.length];
}

/** Previous: this sentence's start from its fourth word on, otherwise the sentence before. Next: the next one's start. */
export function moveSentence(s: Stream, i: number, dir: -1 | 1): number {
  const [start] = sentenceAt(s, i);
  const k = s.starts.indexOf(start);
  if (dir < 0) return i - start > 2 || k <= 0 ? start : s.starts[k - 1];
  return s.starts[k + 1] ?? i;
}

/** "N min left" at this pace, never under one. */
export function minLeft(s: Stream, i: number, wpm: number): number {
  return Math.max(1, Math.ceil((s.tokens.length - i) / wpm));
}
