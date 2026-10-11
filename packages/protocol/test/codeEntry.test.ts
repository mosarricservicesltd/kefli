import { wordlist } from '@scure/bip39/wordlists/english.js';
import { emptyCodeEntry, settledWord, typeIntoCode, type CodeEntry } from '../src';

/** Keys as a keyboard sends them: each one appends to the focused field's text; '\b' takes the last letter off. */
function type(keys: string, s: CodeEntry = emptyCodeEntry()): CodeEntry {
  for (const k of keys) {
    const i = s.focus ?? 0;
    const shown = s.words[i];
    s = typeIntoCode(s, i, k === '\b' ? shown.slice(0, -1) : shown + k);
  }
  return s;
}
const filled = (s: CodeEntry) => s.words.filter(Boolean);

describe('recovery words fill themselves in (decision 106)', () => {
  test('a start that fits one word settles it; one that fits several, or none, or a whole word, does not', () => {
    expect(settledWord('aba')).toBe('abandon');
    expect(settledWord('ab')).toBeNull();
    expect(settledWord('act')).toBeNull(); // a word, and the start of action, actor, actress, actual
    expect(settledWord('xyz')).toBeNull();
    expect(settledWord('')).toBeNull();
  });

  test('every word settles within four letters, bar the 49 that begin others', () => {
    const by = [0, 0, 0, 0, 0];
    let never = 0;
    for (const w of wordlist) {
      const k = [1, 2, 3, 4].find((n) => settledWord(w.slice(0, n)) === w);
      if (k) by[k]++;
      else never++;
    }
    expect({ two: by[2], three: by[3], four: by[4], never }).toEqual({ two: 34, three: 604, four: 1361, never: 49 });
  });

  test.each([
    ['a fast typist runs on past the fill', 'abandon zoo', ['abandon', 'zoo']],
    ['the next word straight after the fill', 'abazoo', ['abandon', 'zoo']],
    ['stopping a letter late', 'abanzoo', ['abandon', 'zoo']],
    ['a word that begins others ends with a space', 'act zoo', ['act', 'zoo']],
    ['a leftover that is itself a word is swallowed once', 'attract act ', ['attract', 'act']],
    ['the whole word then the next, with no space', 'abandonkey', ['abandon', 'key']],
    ['deleting never fills', 'aband\b\b', ['abandon']],
    ['a whole word that begins no other moves on, and the habitual space is swallowed', 'zoo zebra', ['zoo', 'zebra']],
  ])('%s', (_name, keys, want) => {
    expect(filled(type(keys))).toEqual(want);
  });

  test('the field that swallows shows nothing, and focus stays on it', () => {
    const s = type('abaNd'.toLowerCase());
    expect(s.words.slice(0, 2)).toEqual(['abandon', '']);
    expect(s.focus).toBe(1);
    expect(s.spill).toEqual({ at: 1, rest: 'ndon', typed: 'nd' });
  });

  test('moving to another field drops the swallowing', () => {
    let s = type('aba');
    s = typeIntoCode(s, 5, 'n');
    expect(s.spill).toBeNull();
    expect(s.words[5]).toBe('n');
  });

  test('deleting into a whole word does not fill it again', () => {
    let s = emptyCodeEntry();
    s = typeIntoCode(s, 0, 'abandon');
    s = typeIntoCode(s, 0, 'aband');
    expect(s.words[0]).toBe('aband');
    expect(s.focus).toBe(0);
  });

  test('the last word fills in and keeps focus', () => {
    const s = typeIntoCode({ ...emptyCodeEntry(), focus: 11 }, 11, 'aba');
    expect(s.words[11]).toBe('abandon');
    expect(s.focus).toBe(11);
    expect(s.spill).toBeNull();
  });

  test('a whole code pasted fills all twelve and lets the keyboard go', () => {
    const code = 'harbor lemon candle rescue orbit velvet noble garden shadow tiger across museum';
    const s = typeIntoCode(emptyCodeEntry(), 3, code);
    expect(s.words.join(' ')).toBe(code);
    expect(s.focus).toBeNull();
  });

  test('a few words pasted fill on from the field, with commas too', () => {
    const s = typeIntoCode(emptyCodeEntry(), 2, 'harbor, lemon candle');
    expect(s.words.slice(0, 6)).toEqual(['', '', 'harbor', 'lemon', 'candle', '']);
    expect(s.focus).toBe(5);
  });
});
