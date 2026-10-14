import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countWords, normaliseMarkdown, pdfMarkdown, project, textHash, type PdfPage, type PdfRun } from '../src';
import { nodeCrypto } from '../src/node';

const FIXTURES = join(__dirname, '..', '..', '..', 'shared', 'fixtures', 'pdfs');

// A run of body text: [text, x, y, size, width, angle]; width roughly as a 10 pt serif sets it.
const run = (text: string, x: number, y: number, size = 10, angle = 0): PdfRun => [text, x, y, size, text.length * size * 0.45, angle];
const page = (...runs: PdfRun[]): PdfPage => ({ w: 595, h: 842, runs });
const md = (pages: PdfPage[], title: string | null = null) => pdfMarkdown({ title, author: null, pages });
const SENTENCES = [
  'Saved articles are read on the train and kept for later.',
  'Every phone shows the same words in the same order.',
  'The voice follows the text and lights each word in turn.',
  'Nothing is lost when the service that saved it is gone.',
];
const prose = (n: number) => SENTENCES[(n - 1) % SENTENCES.length];
/** A paragraph's lines at 12 pt spacing from y, as runs. */
const lines = (texts: string[], x: number, y: number) => texts.map((t, i) => run(t, x, y + i * 12));

describe('PDF fixtures (C§4.2, C§9)', () => {
  const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as { pdfs: { id: string; ok: boolean; reason?: string; title?: string; byline?: string | null; markdown?: string; text_hash?: string; spoken?: string; words?: number }[] };

  test.each(expected.pdfs.map((p) => [p.id, p] as const))('%s', (id, want) => {
    const runs = JSON.parse(readFileSync(join(FIXTURES, `${id}.runs.json`), 'utf8'));
    expect(runs.ok).toBe(true);
    const a = pdfMarkdown(runs);
    const m = normaliseMarkdown(a.markdown);
    if (!want.ok) {
      expect(want.reason).toBe('pdf_no_text');
      expect(countWords(m)).toBeLessThan(20);
      return;
    }
    expect({ title: a.title, byline: a.byline, markdown: m }).toEqual({ title: want.title, byline: want.byline, markdown: want.markdown });
    expect(textHash(m, nodeCrypto)).toBe(want.text_hash);
    expect(project(m).text).toBe(want.spoken);
    expect(countWords(m)).toBe(want.words);
  });
});

describe('PDF layout (C§4.2)', () => {
  test('lines become paragraphs, split at a gap', () => {
    const out = md([page(run('The first paragraph opens here and', 72, 100), run('goes on to its end.', 72, 112), run('A second one after a gap.', 72, 140))]);
    expect(out.markdown).toBe('The first paragraph opens here and goes on to its end.\n\nA second one after a gap.\n');
  });

  test('a hyphen at a line end joins the word; a hyphen before a capital stays', () => {
    const out = md([page(run('Large organi-', 72, 100), run('sations hold files, as do Anglo-', 72, 112), run('Saxon archives.', 72, 124))]);
    expect(out.markdown).toBe('Large organisations hold files, as do Anglo- Saxon archives.\n');
  });

  test('ligatures and soft hyphens are undone', () => {
    expect(md([page(run('The ﬁrst ﬂoor ef­ﬁciency.', 72, 100))]).markdown).toBe('The first floor efficiency.\n');
  });

  test('a larger line is a heading, ranked by size, and the largest on page one is the title', () => {
    const out = md([page(run('A Big Title', 72, 60, 22), run('A section', 72, 100, 15), run(prose(1), 72, 130), run('Another section', 72, 170, 15), run(prose(2), 72, 200))]);
    // the Reader shows the title above the text, so the heading it came from leaves the body
    expect(out.markdown).toBe(`## A section\n\n${prose(1)}\n\n## Another section\n\n${prose(2)}\n`);
    expect(out.title).toBe('A Big Title');
  });

  test("the title heading goes when the file's title says the same, and stays when it doesn't", () => {
    const body = [page(run('Annual Report', 72, 60, 20), run(prose(1), 72, 100))];
    expect(md(body, 'ANNUAL REPORT').markdown).toBe(`${prose(1)}\n`);
    expect(md(body, 'Annual report: the year in numbers').markdown).toBe(`${prose(1)}\n`);
    expect(md(body, 'Minutes of the board').markdown).toBe(`# Annual Report\n\n${prose(1)}\n`);
  });

  test("the file's title wins unless it is an address or a placeholder", () => {
    const body = [page(run('Heading', 72, 60, 20), run(prose(1), 72, 100))];
    expect(md(body, 'Annual Report 2025').title).toBe('Annual Report 2025');
    expect(md(body, 'Microsoft Word - notes.docx').title).toBe('notes');
    expect(md(body, 'data:text/html;base64,PGh0bWw+').title).toBe('Heading');
    expect(md(body, 'https://example.com/a.pdf').title).toBe('Heading');
    expect(md(body, 'Untitled').title).toBe('Heading');
  });

  test('a numbered one-line section is a heading, by its depth', () => {
    const out = md([page(run('1. Introduction', 72, 100), ...lines([prose(1), prose(2)], 72, 124), run('2.1 Method', 72, 160), ...lines([prose(3), prose(4)], 72, 184))]);
    expect(out.markdown).toBe(`## 1\\. Introduction\n\n${prose(1)} ${prose(2)}\n\n### 2.1 Method\n\n${prose(3)} ${prose(4)}\n`);
  });

  test('running headers, footers and page numbers go', () => {
    const pages = [1, 2, 3].map((n) => page(run('Annual report — draft', 200, 30, 8), ...lines([prose(n), prose(n + 1)], 72, 100), run(`Page ${n} of 3`, 270, 800, 8)));
    expect(md(pages).markdown).toBe([1, 2, 3].map((n) => `${prose(n)} ${prose(n + 1)}`).join('\n\n') + '\n');
  });

  test('a paragraph runs on across a page or column break unless its line ended a sentence', () => {
    const carry = 'and so a long sentence that carries over the turn of the page';
    const out = md([page(...lines([prose(1), 'This one carries on, as sentences do', carry], 72, 760)), page(...lines(['without any trouble at all, to its end here.', prose(2)], 72, 80))]);
    // its short last line, ending a sentence, ends it
    expect(out.markdown).toBe(`${prose(1)} This one carries on, as sentences do ${carry} without any trouble at all, to its end here.\n\n${prose(2)}\n`);
    const ended = md([page(...lines([prose(1), prose(2)], 72, 760)), page(...lines([prose(3), prose(4)], 72, 80))]);
    expect(ended.markdown).toBe(`${prose(1)} ${prose(2)}\n\n${prose(3)} ${prose(4)}\n`);
  });

  test('an indented first line opens a paragraph', () => {
    const out = md([page(run('One paragraph ends here.', 72, 100), run('Another opens, set in a little.', 90, 112), run('It carries on at the margin.', 72, 124))]);
    expect(out.markdown).toBe('One paragraph ends here.\n\nAnother opens, set in a little. It carries on at the margin.\n');
  });

  test('turned text, raised marks and footnotes go', () => {
    const out = md([page(
      run('arXiv:1706.03762v7 [cs.CL] 2 Aug 2023', 30, 600, 20, -90),
      run('Prior work', 72, 100), run('1', 120, 96, 6), run(' reads pages aloud with a voice.', 125, 100),
      run(prose(1), 72, 130),
      run('1 A note at the foot of the page.', 72, 780, 8),
    )]);
    expect(out.markdown).toBe(`Prior work reads pages aloud with a voice.\n\n${prose(1)}\n`);
  });

  test('tables, chart labels, scraps and equations go', () => {
    const out = md([page(
      run(prose(1), 72, 100),
      run('Format 2024 2025', 72, 140), run('A 12 14', 72, 152), run('B 3 9', 72, 164), run('C 40 41', 72, 176),
      run('Time', 300, 220),
      run('E = m × c² + ∑ x (1)', 200, 260),
      run(prose(2), 72, 300),
    )]);
    expect(out.markdown).toBe(`${prose(1)}\n\n${prose(2)}\n`);
  });

  test('bullets become list items and reference entries their own paragraphs', () => {
    const out = md([page(run(prose(1), 72, 100), run('• Save anything.', 72, 130), run('• Read it clean.', 72, 142), run('[1] A. Author. A paper. 2019.', 72, 170), run('[2] B. Author. Another. 2021.', 72, 182))]);
    expect(out.markdown).toBe(`${prose(1)}\n\n- Save anything.\n\n- Read it clean.\n\n\\[1\\] A. Author. A paper. 2019.\n\n\\[2\\] B. Author. Another. 2021.\n`);
  });

  test('text is escaped so CommonMark reads it back as written', () => {
    const out = md([page(...lines(['1. not a list, *not* emphasis, <b> & [x] and', prose(1)], 72, 100), ...lines(['- not a bullet either, and # not a heading,', prose(2)], 72, 140))]);
    const m = normaliseMarkdown(out.markdown);
    expect(project(m).text).toBe(`1. not a list, *not* emphasis, <b> & [x] and ${prose(1)}\n\n- not a bullet either, and # not a heading, ${prose(2)}`);
  });

  test('repeated heading text (chart titles) goes', () => {
    const out = md([page(run('Layer 5', 72, 60, 16), run(prose(1), 72, 100), run('Layer 5', 72, 300, 16), run(prose(2), 72, 340))]);
    expect(out.markdown).toBe(`${prose(1)}\n\n${prose(2)}\n`);
  });

  test('no runs is no text', () => {
    expect(md([page(), page()]).markdown).toBe('\n');
  });

  test('a word broken over three lines is joined whole', () => {
    expect(md([page(...lines(['An organi-', 'sa-', 'tion keeps its files.'], 72, 100))]).markdown).toBe('An organisation keeps its files.\n');
  });
});

describe('PDF layout at any length (a hostile or merely long file)', () => {
  const POOL = ['reading', 'later', 'quietly', 'library', 'saved', 'article', 'phone', 'voice', 'offline', 'clean', 'text', 'every', 'page', 'keeps', 'place'];
  // words that differ line to line, so no line repeats as a running header would
  const say = (i: number) => [0, 1, 2, 3, 4, 5].map((k) => POOL[(i * 7 + k * 11 + Math.floor(i / 13)) % POOL.length]).join(' ');
  const timed = <T,>(f: () => T): { out: T; ms: number } => {
    const started = Date.now();
    const out = f();
    return { out, ms: Date.now() - started };
  };

  // Each was quadratic: 34 s in Node for this paragraph (every line took the block's least x and greatest right
  // again, through a spread that a longer block would take past the stack), 31 s for the hyphens, 8 s for half
  // these runs. Linear, each takes about 2 s under Jest.
  test('a paragraph that never ends a sentence, 20,000 lines over 334 pages', () => {
    const pages: PdfPage[] = [];
    for (let i = 0; i < 20_000; i += 60) pages.push(page(...Array.from({ length: Math.min(60, 20_000 - i) }, (_, k) => run(`the ${say(i + k)} goes on`, 72, 60 + k * 12))));
    const { out, ms } = timed(() => md(pages));
    expect(ms).toBeLessThan(30_000);
    expect(out.markdown).toBe(Array.from({ length: 20_000 }, (_, i) => `the ${say(i)} goes on`).join(' ') + '\n');
  });

  test('20,000 lines each ending in a hyphen', () => {
    const pages: PdfPage[] = [];
    for (let i = 0; i < 20_000; i += 60) pages.push(page(...Array.from({ length: Math.min(60, 20_000 - i) }, (_, k) => run(`${say(i + k).replace(/ /g, '')}-`, 72, 60 + k * 12))));
    expect(timed(() => md(pages)).ms).toBeLessThan(30_000);
  });

  test('one line of 200,000 runs set apart', () => {
    const runs = Array.from({ length: 200_000 }, (_, i) => run('w', 72 + i * 8, 100));
    const { out, ms } = timed(() => md([{ w: 595, h: 842, runs }]));
    expect(ms).toBeLessThan(30_000);
    expect(out.markdown).toBe('\n'); // one word of a letter, two hundred thousand times: numbers more than prose
  });
});
