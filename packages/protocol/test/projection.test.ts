import type { PhrasingContent, Root } from 'mdast';
import { countWords, normaliseMarkdown, project, projectTree } from '../src';

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
    // Citation and footnote markers (flow decision 102)
    ['a citation marker is silent', 'In 1993.[\\[3\\]](https://en.wikipedia.org/wiki/Bookmark_\\(digital\\)#cite_note-3) Next.', 'In 1993. Next.'],
    ['any text to #cite_note- is silent', 'である[\\[原 1\\]](https://ja.wikipedia.org/wiki/X#cite_note-1)。', 'である。'],
    ['a percent-encoded fragment', 'Word[\\[a\\]](https://el.wikipedia.org/wiki/X#%63ite_note-a) on.', 'Word on.'],
    ['bracketed IPA linking elsewhere is read', 'Greek [\\[eliniˈka\\]](https://el.wikipedia.org/wiki/Help:IPA) here.', 'Greek [eliniˈka] here.'],
    ['citation needed goes with its brackets', 'A claim.\\[_[citation needed](https://en.wikipedia.org/wiki/Wikipedia:Citation_needed "Wikipedia:Citation needed")_\\] Then more.', 'A claim. Then more.'],
    ['a localised dead-link tag goes', '[本](http://a.example/)\\[_[リンク切れ](https://ja.wikipedia.org/wiki/Wikipedia:%E5%87%BA%E5%85%B8#x)_\\] - 一覧。', '本 - 一覧。'],
    ['a tag without emphasis goes', '[書](http://a.example/)\\[[永久失效連結](https://zh.wikipedia.org/wiki/Wikipedia:%E5%A4%B1%E6%95%88 "Wikipedia:失效链接")\\]', '書'],
    ['a project page in prose is read', 'Read [the style guide](https://en.wikipedia.org/wiki/Wikipedia:Manual_of_Style) first.', 'Read the style guide first.'],
    ['bracketed IPA to a help page is read', 'Said \\[[ˈbʊk](https://en.wikipedia.org/wiki/Help:IPA/English)\\] aloud.', 'Said [ˈbʊk] aloud.'],
    ['a numbered footnote is silent', 'A point[1](https://x.substack.com/p/a#footnote-1) made.', 'A point made.'],
    ['an fn footnote is silent', 'A point[\\[2\\]](#fn2) made.', 'A point made.'],
    ['a number to another fragment is read', 'See [2](#section-2) below.', 'See 2 below.'],
    ['a word to a footnote is read', 'See [the note](#fn2) below.', 'See the note below.'],
    ['footnote back-link is silent', 'The note itself. [↩︎](#fnref1)', 'The note itself.'],
    ['reference entries are silent', 'Body.\n\n1. [↑](https://w.org/wiki/X#cite_ref-1) "A source". Retrieved 2009.\n2. [↑](https://w.org/wiki/X#cite_ref-2) Another.', 'Body.'],
    ['an entry with numbered back-links', '1. [1](https://w.org/wiki/X#cite_ref-a_1-0) [2](https://w.org/wiki/X#cite_ref-a_1-1) A source.', ''],
    ['an entry opening with a caret', '1. ^ [**1.0**](https://zh.wikipedia.org/wiki/X#cite_ref-1) 来源。', ''],
    ['an ordinary list item opening with a link is read', '1. [A source](https://example.com) worth reading.', 'A source worth reading.'],
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

  test('text around a skipped marker still maps to itself', () => {
    const md = normaliseMarkdown('A claim.\\[_[citation needed](https://en.wikipedia.org/wiki/Wikipedia:Citation_needed)_\\] Then[\\[1\\]](https://w.org/wiki/X#cite_note-1) more.');
    const p = project(md);
    expect(p.text).toBe('A claim. Then more.');
    for (let i = 0; i < p.text.length; i++) if (!/\s/.test(p.text[i])) expect([i, md[p.offsets[i]]]).toEqual([i, p.text[i]]);
    for (let i = 1; i < p.offsets.length; i++) expect(p.offsets[i]).toBeGreaterThanOrEqual(p.offsets[i - 1]);
  });

  test('a code block holding characters outside the BMP maps every character to itself', () => {
    // its map was counted in characters where its text counts UTF-16 units, so each emoji dropped an offset: the rest of
    // the block mapped to the wrong place, and its last characters and the blank line after it to none
    const emoji = String.fromCodePoint(0x1f600);
    const fence = '`'.repeat(3);
    const blocks = [`${fence}\na${emoji}b c\nnext ${emoji}${emoji} line\n${fence}\n\nafter it`, `    a${emoji}b c\n    next line\n\nafter it`];
    for (const md of blocks.map(normaliseMarkdown)) {
      const p = project(md);
      expect(p.offsets.length).toBe(p.text.length);
      for (let i = 0; i < p.text.length; i++) if (!/\s/.test(p.text[i])) expect([i, md[p.offsets[i]]]).toEqual([i, p.text[i]]);
      for (let i = 1; i < p.offsets.length; i++) expect(p.offsets[i]).toBeGreaterThanOrEqual(p.offsets[i - 1]);
    }
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

describe('blocks of any length (a long <pre>, a PDF paragraph that never ends a sentence)', () => {
  // Each was past V8's stack at about 150,000 characters while the projection spread a block's offsets into push(),
  // and collapsing a block's whitespace was quadratic (57 s for this paragraph once the spread was gone; now 1 s).
  test('a paragraph of 400,000 characters is projected, every character mapped, in linear time', () => {
    const md = normaliseMarkdown('word '.repeat(80_000));
    const started = Date.now();
    const p = project(md);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(p.wordStarts.length).toBe(80_000);
    expect(p.offsets.length).toBe(p.text.length);
    expect(p.offsets[p.offsets.length - 1]).toBe(md.length - 2);
  });

  test('a code line of 400,000 characters is one word', () => {
    const md = normaliseMarkdown('```\n' + 'x'.repeat(400_000) + '\n```');
    expect(countWords(md)).toBe(1);
    expect(project(md).offsets.length).toBe(400_000);
  });

  // The cases the hardening named, each past the stack or quadratic before the commit above
  test('a paragraph that is one word of a million characters', () => {
    const md = normaliseMarkdown('x'.repeat(1_000_000));
    const p = project(md);
    expect(p.wordStarts).toEqual([0]);
    expect(p.offsets[999_999]).toBe(999_999);
  });

  test('20,000 links in one paragraph, every one read', () => {
    const md = normaliseMarkdown(Array.from({ length: 20_000 }, (_, i) => `[l${i}](https://e.example/${i})`).join(' '));
    const p = project(md);
    expect(p.wordStarts.length).toBe(20_000);
    expect(p.text.slice(-13)).toBe('l19998 l19999');
    const last = p.offsets[p.text.length - 6];
    expect(md.slice(last - 1, last + 7)).toBe('[l19999]');
  });

  test('a code block of 16,000 lines is read in linear time', () => {
    const lines = Array.from({ length: 16_000 }, (_, i) => `line ${i} = value;`);
    const md = normaliseMarkdown('```\n' + lines.join('\n') + '\n```');
    const started = Date.now();
    const p = project(md);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(p.text).toBe(lines.join(' '));
    expect(p.offsets.length).toBe(p.text.length);
  });
});

const at = (from: number, to: number) => ({ start: { line: 1, column: from + 1, offset: from }, end: { line: 1, column: to + 1, offset: to } });

/** Text as written in the Markdown and as the parse decodes it. */
type Piece = { md: string; value: string };

/**
 * A paragraph of before, then inner inside emphasis nested depth deep, then after, as a tree with the positions the
 * parse gives: built by hand, since the parse of a run so deep takes minutes. inner.node(s) makes the innermost node,
 * its Markdown starting at offset s.
 */
function nested(depth: number, inner: { md: string; node: (s: number) => PhrasingContent }, before?: Piece, after?: Piece): { md: string; tree: Root } {
  const open = before?.md.length ?? 0;
  const close = open + 2 * depth + inner.md.length;
  const md = `${before?.md ?? ''}${'*'.repeat(depth)}${inner.md}${'*'.repeat(depth)}${after?.md ?? ''}\n`;
  let node = inner.node(open + depth);
  for (let d = depth - 1; d >= 0; d--) node = { type: 'emphasis', children: [node], position: at(open + d, close - d) };
  const kids: PhrasingContent[] = [node];
  if (before) kids.unshift({ type: 'text', value: before.value, position: at(0, open) });
  if (after) kids.push({ type: 'text', value: after.value, position: at(close, close + after.md.length) });
  return { md, tree: { type: 'root', children: [{ type: 'paragraph', children: kids, position: at(0, md.length - 1) }] } };
}

/** A link to url whose text is text, written [text](url) from offset s. */
const link = (url: string, text: string) => (s: number): PhrasingContent => ({
  type: 'link', url, children: [{ type: 'text', value: text, position: at(s + 1, s + 1 + text.length) }], position: at(s, s + text.length + url.length + 4),
});

describe('nesting of any depth (the walk keeps a stack of its own)', () => {
  // The walk recursed once a level: quotes 5,000 deep overflowed desktop V8's stack, which is deeper than the phone's
  // Hermes; and a run of nested emphasis was decided afresh at every level, in time quadratic in its depth.
  test('quotes 10,000 deep are read, the words mapped to their place', () => {
    const md = normaliseMarkdown('> '.repeat(10_000) + 'deep text');
    const p = project(md);
    expect(p.text).toBe('deep text');
    expect(p.wordStarts).toEqual([0, 5]);
    expect(md.slice(p.offsets[0], p.offsets[0] + 9)).toBe('deep text');
  });

  test('emphasis 100,000 deep is read', () => {
    const { md, tree } = nested(100_000, { md: 'a', node: (s) => ({ type: 'text', value: 'a', position: at(s, s + 1) }) });
    const p = projectTree(md, tree);
    expect(p.text).toBe('a');
    expect(p.offsets).toEqual([100_000]);
  });

  test('a citation marker 100,000 deep in emphasis is silent, as is a maintenance tag with its brackets', () => {
    const note = nested(100_000, { md: '[1](#cite_note-1)', node: link('#cite_note-1', '1') }, { md: 'Before ', value: 'Before ' }, { md: ' after.', value: ' after.' });
    expect(projectTree(note.md, note.tree).text).toBe('Before after.');
    const url = 'https://en.wikipedia.org/wiki/Wikipedia:Citation_needed';
    const tag = nested(100_000, { md: `[citation needed](${url})`, node: link(url, 'citation needed') }, { md: 'A claim.\\[', value: 'A claim.[' }, { md: '\\] Then more.', value: '] Then more.' });
    const p = projectTree(tag.md, tag.tree);
    expect(p.text).toBe('A claim. Then more.');
    expect(tag.md.slice(p.offsets[9], p.offsets[9] + 4)).toBe('Then');
  });
});
