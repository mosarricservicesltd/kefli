// Sentences for the voice (mobile spec 5.6 and 8.1): a deterministic, rule-based splitter inside each
// block of the spoken projection, shared with iOS later. Every word belongs to exactly one sentence.
// Rules chosen on 6 October 2026, for the page fixtures to pin:
// - a sentence ends at a word ending in . ! ? or … (optionally followed by closing quotes or brackets)
//   when the next word starts with an upper-case letter, a digit, or an opening quote or bracket;
// - except after a listed abbreviation or a single-letter initial (J. R. R. Tolkien);
// - a block always ends a sentence.

import type { Projection } from './projection';

export type Sentence = {
  text: string;
  /** Start of each word within text, for the engine's character ranges. */
  wordStarts: number[];
  /** Index of the sentence's first word in the whole projection. */
  firstWord: number;
};

// The quotes and brackets that may close a sentence's last word or open the next one's. The patterns are built from
// strings, with the straight quotes escaped, since lizard (the code gate) loses its place in a regex literal holding
// quote marks and then scores nothing in this file.
const CLOSERS = '\u0022\u0027\u201d\u2019\u00bb)\\]}';
const OPENERS = '\u0022\u0027\u201c\u2018\u00ab(\\[';
const ENDS = new RegExp('[.!?\u2026][' + CLOSERS + ']*$');
const OPENS = new RegExp('^[\\p{Lu}\\p{Nd}' + OPENERS + ']', 'u');
const CLOSING = new RegExp('[' + CLOSERS + ']+$');
const OPENING = new RegExp('^[' + OPENERS + ']+');
const INITIAL = new RegExp('^\\p{L}\\.$', 'u');
const ABBREVIATIONS = new Set([
  'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'st.', 'mt.', 'jr.', 'sr.', 'vs.', 'e.g.', 'i.e.', 'no.', 'inc.', 'ltd.', 'co.', 'fig.', 'cf.', 'approx.',
]);

function endsSentence(word: string, next: string | undefined): boolean {
  if (next === undefined) return true;
  if (!ENDS.test(word) || !OPENS.test(next)) return false;
  const bare = word.replace(CLOSING, '').replace(OPENING, '').toLowerCase();
  if (ABBREVIATIONS.has(bare)) return false;
  return !INITIAL.test(bare);
}

export function sentences(p: Projection): Sentence[] {
  const out: Sentence[] = [];
  const words = p.wordStarts.map((s) => {
    const m = /\S+/y;
    m.lastIndex = s;
    return m.exec(p.text)![0];
  });
  // The block each word is in, so a block's last word always ends its sentence.
  let block = 0;
  const blockOf = p.wordStarts.map((s) => {
    while (block + 1 < p.blockStarts.length && p.blockStarts[block + 1] <= s) block++;
    return block;
  });
  let first = 0;
  for (let w = 0; w < words.length; w++) {
    const sameBlock = w + 1 < words.length && blockOf[w + 1] === blockOf[w];
    if (endsSentence(words[w], sameBlock ? words[w + 1] : undefined)) {
      const start = p.wordStarts[first];
      const end = p.wordStarts[w] + words[w].length;
      out.push({ text: p.text.slice(start, end), wordStarts: p.wordStarts.slice(first, w + 1).map((s) => s - start), firstWord: first });
      first = w + 1;
    }
  }
  return out;
}
