import { normaliseMarkdown, project, sentences } from '../src';

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
