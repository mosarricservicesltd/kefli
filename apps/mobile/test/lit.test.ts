// The voice's highlight in the playing block (mobile spec 6.7): the lit words split out, the rest left whole.
import { litPieces, type LitPiece } from '../src/reader/lit';

/** The Reader's split before: every word its own piece, counted across spans the same way. */
function everyWord(spans: { text: string }[], lit: { from: number; to: number }): LitPiece[][] {
  let k = -1;
  let wasSpace = true;
  return spans.map((s) => {
    const out: LitPiece[] = [];
    for (const piece of s.text.split(/(\s+)/)) {
      if (piece === '') continue;
      if (/^\s+$/.test(piece)) {
        wasSpace = true;
        out.push({ text: piece, on: false });
        continue;
      }
      if (wasSpace) k++;
      wasSpace = false;
      out.push({ text: piece, on: k >= lit.from && lit.to >= k });
    }
    return out;
  });
}

/** What shows: each span's text, with its lit stretches marked, for comparing the two splits. */
const shown = (pieces: LitPiece[][]) => pieces.map((ps) => ps.map((p) => (p.on ? `[${p.text}]` : p.text)).join(''));

describe('the lit words in the playing block (mobile spec 6.7)', () => {
  test('the same words lit as when every word was split out, across spans and words that run on between them', () => {
    const cases: { text: string }[][] = [
      [{ text: 'The first paragraph has ' }, { text: 'emphasis' }, { text: ', strong words and ' }, { text: 'a link' }, { text: '.' }],
      [{ text: 'run' }, { text: 'on' }, { text: ' words ' }, { text: '' }, { text: '  spaced\tout\n' }, { text: 'end' }],
      [{ text: '   ' }, { text: 'lead' }, { text: ' ' }],
      [{ text: '' }],
    ];
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n);
    const words = ['a', 'bb', 'ccc', 'dd.', '“q”', 'é'];
    for (let c = 0; c < 200; c++) cases.push(Array.from({ length: 1 + rand(6) }, () => ({ text: Array.from({ length: rand(5) }, () => words[rand(words.length)] + [' ', '', '  ', '\n'][rand(4)]).join('') })));
    for (const spans of cases) {
      for (const lit of [{ from: 0, to: 0 }, { from: 1, to: 3 }, { from: 2, to: 2 }, { from: 5, to: 40 }, { from: 100, to: 100 }]) {
        expect(shown(litPieces(spans, lit))).toEqual(shown(everyWord(spans, lit)));
      }
    }
  });

  test('a long block makes a handful of pieces, not one a word', () => {
    const text = Array.from({ length: 10_000 }, (_, i) => `word${i}`).join(' ');
    const spans = [{ text: text.slice(0, 30_000) }, { text: text.slice(30_000) }];
    const pieces = litPieces(spans, { from: 5_000, to: 5_000 });
    expect(pieces.flat().length).toBeLessThanOrEqual(4);
    // the Reader rendered each of these as its own piece, at each word the voice reached
    expect(everyWord(spans, { from: 5_000, to: 5_000 }).flat().length).toBeGreaterThan(19_000);
    expect(pieces.flat().filter((p) => p.on).map((p) => p.text)).toEqual(['word5000']);
    expect(pieces.map((ps) => ps.map((p) => p.text).join('')).join('')).toBe(text);
  });
});
