// Hostile and outsized Markdown through the Reader's derive (mobile spec 6.7): every save's text goes through
// deriveArticle on the JS thread (a phone's parse, a browser's save, sync, the Reader's own re-derive), so it must
// neither throw nor take minutes. Past what the CommonMark parse and the spoken projection take in linear time, the
// text is read plain: kept whole, as paragraphs, every word in a block and a sentence.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VOICE_CHARS, deriveArticle, type Derived } from '../src/reader/blocks';
import { LIMITS, beyondLimits } from '../src/reader/limits';
import { PLAIN_BLOCKS, PLAIN_CHARS } from '../src/reader/plain';

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
    // a word longer than a block is cut into pieces of one, every character kept
    const [w] = timed(`Start ${'x'.repeat(1_000_000)} end.\n`);
    expect(spans(w).replace(/ /g, '')).toBe(`Start${'x'.repeat(1_000_000)}end.`);
    expect(w.words).toBeGreaterThanOrEqual(3);
    whole(w);
  });

  test('a code block of 20,000 lines stays code, cut between lines', () => {
    const [d, ms] = timed(`Before.\n\n\`\`\`\n${'line of code\n'.repeat(20_000)}\`\`\`\n\nAfter.\n`);
    expect(ms).toBeLessThan(QUICK_MS);
    const kinds = d.blocks.map((b) => b.kind);
    expect([kinds[0], kinds[kinds.length - 1], new Set(kinds.slice(1, -1))]).toEqual(['p', 'p', new Set(['code'])]);
    expect(d.blocks.slice(1, -1).map((b) => (b as { text: string }).text).join('\n')).toBe('line of code\n'.repeat(20_000).slice(0, -1));
    expect(d.words).toBe(2 + 60_000);
    whole(d);
  });

  test('a run-on paragraph reaches the voice in pieces it can speak whole', () => {
    // 3,000 words and no full stop: one sentence of 20,000 characters, of which the engine would speak 4,000
    const md = `${Array.from({ length: 3_000 }, (_, i) => ['saving', 'reading', 'later', 'quiet'][i % 4]).join(' ')}\n`;
    const d = deriveArticle(md);
    expect(Math.max(...d.sentences.map((s) => s.text.length))).toBeLessThanOrEqual(VOICE_CHARS);
    expect(d.sentences.length).toBeGreaterThan(5);
    expect(d.words).toBe(3_000);
    whole(d);
    // each piece is its stretch of the spoken text
    for (const s of d.sentences) expect(d.spoken.startsWith(s.text, d.spoken.split(' ').slice(0, s.firstWord).join(' ').length + (s.firstWord ? 1 : 0))).toBe(true);
  });

  test('read plain, no block is a huge text and there are never a hundred thousand of them', () => {
    // one paragraph of a megabyte would be one Text of a megabyte, and the voice's highlight re-renders its block
    const para = Array.from({ length: 150_000 }, (_, i) => ['saving', 'reading', 'later', 'quiet'][i % 4]).join(' ');
    const big = deriveArticle(`${para}\n`);
    expect(Math.max(...big.blocks.map((b) => (b as { spans: { text: string }[] }).spans[0].text.length))).toBeLessThanOrEqual(PLAIN_CHARS);
    expect(big.blocks.map((b) => (b as { spans: { text: string }[] }).spans[0].text).join(' ')).toBe(para);
    expect(big.words).toBe(150_000);
    whole(big);
    // 100,000 short paragraphs (past the parse's block limit) run together into at most PLAIN_BLOCKS
    const many = deriveArticle('line one\n\nline two\n\n'.repeat(50_000));
    expect(many.blocks.length).toBeLessThanOrEqual(PLAIN_BLOCKS);
    expect(many.words).toBe(200_000);
    expect((many.blocks[0] as { spans: { text: string }[] }).spans[0].text.startsWith('line one\n\nline two\n\nline one')).toBe(true);
    whole(many);
    // a code block of a megabyte is cut between lines, every line kept
    const lines = Array.from({ length: 80_000 }, (_, i) => `let line${i} = ${i};`);
    const code = deriveArticle(`\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
    expect(code.blocks.every((b) => b.kind === 'code' && b.text.length <= PLAIN_CHARS * 2)).toBe(true);
    expect(code.blocks.map((b) => (b as { text: string }).text).join('\n')).toBe(lines.join('\n'));
    whole(code);
  });

  test('ordinary Markdown of several megabytes, as a synced text may be, is read plain in a second', () => {
    const part = (i: number) => `## Part ${i}\n\nThe quiet _river_ ran past the **stone** wall, and [a link](https://e.com/${i}) led on. ${'saving reading later quiet stone. Heather '.repeat(20)}`;
    const md = `${Array.from({ length: 6_000 }, (_, i) => part(i)).join('\n\n')}\n`;
    expect(md.length).toBeGreaterThan(5_000_000);
    const [d, ms] = timed(md);
    expect(ms).toBeLessThan(QUICK_MS);
    // headings stay headings; the styling and the link's address go
    expect(d.blocks.filter((b) => b.kind === 'h')).toHaveLength(6_000);
    expect(spans(d)).toContain('The quiet _river_ ran past the **stone** wall, and [a link](https://e.com/0) led on.');
    whole(d);
  });

  test('text dense with escapes, as Turndown writes a page of literal stars, is read plain', () => {
    // each escape is a token of its own to the parse: 16 paragraphs of 20,000 escaped stars took several seconds
    const md = `${'\\* \\_ '.repeat(5_000)}\n\n`.repeat(16);
    expect(beyondLimits(md)).toBe(true);
    const [d, ms] = timed(md);
    expect(ms).toBeLessThan(QUICK_MS);
    expect(spans(d).startsWith('* _ * _')).toBe(true);
    whole(d);
  });

  test('a page of 20,000 images keeps the blocks of the 500 it shows, in order', () => {
    const md = Array.from({ length: 20_000 }, (_, i) => `![p${i}](https://img${i % 9}.example.com/${i}.png)`).join('\n\n');
    const d = deriveArticle(`Words before.\n\n${md}\n\nWords after.\n`);
    const imgs = d.blocks.filter((b) => b.kind === 'img') as { src: string }[];
    expect(imgs).toHaveLength(LIMITS.images);
    expect(imgs[499].src).toBe('https://img4.example.com/499.png');
    expect(d.words).toBe(4);
    // an image named again later is still shown where it is
    const again = deriveArticle(`![a](https://e.com/1.png)\n\n${'![b](https://e.com/2.png)\n\n'.repeat(3)}![a](https://e.com/1.png)\n`);
    expect(again.blocks.map((b) => (b as { src: string }).src)).toEqual(['https://e.com/1.png', ...Array(3).fill('https://e.com/2.png'), 'https://e.com/1.png']);
  });

  test('read plain, no sentence is longer than the voice takes, even one word', () => {
    const d = deriveArticle(`Start ${'<!--'.repeat(30_000)} end.\n`);
    expect(Math.max(...d.sentences.map((s) => s.text.length))).toBeLessThanOrEqual(VOICE_CHARS);
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
