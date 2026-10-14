import { MAX_SENTENCE_CHARS, normaliseMarkdown, project, sentences } from '../src';

const split = (md: string) => sentences(project(normaliseMarkdown(md))).map((s) => s.text);

describe('sentence splitter', () => {
  test.each([
    ['simple', 'One thing. Another thing! A third? Yes.', ['One thing.', 'Another thing!', 'A third?', 'Yes.']],
    ['lower case after a stop is not a new sentence', 'See fig. three below.', ['See fig. three below.']],
    ['abbreviations', 'Mr. Smith met Dr. Jones. They talked.', ['Mr. Smith met Dr. Jones.', 'They talked.']],
    ['initials', 'J. R. R. Tolkien wrote it. Then he left.', ['J. R. R. Tolkien wrote it.', 'Then he left.']],
    ['closing quotes', 'He said “stop.” Then nothing.', ['He said “stop.”', 'Then nothing.']],
    ['digits start a sentence', 'It ended. 2024 was next.', ['It ended.', '2024 was next.']],
    ['decimals stay whole', 'It cost 3.50 pounds. Cheap.', ['It cost 3.50 pounds.', 'Cheap.']],
    ['ellipsis', 'Wait… Then go.', ['Wait…', 'Then go.']],
    ['blocks end sentences', '# Heading\n\nno stop here\n\nNext block', ['Heading.', 'no stop here', 'Next block']],
  ])('%s', (_n, md, want) => {
    expect(split(md)).toEqual(want);
  });

  test('a sentence that runs past the longest is split at a word, so the voice reads all of it', () => {
    // a PDF paragraph that never ends a sentence: before, one sentence of 60,000 characters, of which the system
    // voice spoke the first 4,000 and dropped the rest
    const p = project(normaliseMarkdown(Array.from({ length: 10_000 }, (_, i) => `word${i}`).join(' ')));
    const ss = sentences(p);
    expect(ss.length).toBeGreaterThan(20);
    for (const s of ss) expect(s.text.length).toBeLessThanOrEqual(MAX_SENTENCE_CHARS);
    expect(ss.map((s) => s.text).join(' ')).toBe(p.text);
    expect(ss.reduce((n, s) => n + s.wordStarts.length, 0)).toBe(10_000);
    // a word longer than the longest sentence stays whole
    const long = 'x'.repeat(MAX_SENTENCE_CHARS + 500);
    expect(split(`Before. ${long} after it. Then.`)).toEqual(['Before.', long, 'after it.', 'Then.']);
  });

  test('a word with a long run of closing quotes inside it is split in linear time', () => {
    // its closing quotes were stripped with a regex that backtracked over the run from each of its characters: 100,000
    // apostrophes before a full stop took 8 to 29 s, and 300,000 more than three minutes
    const quotes = "'".repeat(100_000);
    const brackets = ')'.repeat(100_000);
    const started = Date.now();
    expect(split(`Start ${quotes}. Next word.`)).toEqual(['Start', `${quotes}.`, 'Next word.']);
    expect(split(`(${brackets}! Then.`)).toEqual([`(${brackets}!`, 'Then.']);
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test('every word is in one sentence, with offsets into its text', () => {
    const p = project(normaliseMarkdown('# A title\n\nFirst one. Second one here.\n\n- item'));
    const ss = sentences(p);
    expect(ss.reduce((n, s) => n + s.wordStarts.length, 0)).toBe(p.wordStarts.length);
    let w = 0;
    for (const s of ss) {
      expect(s.firstWord).toBe(w);
      s.wordStarts.forEach((o, k) => expect(p.text.slice(p.wordStarts[w + k], p.wordStarts[w + k] + 1)).toBe(s.text[o]));
      w += s.wordStarts.length;
    }
  });
});
