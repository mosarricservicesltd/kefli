import { delay, minLeft, moveSentence, orpSplit, readWpm, sentenceAt, stream } from '../src/reader/rsvp';

const S1 = { text: 'The quick fox, then: 1999 arrived.', wordStarts: [0, 4, 10, 15, 21, 26], firstWord: 0 };
const S2 = { text: 'Again!', wordStarts: [0], firstWord: 6 };
const S3 = { text: 'A new paragraph starts here.', wordStarts: [0, 2, 6, 16, 23], firstWord: 7 };
const s = stream([S1, S2, S3], [{ firstWord: 0, words: 7 }, { firstWord: 7, words: 5 }]);

describe('Speed read (mobile spec 5.6, FD 21)', () => {
  test("the words from the spoken sentences, numbered as the article's", () => {
    expect(s.tokens.map((t) => t.w)).toEqual(['The', 'quick', 'fox,', 'then:', '1999', 'arrived.', 'Again!', 'A', 'new', 'paragraph', 'starts', 'here.']);
    expect(s.tokens.filter((t) => t.paraEnd).map((t) => t.w)).toEqual(['Again!', 'here.']);
    expect(s.starts).toEqual([0, 6, 7]);
  });

  test('the focus letter by length, after leading punctuation', () => {
    expect(orpSplit('a')).toEqual(['', 'a', '']);
    expect(orpSplit('quick')).toEqual(['q', 'u', 'ick']);
    expect(orpSplit('“paragraph')).toEqual(['“pa', 'r', 'agraph']);
    expect(orpSplit('extraordinarily')).toEqual(['extr', 'a', 'ordinarily']);
  });

  test("each word's time: long words and numbers, commas, sentence and paragraph ends, and the ease-in", () => {
    const at = (i: number) => delay(s.tokens[i], 10, 300);
    expect(at(0)).toBe(200);
    expect(at(2)).toBeCloseTo(360);
    expect(at(4)).toBeCloseTo(280);
    expect(at(5)).toBeCloseTo(500);
    expect(at(6)).toBeCloseTo(700);
    expect(delay({ w: 'paragraph', paraEnd: false }, 10, 300)).toBeCloseTo(280);
    expect(delay({ w: 'said.”', paraEnd: false }, 10, 300)).toBeCloseTo(500);
    // from 60 % speed after a start
    expect(delay(s.tokens[0], 0, 300)).toBeCloseTo(200 / 0.6);
    expect(delay(s.tokens[0], 5, 300)).toBeCloseTo(200 / 0.8);
  });

  test('previous goes to this sentence from its fourth word, else the one before; next to the next', () => {
    expect(sentenceAt(s, 4)).toEqual([0, 6]);
    expect(moveSentence(s, 4, -1)).toBe(0);
    expect(moveSentence(s, 8, -1)).toBe(6);
    expect(moveSentence(s, 1, -1)).toBe(0);
    expect(moveSentence(s, 4, 1)).toBe(6);
    expect(moveSentence(s, 10, 1)).toBe(10);
  });

  test('wpm is checked and minutes left never read under one', () => {
    expect(readWpm('450')).toBe(450);
    expect(readWpm('425')).toBe(300);
    expect(readWpm(null)).toBe(300);
    expect(readWpm('900')).toBe(300);
    expect(minLeft(s, 11, 300)).toBe(1);
    expect(minLeft({ tokens: Array(1000).fill({ w: 'x', paraEnd: false }), starts: [0] }, 0, 300)).toBe(4);
  });
});
