import { countWords, normaliseMarkdown, project } from '../src';

const spoken = (md: string) => project(normaliseMarkdown(md)).text;

describe('spoken projection (C§4.2)', () => {
  test.each([
    ['syntax removed', '# Title\n\nSome *emphasis*, **strong** and `code`.', 'Title.\n\nSome emphasis, strong and code.'],
    ['link text kept, target dropped', 'See [the docs](https://example.com/docs "t").', 'See the docs.'],
    ['images dropped with their alt', 'Before ![a chart of things](c.png) after.', 'Before after.'],
    ['an image-only paragraph leaves no block', 'One.\n\n![alt](i.png)\n\nTwo.', 'One.\n\nTwo.'],
    ['escapes resolved', 'Price \\*not\\* \\_this\\_ \\[x\\]', 'Price *not* _this_ [x]'],
    ['references resolved', 'Fish &amp; chips &#169; &#x263A; &nbsp;end', 'Fish & chips © ☺ end'], // a no-break space is whitespace too
    ['heading gains a full stop', '## A heading', 'A heading.'],
    ['heading ending ? keeps it', '## Why?', 'Why?'],
    ['closing quote after the stop', '## He said “go.”', 'He said “go.”'],
    ['closing bracket after the stop', '- (an aside.)', '(an aside.)'],
    ['list items gain full stops', '- one\n- two!\n- three', 'one.\n\ntwo!\n\nthree.'],
    ['ordered list', '1. first\n2. second', 'first.\n\nsecond.'],
    ['nested list items each gain one', '- outer\n  - inner', 'outer.\n\ninner.'],
    ['paragraph ends are left alone', 'No stop here', 'No stop here'],
    ['soft line breaks become spaces', 'one\ntwo\nthree', 'one two three'],
    ['blockquote lines joined', '> quoted\n> more', 'quoted more'],
    ['raw HTML is read as written', 'Use <b> for bold\n\n<div>\nhtml block words here\n</div>', 'Use <b> for bold\n\n<div> html block words here </div>'],
    ['thematic break is silent', 'a\n\n---\n\nb', 'a\n\nb'],
    ['reference links keep their text', 'A [ref][1] here.\n\n[1]: https://example.com', 'A ref here.'],
    ['code blocks are read', '```\nlet a = 1;\nlet b;\n```', 'let a = 1; let b;'],
  ])('%s', (_name, md, want) => {
    expect(spoken(md)).toBe(want);
  });

  test('words are whitespace tokens', () => {
    expect(countWords(normaliseMarkdown('# Two words\n\n- a b c\n\nend.'))).toBe(6);
    expect(countWords('\n')).toBe(0);
  });

  test('every spoken character maps back to itself, apart from resolved references', () => {
    const md = normaliseMarkdown([
      '# A *mixed* `page`', '', 'With [a link](https://x.example) and \\*stars\\* and caf&eacute;.', '',
      '- item one', '  continued', '- item **two**', '', '> quote one', '> quote two', '', '```js', '  indented();', '```',
    ].join('\n'));
    const p = project(md);
    for (let i = 0; i < p.text.length; i++) {
      const c = p.text[i];
      if (/\s/.test(c) || c === '.' && md[p.offsets[i]] !== '.') continue;
      if (c === 'é') expect(md.slice(p.offsets[i], p.offsets[i] + 8)).toBe('&eacute;');
      else expect([i, md[p.offsets[i]]]).toEqual([i, c]);
    }
    for (let i = 1; i < p.offsets.length; i++) expect(p.offsets[i]).toBeGreaterThanOrEqual(p.offsets[i - 1]);
  });

  test('indented and quoted code blocks map inside the source', () => {
    for (const md of ['para\n\n    code here\n', '> ```\n> quoted code\n> ```\n']) {
      const p = project(md);
      const at = p.text.indexOf('code');
      expect(md.slice(p.offsets[at], p.offsets[at] + 4)).toBe('code');
      expect(Math.max(...p.offsets)).toBeLessThan(md.length);
    }
  });

  test('word starts and block starts', () => {
    const p = project(normaliseMarkdown('# Hi there\n\nOne two.'));
    expect(p.text).toBe('Hi there.\n\nOne two.');
    expect(p.wordStarts).toEqual([0, 3, 11, 15]);
    expect(p.blockStarts).toEqual([0, 11]);
  });
});
