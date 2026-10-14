// The protocol's text code held to the implementations it replaced (./reference), which must agree with it exactly: the
// spoken projection decides words and word highlighting, the splitter what the voice is handed, and normalisation the
// text_hash. Compared on the page and PDF fixtures, on hostile Markdown at sizes the old code still takes, and on
// random Markdown built from the syntax each rule reads.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { PhrasingContent, Root } from 'mdast';
import { normaliseMarkdown, projectTree, sentences } from '../src';
import * as old from './reference/projection';
import { sentences as oldSentences } from './reference/sentences';
import { normaliseMarkdown as oldNormalise } from './reference/normalise';

const shared = join(__dirname, '../../../shared/fixtures');
const load = (path: string) => JSON.parse(readFileSync(join(shared, path), 'utf8'));

/**
 * The projection of md and its sentences, by both from one parse, as one value each: compared as JSON, which is quick,
 * and through expect only when they differ, to show where, with md beside it.
 */
function agrees(md: string): void {
  const tree = fromMarkdown(md);
  const p = projectTree(md, tree);
  const q = old.projectTree(md, tree);
  const mine = { md, p, s: sentences(p) };
  const theirs = { md, p: q, s: oldSentences(q) };
  if (JSON.stringify(mine) !== JSON.stringify(theirs)) expect(mine).toEqual(theirs);
}

/** A seeded generator (mulberry32), so a failure can be run again. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];

const NBSP = String.fromCharCode(0xa0);
const ACUTE = String.fromCharCode(0x301);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const TICKS = String.fromCharCode(96).repeat(3);

describe('the fixtures project as they did', () => {
  const pages = (load('expected.json').pages as { id: string; markdown: string | null }[]).filter((p) => p.markdown);
  const pdfs = (load('pdfs/expected.json').pdfs as { id: string; markdown?: string }[]).filter((p) => p.markdown);
  test.each([...pages, ...pdfs].map((p) => [p.id, p.markdown!]))('%s', (_id, md) => agrees(md));

  test('the protocol fixture text, raw and normalised', () => {
    const f = load('protocol/text.json');
    agrees(f.markdown);
    agrees(f.normalised);
  });
});

/** Hostile Markdown, each at a size the old code takes in a second or so: deeper or longer overflowed or stalled it. */
const HOSTILE: Record<string, string> = {
  'quotes 2,000 deep': '> '.repeat(2_000) + 'deep text',
  'lists 120 deep': Array.from({ length: 120 }, (_, i) => '  '.repeat(i) + '- item ' + i).join('\n'),
  'emphasis 400 deep': '*a '.repeat(400) + 'b' + ' a*'.repeat(400),
  'strong in emphasis 300 deep': '***'.repeat(300) + 'a' + '***'.repeat(300),
  'markers in emphasis': ('_[1](#cite_note-1)_ ' + '**[\\[2\\]](#fn2)** ' + '*_[↩︎](#fnref1)_* ').repeat(150),
  'tags in a row': '\\[_[citation needed](https://en.wikipedia.org/wiki/Wikipedia:Citation_needed)_\\]'.repeat(300) + ' then prose',
  'tags in emphasis': '\\[**_[dead link](https://en.wikipedia.org/wiki/Wikipedia:Link_rot)_**\\] '.repeat(200),
  // a skipped node takes the bracket either side of it, so what counts as skipped shows in the text around it
  'markers in emphasis between brackets': ('x\\[**[1](#cite_note-1)**\\]y ' + 'a[_[\\[2\\]](#fn2)_]b ' + '\\[*[↩︎](#fnref1)* more\\] ').repeat(100),
  'tags sharing their emphasis': ('\\[_[citation needed](https://en.wikipedia.org/wiki/Wikipedia:Citation_needed) more_\\] ' + '\\[**_[dead](https://en.wikipedia.org/wiki/Wikipedia:Link_rot)_ x**\\] ').repeat(100),
  'a reference list with notes in it': Array.from({ length: 300 }, (_, i) => `${i + 1}. ^ [↑](https://w.org/wiki/X#cite_ref-${i}) "A source". Retrieved 2009.\n   - a note [${i}](#fn${i})`).join('\n'),
  '1,000 links': Array.from({ length: 1_000 }, (_, i) => `[link ${i}](https://e.example/${i}#fn${i})`).join(' '),
  'a code block of 1,000 lines': TICKS + 'js\n' + Array.from({ length: 1_000 }, (_, i) => `  line(${i}); // *not* [a link]`).join('\n') + '\n' + TICKS,
  'code in lists and quotes': ('- item\n\n      indented code\n\n> ' + TICKS + '\n> quoted code\n> ' + TICKS + '\n\n1. step\n\n   ~~~\n   fenced\n   ~~~\n').repeat(100),
  'html blocks and inline html': ('<div>\nblock *words*\n</div>\n\nUse <b>bold</b> and <!-- a comment --> here.\n\n<!--\nopen\n').repeat(100),
  'references and escapes': '&amp; &#169; &#x263A; &nbsp; &bogus; &#0; &#xD800; &#1114112; \\* \\_ \\[ \\] \\\\ \\a '.repeat(200),
  'headings and breaks': ('# Heading\n## Why?\nSetext\n===\nline  \nnext\\\nlast\n\n').repeat(200),
  'reference links and definitions': ('A [ref][1] and [another][x] and [none][y].\n\n[1]: https://example.com\n[x]: <https://x.example> "title"\n\n').repeat(100),
  'images and autolinks': ('![alt *text*](i.png) <https://auto.example> ![ref][1] [![img](a.png)](#cite_note-9)\n\n').repeat(200),
  'a long word': 'x'.repeat(20_000),
  'a run of whitespace': 'a' + ' '.repeat(20_000) + NBSP.repeat(1_000) + '\t'.repeat(1_000) + 'b',
  'unclosed marks': '*a_ '.repeat(400) + '[x '.repeat(300) + '<a '.repeat(300),
  'closing quotes before a stop': 'Start ' + "'".repeat(3_000) + '. Next ' + '”'.repeat(2_000) + '! Then (' + ')'.repeat(1_000) + '? End.',
  'abbreviations and initials in quotes': '“Mr.” Smith (Dr.) Jones ‘e.g.’ More. “J.” R. R. Tolkien. «St.» Paul? (No.) 5 [Fig.] 3. '.repeat(200),
  'a paragraph that never ends a sentence': Array.from({ length: 5_000 }, (_, i) => `word${i}`).join(' '),
};

describe('hostile Markdown projects as it did', () => {
  test.each(Object.entries(HOSTILE))('%s', (_name, md) => {
    agrees(md);
    agrees(normaliseMarkdown(md));
  });
});

const at = (from: number, to: number) => ({ start: { line: 1, column: from + 1, offset: from }, end: { line: 1, column: to + 1, offset: to } });

/** A paragraph of a note's link inside emphasis nested depth deep, as the parse would make it, with text either side. */
function chain(depth: number, url: string): { md: string; tree: Root } {
  const before = 'Said ';
  const inner = `[1](${url})`;
  const close = before.length + 2 * depth + inner.length;
  const md = `${before}${'*'.repeat(depth)}${inner}${'*'.repeat(depth)} after.\n`;
  const s = before.length + depth;
  let node: PhrasingContent = { type: 'link', url, children: [{ type: 'text', value: '1', position: at(s + 1, s + 2) }], position: at(s, s + inner.length) };
  for (let d = depth - 1; d >= 0; d--) node = { type: 'emphasis', children: [node], position: at(before.length + d, close - d) };
  const kids: PhrasingContent[] = [{ type: 'text', value: before, position: at(0, before.length) }, node, { type: 'text', value: ' after.', position: at(close, close + 7) }];
  return { md, tree: { type: 'root', children: [{ type: 'paragraph', children: kids, position: at(0, md.length - 1) }] } };
}

test('a run of emphasis 1,000 deep around a link, silent or read, projects as it did', () => {
  for (const url of ['#cite_note-1', 'https://example.com/a', 'https://en.wikipedia.org/wiki/Wikipedia:X']) {
    const { md, tree } = chain(1_000, url);
    expect(projectTree(md, tree)).toEqual(old.projectTree(md, tree));
  }
});

test('trees of shapes the parse never makes project as they did', () => {
  // projectTree takes any tree: empty emphasis, nodes without positions, strikethrough, a node type of its own
  const md = 'a[*x*]b [1](#cite_note-1) ~~[2](#fn2)~~ c\n\n``` x ```\n';
  const text = (value: string, from?: number) => ({ type: 'text', value, ...(from === undefined ? {} : { position: at(from, from + value.length) }) });
  const shapes: unknown[][] = [
    [text('a[', 0), { type: 'emphasis', children: [] }, text(']b', 5)],
    [text('a[', 0), { type: 'strong', children: [{ type: 'emphasis', children: [] }] }, text(']b', 5)],
    [text('a[', 0), { type: 'delete', children: [{ type: 'link', url: '#cite_note-1', children: [] }] }, text(']b', 5)],
    [text('a[', 0), { type: 'emphasis', children: [{ type: 'link', url: 'https://w.org/wiki/Wikipedia:X', children: [] }, text('more')] }, text(']b', 5)],
    [text('unplaced'), { type: 'break' }, { type: 'inlineCode', value: 'x' }, text(' c', 39)],
    [{ type: 'footnoteReference', identifier: '1' }, { type: 'mystery', children: [text('a[', 0)] }],
  ];
  for (const kids of shapes) {
    const tree = { type: 'root', children: [
      { type: 'paragraph', children: kids, position: at(0, 39) },
      { type: 'heading', depth: 2, children: kids },
      { type: 'list', children: [{ type: 'listItem', children: [{ type: 'paragraph', children: kids }, { type: 'code', value: 'x' }, { type: 'html', value: '<b>' }] }] },
      { type: 'table', children: [{ type: 'paragraph', children: kids }] },
    ] } as unknown as Root;
    expect(projectTree(md, tree)).toEqual(old.projectTree(md, tree));
  }
});

/** The pieces random Markdown is made of: the syntax each rule of the projection and the splitter reads, and text. */
const PIECES = [
  'a', 'word', 'Then', 'more', 'Mr.', 'Dr.', 'J.', 'e.g.', 'fig.', '3.50', '2024', 'café', 'cafe' + ACUTE, 'ελληνικά', '日本語', 'x_y', 'snake_case_',
  '.', '!', '?', '…', ',', ';', ':', '"', "'", '“', '”', '‘', '’', '«', '»', '(', ')', '[', ']', '{', '}', '^', '↑', '↩︎',
  ' ', ' ', ' ', '  ', '\t', '\n', '\n', '\n\n', '\n\n\n', '\r\n', '\r', NBSP, LINE_SEPARATOR,
  '*', '**', '_', '__', '~', String.fromCharCode(96), TICKS, '~~~', '#', '## ', '> ', '- ', '* ', '+ ', '1. ', '2) ', '    ', '   ', '---', '***', '===',
  '\\', '\\*', '\\[', '\\]', '\\\\', '&amp;', '&#169;', '&#x263A;', '&nbsp;', '&bogus;', '&#0;', '&#xD800;',
  '<div>', '</div>', '<b>', '</b>', '<!--', '-->', '<br>', '<https://auto.example>',
  '[1](#cite_note-1)', '[\\[2\\]](#fn2)', '[3](https://x.substack.com/p/a#footnote-3)', '[↩︎](#fnref1)', '[^](#cite_ref-1)',
  '[↑](https://w.org/wiki/X#cite_ref-1)', '[citation needed](https://en.wikipedia.org/wiki/Wikipedia:Citation_needed)',
  '_[dead link](https://ja.wikipedia.org/wiki/Wikipedia:%E5%87%BA%E5%85%B8#x)_', '[guide](https://en.wikipedia.org/wiki/Wikipedia:Manual)',
  '[text](https://example.com)', '[ref][1]', '[1]: https://example.com', '![alt](i.png)', '[2](#section-2)', '[the note](#fn2)',
  '[a](https://w.org/wiki/X#%63ite_note-a)', '[bad](https://w.org/%E0%A4%A#%E0%A4%A)', '[IPA](https://el.wikipedia.org/wiki/Help:IPA)',
  'x[**[1](#cite_note-1)**]y', '\\[_[citation needed](https://en.wikipedia.org/wiki/Wikipedia:Citation_needed) more_\\]', '[_[2](#fn2)_]', '\\[**_[t](https://w.org/wiki/Wikipedia:T)_**\\]',
];

function randomMarkdown(r: () => number): string {
  return Array.from({ length: 1 + Math.floor(r() * 120) }, () => pick(r, PIECES)).join('');
}

describe('random Markdown projects as it did', () => {
  test('2,000 documents, raw and normalised', () => {
    const r = random(20261014);
    for (let n = 0; n < 2_000; n++) {
      const md = randomMarkdown(r);
      agrees(md);
      agrees(normaliseMarkdown(md));
    }
  });

  test('100 longer documents of many blocks', () => {
    const r = random(117);
    for (let n = 0; n < 100; n++) agrees(normaliseMarkdown(Array.from({ length: 12 }, () => randomMarkdown(r)).join('\n\n')));
  });
});

describe('normalisation agrees with the regex it replaced', () => {
  const SPACING = [' ', '  ', '\t', ' \t ', '\n', '\r\n', '\r', '\n\n\n\n', NBSP, LINE_SEPARATOR, 'a', 'é', 'e' + ACUTE, '#', '- ', '> ', '日'];

  test('on random spacing, line ends and letters', () => {
    const r = random(4);
    for (let n = 0; n < 5_000; n++) {
      const s = Array.from({ length: Math.floor(r() * 80) }, () => pick(r, SPACING)).join('');
      expect([s, normaliseMarkdown(s)]).toEqual([s, oldNormalise(s)]);
    }
  });

  test('on the fixtures, the hostile Markdown and long runs of spaces inside lines', () => {
    const pages = (load('expected.json').pages as { markdown?: string | null }[]).map((p) => p.markdown).filter((md): md is string => typeof md === 'string');
    const deep = Array.from({ length: 200 }, (_, i) => ' '.repeat(200) + `- item ${i}\t `).join('\n');
    for (const md of [...pages, ...Object.values(HOSTILE), deep, 'a' + ' '.repeat(5_000) + 'b \t\n', load('protocol/text.json').markdown]) {
      expect(normaliseMarkdown(md)).toBe(oldNormalise(md));
    }
  });
});
