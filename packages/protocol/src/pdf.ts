// A PDF's text as Markdown (contract 4.2, PDFs; flow decision 103): the text runs that shared/vendor/pdf-runner.mjs
// reads with pdf.js, laid out into headings, paragraphs and list items. Pure, so it runs on Hermes and in Jest; the
// PDF fixtures (shared/fixtures/pdfs) hold runs and the Markdown expected from them. Where this and the fixtures
// disagree, the fixtures win.
//
// What the voice can't read is left out: text turned off the line (margin stamps, axis labels), raised marks
// (footnote numbers, author symbols), running headers and footers, page numbers, and blocks that are mostly figures,
// numbers or equations. Columns are read in the order the file keeps its text, which is usually column by column.

/** One run of text: [text, x, y (baseline, from the top), size, width, angle in degrees]. */
export type PdfRun = [string, number, number, number, number, number];
export type PdfPage = { w: number; h: number; runs: PdfRun[] };
export type PdfRuns = { title: string | null; author: string | null; pages: PdfPage[] };
export type PdfArticle = { title: string | null; byline: string | null; markdown: string };

type Line = { page: number; x: number; y: number; right: number; size: number; text: string };
type Block = { kind: 'p' | 'h' | 'li'; level?: number; size: number; page: number; y: number; lines: Line[] };

/** A line that ends a sentence: a stop, optionally closed by a quote or bracket. */
const TERMINAL = /[.!?:;]["”’)\]]?$/;
/** A displayed equation's number at the end of its line. */
const EQUATION_NUMBER = /\(\d{1,3}\)$/;
/** A line that ends a sentence or a displayed equation. */
const ends = (t: string) => TERMINAL.test(t) || EQUATION_NUMBER.test(t);
/** A line that opens an entry in a numbered reference list. */
const ENTRY = /^\[\d{1,3}\]\s/;
const MARK = /^[\d∗*†‡§¶,\s]+$/;
const BULLET = /^[•◦▪▫●○■□‣⁃–]\s*/;
/** A section number: 1, 2.1, 3.2.1. or IV. (a letter alone, as in "A. Reader", is more often an initial). */
const SECTION = /^(?:\d+(?:\.\d+)*\.?|[IVX]+\.)\s+\S/;
const PAGE_NUMBER = /^(?:page\s*)?[-–—]?\s*\d{1,4}\s*[-–—]?(?:\s*(?:of|\/)\s*\d{1,4})?$/i;
const LIGATURES: Record<string, string> = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };

function clean(s: string): string {
  return s.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] ?? c).replace(/­/g, '').replace(/\s+/g, ' ');
}

// ---- lines

/** A run set above the line in a smaller size and made only of digits or note symbols: a footnote or author mark. */
function isMark(run: PdfRun, line: Line): boolean {
  return run[3] < line.size * 0.85 && line.y - run[2] > line.size * 0.2 && MARK.test(run[0]);
}

function startsLine(run: PdfRun, line: Line | null): boolean {
  if (!line) return true;
  const size = Math.max(run[3], line.size);
  if (Math.abs(run[2] - line.y) > size * 0.5) return true;
  return run[1] < line.right - size * 2;
}

function append(line: Line, run: PdfRun): void {
  const gap = run[1] - line.right;
  const text = clean(run[0]);
  const spaced = gap > line.size * 0.2 && !line.text.endsWith(' ') && !text.startsWith(' ');
  line.text += (spaced ? ' ' : '') + text;
  line.right = Math.max(line.right, run[1] + run[4]);
}

/** A page's runs as lines, in the file's order; runs turned off the horizontal are left out. */
function pageLines(page: PdfPage, n: number): Line[] {
  const lines: Line[] = [];
  let line: Line | null = null;
  for (const run of page.runs) {
    if (Math.abs(run[5]) > 2 || run[0].trim() === '') continue;
    if (line && isMark(run, line)) continue;
    if (startsLine(run, line)) {
      line = { page: n, x: run[1], y: run[2], right: run[1] + run[4], size: run[3], text: clean(run[0]) };
      lines.push(line);
    } else {
      append(line!, run);
      if (run[3] > line!.size) line!.size = run[3];
    }
  }
  return lines.map((l) => ({ ...l, text: l.text.trim() })).filter((l) => l.text !== '');
}

// ---- running headers, footers and page numbers

const lineKey = (l: Line) => `${Math.round(l.y / 2)}|${l.text.replace(/\d+/g, '#')}`;

function runningLines(pages: Line[][]): Set<string> {
  const seen = new Map<string, number>();
  for (const p of pages) for (const k of new Set(p.map(lineKey))) seen.set(k, (seen.get(k) ?? 0) + 1);
  const min = Math.max(3, pages.length / 2);
  return new Set([...seen].filter(([, count]) => pages.length >= 3 && count >= min).map(([k]) => k));
}

function bodyLines(pages: Line[][]): Line[] {
  const running = runningLines(pages);
  return pages.flat().filter((l) => !running.has(lineKey(l)) && !PAGE_NUMBER.test(l.text));
}

// ---- sizes and spacing

/** The size most characters are set in. */
function bodySize(lines: Line[]): number {
  const chars = new Map<number, number>();
  for (const l of lines) chars.set(Math.round(l.size * 2) / 2, (chars.get(Math.round(l.size * 2) / 2) ?? 0) + l.text.length);
  let best = 0;
  let most = -1;
  for (const [size, n] of chars) if (n > most) [best, most] = [size, n];
  return best || 10;
}

/** The usual distance from one baseline to the next within body text. */
function leading(lines: Line[], body: number): number {
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const [a, b] = [lines[i - 1], lines[i]];
    const gap = b.y - a.y;
    if (a.page === b.page && Math.abs(a.size - body) < 0.5 && Math.abs(b.size - body) < 0.5 && gap > 0 && gap < body * 3) gaps.push(gap);
  }
  if (!gaps.length) return body * 1.2;
  // the lower quartile: most gaps are a line's, the wider ones between paragraphs are fewer
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor(gaps.length / 4)];
}

// ---- blocks

type Ctx = { body: number; lead: number; margins: number[] };

const MATH = /[=≤≥{}∑∏∫√±×⋅·−∈∀∃→^]/g;
const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;
const mathy = (s: string) => (s.match(MATH) ?? []).length;
/** Mostly letters and no mathematics: a line that can be a heading. */
const prose = (s: string) => letters(s) >= s.replace(/\s/g, '').length * 0.7 && mathy(s) === 0;

const isHeadingSize = (l: Line, c: Ctx) => l.size >= c.body * 1.15 && prose(l.text);

/** The x where body lines start: each place at least a tenth of them share (one per column). */
function margins(lines: Line[], body: number): number[] {
  const at = new Map<number, number>();
  const bodyLines = lines.filter((l) => Math.abs(l.size - body) < 0.5);
  for (const l of bodyLines) at.set(Math.round(l.x), (at.get(Math.round(l.x)) ?? 0) + 1);
  return [...at].filter(([, n]) => n >= Math.max(3, bodyLines.length * 0.1)).map(([x]) => x);
}

/** A bullet, a reference entry or a caption starts a block of its own. */
const opensBlock = (t: string) => BULLET.test(t) || ENTRY.test(t) || /^(?:Table|Figure|Fig\.)\s*\d+[:.]/.test(t);

function breaksBefore(prev: Line, cur: Line, block: Block, c: Ctx): boolean {
  if (Math.abs(cur.size - prev.size) > c.body * 0.1) return true;
  if (opensBlock(cur.text)) return true;
  // a new page or column: the paragraph goes on unless the last line finished a sentence
  if (cur.page !== prev.page || cur.y < prev.y) return ends(prev.text);
  if (cur.y - prev.y > c.lead * 1.5) return true;
  const left = Math.min(...block.lines.map((l) => l.x));
  const right = Math.max(...block.lines.map((l) => l.right));
  if (TERMINAL.test(prev.text) && cur.x > left + cur.size * 1.2) return true; // an indented first line
  if (ends(prev.text) && prev.x > cur.x + cur.size * 2) return true; // after a centred line
  return TERMINAL.test(prev.text) && block.lines.length > 1 && prev.right < right - cur.size * 4; // a short last line
}

function blocksOf(lines: Line[], c: Ctx): Block[] {
  const blocks: Block[] = [];
  let block: Block | null = null;
  lines.forEach((l, i) => {
    if (!block || breaksBefore(lines[i - 1], l, block, c)) {
      block = { kind: isHeadingSize(l, c) ? 'h' : BULLET.test(l.text) ? 'li' : 'p', size: l.size, page: l.page, y: l.y, lines: [] };
      blocks.push(block);
    }
    block.lines.push(l);
  });
  return blocks;
}

// ---- joining lines and what's left out

function joinLines(lines: Line[]): string {
  let out = '';
  for (const l of lines) {
    if (/\p{L}-$/u.test(out) && /^\p{Ll}/u.test(l.text)) out = out.slice(0, -1) + l.text;
    else out = out ? `${out} ${l.text}` : l.text;
  }
  return out.replace(/\s+/g, ' ').trim();
}

const onMargin = (l: Line, c: Ctx) => c.margins.some((m) => l.x >= m - 4 && l.x <= m + l.size * 3);

/** Rows of short cells: most of four or more lines are under 25 characters. */
const tableRows = (b: Block) => b.lines.length >= 4 && b.lines.filter((l) => l.text.length < 25).length / b.lines.length > 0.6;

/** Mostly numbers: fewer letters than half its characters, or half its words figures or one- and two-letter cells. */
function numeric(text: string): boolean {
  if (letters(text) < text.replace(/\s/g, '').length * 0.5) return true;
  const tokens = text.split(' ');
  return tokens.length >= 8 && tokens.filter((t) => /^[\d.,:%()×+−–-]+$|^\S{1,2}$/u.test(t)).length >= tokens.length * 0.5;
}

const mathematical = (text: string) => text.length < 200 && mathy(text) >= Math.max(2, text.length * 0.03);

/** Three words or fewer that don't make a sentence: a label, a symbol, the limits of a sum. */
const scrap = (text: string) => text.split(' ').length <= 3 && (letters(text) < 4 || mathy(text) > 0 || !TERMINAL.test(text));

/** A short block with no line on a margin the text keeps: a label inside a figure. */
const setApart = (b: Block, text: string, c: Ctx) => text.length < 120 && c.margins.length > 0 && !b.lines.some((l) => onMargin(l, c));

/** What a voice can't read: a table, numbers, mathematics, a scrap, or a label set apart from the text. */
function unreadable(b: Block, text: string, c: Ctx): boolean {
  if (b.kind === 'h' || numberedHeading(b, text)) return false;
  return tableRows(b) || numeric(text) || mathematical(text) || scrap(text) || setApart(b, text, c);
}

/** Notes in a smaller size at a page's foot, opening with their number or symbol. */
function footnote(b: Block, c: Ctx, pages: PdfPage[]): boolean {
  const h = pages[b.page]?.h ?? 0;
  return b.size < c.body * 0.95 && b.y > h * 0.6 && /^[\d∗*†‡§¶]/.test(b.lines[0].text);
}

/** A one-line body-size block that opens with a section number and doesn't end a sentence: a numbered heading. */
function numberedHeading(b: Block, text: string): boolean {
  return b.kind === 'p' && b.lines.length === 1 && text.length <= 80 && SECTION.test(text) && !/[.:;,]$/.test(text);
}

// ---- Markdown

/** Text as CommonMark reads it back: inline syntax escaped, and nothing at the start that would open a block. */
function escape(text: string): string {
  return text
    .replace(/[\\`*_[\]<>&]/g, '\\$&')
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
    .replace(/^([-+#>])/, '\\$1');
}

function headingLevels(blocks: Block[]): Map<number, number> {
  const sizes = [...new Set(blocks.filter((b) => b.kind === 'h').map((b) => Math.round(b.size)))].sort((a, b) => b - a);
  return new Map(sizes.map((s, i) => [s, Math.min(i + 1, 3)]));
}

const sectionDepth = (text: string) => text.match(/^\d+(?:\.\d+)*/)?.[0].split('.').length ?? 1;

function blockMarkdown(b: Block, text: string, levels: Map<number, number>): string {
  if (b.kind === 'h' && b.lines.length <= 2 && text.length <= 200) return `${'#'.repeat(levels.get(Math.round(b.size)) ?? 3)} ${escape(text)}`;
  if (numberedHeading(b, text)) return `${sectionDepth(text) > 1 ? '###' : '##'} ${escape(text)}`;
  if (b.kind === 'li') return `- ${escape(text.replace(BULLET, ''))}`;
  return escape(text);
}

/** Heading text set more than once: the titles of a run of charts, not the document's sections. */
function repeatedHeadings(blocks: Block[]): Set<string> {
  const seen = new Map<string, number>();
  for (const b of blocks) if (b.kind === 'h') seen.set(joinLines(b.lines), (seen.get(joinLines(b.lines)) ?? 0) + 1);
  return new Set([...seen].filter(([, n]) => n > 1).map(([t]) => t));
}

/** The document's own title, unless it is a file name, an address (Chrome writes the page's) or a tool's placeholder. */
function usableTitle(t: string | null): string | null {
  if (!t) return null;
  const s = t.replace(/^Microsoft (?:Word|PowerPoint) - /, '').replace(/\.(?:docx?|pptx?|pdf|tex|indd)$/i, '').trim();
  return s === '' || /^(?:untitled|document\d*|slide \d+)$/i.test(s) || /^[a-z][a-z0-9+.-]*:\S/i.test(s) ? null : s;
}

/** The PDF's text as Markdown (not yet normalised), with a title from the file or the largest heading on its first page. */
export function pdfMarkdown(doc: PdfRuns): PdfArticle {
  const lines = bodyLines(doc.pages.map(pageLines));
  const body = bodySize(lines);
  const c: Ctx = { body, lead: leading(lines, body), margins: margins(lines, body) };
  const blocks = blocksOf(lines, c);
  const levels = headingLevels(blocks);
  const repeated = repeatedHeadings(blocks);
  const out: string[] = [];
  let title: { text: string; size: number } | null = null;
  for (const b of blocks) {
    const text = joinLines(b.lines);
    if (text === '' || unreadable(b, text, c) || footnote(b, c, doc.pages) || (b.kind === 'h' && repeated.has(text))) continue;
    const md = blockMarkdown(b, text, levels);
    if (b.page === 0 && md.startsWith('#') && b.size > (title?.size ?? 0)) title = { text, size: b.size };
    out.push(md);
  }
  return { title: usableTitle(doc.title) ?? title?.text ?? null, byline: doc.author, markdown: out.join('\n\n') + '\n' };
}
