// Hostile and outsized Markdown through the Reader's derive (mobile spec 6.7): every save's text goes through
// deriveArticle on the JS thread (a phone's parse, a browser's save, sync, the Reader's own re-derive), so it must
// neither throw nor take minutes. Past what the CommonMark parse and the spoken projection take in linear time, the
// text is read plain: kept whole, as paragraphs, every word in a block and a sentence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveArticle, type Derived } from '../src/reader/blocks';
import { LIMITS, beyondLimits } from '../src/reader/limits';

/** The derive's result and how long it took, in ms. */
function timed(md: string): [Derived, number] {
  const t = Date.now();
  const d = deriveArticle(md);
  return [d, Date.now() - t];
}

/** The article holds together: blocks' words add up, and sentences take every word once, in order. */
function whole(d: Derived) {
  expect(d.blocks.reduce((s, b) => s + b.words, 0)).toBe(d.words);
  let next = 0;
  const wrong: string[] = [];
  for (const s of d.sentences) {
    if (s.firstWord !== next || s.wordStarts[0] !== 0) wrong.push(`sentence at word ${next}`);
    if (s.wordStarts.some((at) => !/\S/.test(s.text[at]) || (at > 0 && !/\s/.test(s.text[at - 1])))) wrong.push(`a word start in "${s.text.slice(0, 40)}"`);
    next += s.wordStarts.length;
  }
  expect(wrong).toEqual([]);
  expect(next).toBe(d.words);
}

const spans = (d: Derived) => d.blocks.flatMap((b) => ('spans' in b ? b.spans.map((s) => s.text) : 'text' in b ? [b.text] : [])).join(' ');

// Generous for a loaded machine: before the guards each of these took from 10 s to several minutes, or threw.
const QUICK_MS = 4_000;

describe('deriveArticle on hostile Markdown (mobile spec 6.7)', () => {
  test('inline code ending in a long run of spaces takes linear time', () => {
    // under the block limit, so the article is still parsed as written: the last span's trailing spaces are counted
    // back by hand, where / +$/ took 3 s on 60,000 of them and 10 s on 100,000
    const [d, ms] = timed(`a \`${' '.repeat(60_000)}x\``);
    expect(ms).toBeLessThan(1_500);
    expect(d.blocks).toEqual([expect.objectContaining({ kind: 'p', spans: [{ text: 'a ' }, { code: true, text: `${' '.repeat(60_000)}x` }] })]);
    expect(d.words).toBe(2);
    whole(d);
  });

  test('thousands of unclosed html comments in a paragraph (literal text, which Turndown leaves unescaped)', () => {
    const [d, ms] = timed(`</${'<!--'.repeat(10_000)}\n`);
    expect(ms).toBeLessThan(QUICK_MS);
    expect(d.spoken).toContain('<!--<!--');
    whole(d);
  });

  test('emphasis marks that never match, also in an image description (Turndown leaves alt text unescaped)', () => {
    const [d, ms] = timed('*a_ '.repeat(6_000));
    expect(ms).toBeLessThan(QUICK_MS);
    expect(d.words).toBe(6_000);
    whole(d);
    // an image says nothing, as in the projection, and stays an image
    const [img, imgMs] = timed(`![${'*a_ '.repeat(6_000)}](https://e.com/p.png)\n`);
    expect(imgMs).toBeLessThan(QUICK_MS);
    expect(img.blocks).toEqual([expect.objectContaining({ kind: 'img', src: 'https://e.com/p.png' })]);
    whole(img);
  });

  test('a list nested 500 deep, as Turndown indents it', () => {
    const md = Array.from({ length: 500 }, (_, i) => `${'    '.repeat(i)}-   item ${i}`).join('\n');
    const [d, ms] = timed(md);
    expect(ms).toBeLessThan(QUICK_MS);
    expect(spans(d)).toContain('item 499');
    whole(d);
  });

  test('quotes nested 5,000 deep keep their text', () => {
    const [d, ms] = timed(`${'>'.repeat(5_000)} the quoted words\n`);
    expect(ms).toBeLessThan(QUICK_MS);
    expect(d.spoken).toContain('the quoted words');
    whole(d);
  });

  test('one paragraph of 50,000 words, and one word of a million characters', () => {
    const para = Array.from({ length: 50_000 }, (_, i) => ['saving', 'reading', 'later', 'quiet'][i % 4]).join(' ');
    const [d, ms] = timed(`${para}\n`);
    expect(ms).toBeLessThan(QUICK_MS);
    expect(d.words).toBe(50_000);
    whole(d);
    const [w] = timed(`Start ${'x'.repeat(1_000_000)} end.\n`);
    expect(w.words).toBe(3);
    whole(w);
  });

  test('a code block of 20,000 lines stays a code block', () => {
    const [d, ms] = timed(`Before.\n\n\`\`\`\n${'line of code\n'.repeat(20_000)}\`\`\`\n\nAfter.\n`);
    expect(ms).toBeLessThan(QUICK_MS);
    expect(d.blocks.map((b) => b.kind)).toEqual(['p', 'code', 'p']);
    expect((d.blocks[1] as { text: string }).text.split('\n')).toHaveLength(20_000);
    expect(d.words).toBe(2 + 60_000);
    whole(d);
  });

  test('read plain, escapes are taken out and headings stay headings', () => {
    const md = `# The title\n\nA \\*starred\\* word ${'<!--'.repeat(2_000)}\n`;
    const d = deriveArticle(md);
    expect(d.blocks[0]).toMatchObject({ kind: 'h', level: 1, spans: [{ text: 'The title' }] });
    expect(spans(d)).toContain('A *starred* word');
    expect(d.spoken.startsWith('The title.\n\nA *starred* word')).toBe(true);
    whole(d);
  });
});

describe('deriveArticle on real pages', () => {
  // the page fixtures every platform passes: the guard leaves their derive exactly as it was
  const pages = (JSON.parse(readFileSync(join(__dirname, '../../../shared/fixtures/expected.json'), 'utf8')) as {
    pages: { id: string; markdown?: string; spoken?: string; words?: number }[];
  }).pages.filter((p) => p.markdown);

  test.each(pages.map((p) => [p.id, p] as const))('%s derives as before', (_id, p) => {
    expect(beyondLimits(p.markdown!)).toBe(false);
    const d = deriveArticle(p.markdown!);
    expect(d.spoken).toBe(p.spoken);
    expect(d.words).toBe(p.words);
    whole(d);
  });
});

const FENCE = '```';

describe('the scan that says when Markdown is read plain (reader/limits)', () => {
  const bad = '*a_ '.repeat(2_000);

  test('fenced code is code: its marks do not count, in a list item as Turndown indents it too', () => {
    expect(beyondLimits(`${FENCE}\n${bad}\n${FENCE}\n`)).toBe(false);
    expect(beyondLimits(`~~~~\n${bad}\n~~~~\n`)).toBe(false);
    expect(beyondLimits(`> ${FENCE}\n> ${bad}\n> ${FENCE}\n`)).toBe(false);
    const code = '    a[i] = b[j] * c_d;\n'.repeat(300);
    expect(beyondLimits(`1.  A step\n\n    ${FENCE}\n${code}    ${FENCE}\n\n2.  The next\n`)).toBe(false);
    expect(beyondLimits(`-   An item\n\n    ${FENCE}js\n${code}    ${FENCE}\n`)).toBe(false);
  });

  test("a fence the parse wouldn't open, or has left, hides no marks", () => {
    const cases: Record<string, string> = {
      // an ordered item other than 1 can't interrupt a paragraph, so this is still the paragraph
      ordered: `A paragraph\n2. ${FENCE}\n   ${bad}\n`,
      // a link definition's address may be on its next line
      definition: `[a]:\n${FENCE}\n${bad}\n`,
      // inside raw html a fence is raw too, and the html ends before the fence would
      html: `<!--\n\n${FENCE}\n-->\n${bad}\n`,
      htmlBlock: `<div>\n${FENCE}\n\n${bad}\n`,
      // a quote's code ends with the quote
      quote: `> ${FENCE}\n${bad}\n`,
      fewerQuotes: `> > ${FENCE}\n>   ${bad}\n`,
      // closed at the item's text column, the item's paragraph goes on
      itemClosed: `-   ${FENCE}\n    code\n    ${FENCE}\n    ${bad}\n`,
      // a backtick in a backtick fence's info: inline code, not a fence
      tick: `${FENCE} a\`b\n${bad}\n`,
      // indented four, it's code; the next line is a paragraph
      indented: `    ${FENCE}\n${bad}\n`,
      // a lazy line can't continue fenced code
      lazy: `- ${FENCE}\n${bad}\n`,
    };
    for (const [name, md] of Object.entries(cases)) {
      expect([name, beyondLimits(md)]).toEqual([name, true]);
      const [d, ms] = timed(md);
      expect([name, ms < QUICK_MS]).toEqual([name, true]);
      whole(d);
    }
  });

  test('each limit, just inside and just past', () => {
    const deep = (n: number) => `${'> '.repeat(n / 2)}a\n`;
    expect([beyondLimits(deep(LIMITS.prefix)), beyondLimits(deep(LIMITS.prefix + 2))]).toEqual([false, true]);
    const long = (n: number) => `${'word '.repeat(n / 5)}\n`;
    expect([beyondLimits(long(LIMITS.block - 5)), beyondLimits(long(LIMITS.block + 5))]).toEqual([false, true]);
    const marked = (n: number) => `${'_a_ '.repeat(n / 2)}\n`;
    expect([beyondLimits(marked(LIMITS.marks)), beyondLimits(marked(LIMITS.marks + 2))]).toEqual([false, true]);
    // fewer marks in a longer block: their cost is marks times length
    expect(beyondLimits(`${'_a_ '.repeat(400)}${'word '.repeat(2_000)}\n`)).toBe(true);
    const blocks = (n: number) => 'a\n\n'.repeat(n);
    expect([beyondLimits(blocks(LIMITS.blocks)), beyondLimits(blocks(LIMITS.blocks + 1))]).toEqual([false, true]);
    // many marked blocks, each inside, past what the article may hold in all
    expect(beyondLimits(`${'_a_ '.repeat(450)}\n\n`.repeat(30))).toBe(true);
    expect(beyondLimits(`${'_a_ '.repeat(100)}\n\n`.repeat(30))).toBe(false);
  });

  test('marks that cannot open or close do not count: _ inside a word, < before no tag, escapes', () => {
    expect(beyondLimits(`${'snake_case_name '.repeat(2_000)}\n`)).toBe(false);
    expect(beyondLimits(`${'a < b <= c << d '.repeat(400)}\n`)).toBe(false);
    expect(beyondLimits(`${'\\*\\_\\[\\] '.repeat(1_000)}\n`)).toBe(false);
    expect(beyondLimits(`${'<b>x</b> '.repeat(600)}\n`)).toBe(true);
  });
});
