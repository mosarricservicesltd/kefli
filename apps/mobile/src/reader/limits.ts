// What the CommonMark parse (micromark, through mdast-util-from-markdown) and the spoken projection take in linear
// time, and a scan in one pass that says when Markdown goes past it. Measured on 14 October 2026 with hostile
// Markdown on desktop V8; a phone is slower still:
// - nesting: each line pays for every container it is in, more than linearly when deep. A list nested 400 deep took
//   4 s to parse, a 64-deep list 2,000 lines long 4 s; quotes 5,000 deep overflowed the stack.
// - one block's size: the projection's work on a block grows faster than its length. A code block of 16,000 lines
//   took 8 s, then overflowed the stack; one paragraph of 50,000 words overflowed it at once.
// - inline marks in one block: emphasis, links, code spans and raw html each look back or ahead for a partner, so
//   ones that never match cost the square of their number. '*a_ ' 4,000 times took 3.7 s and 10,000 times over a
//   minute; 10,000 '<!--' in a paragraph, literal text that Turndown leaves as it is, took 17 s.
// - blocks: about 6 KB of parse state each. 100,000 short paragraphs, under a megabyte, took 800 MB.
// - length: ordinary Markdown parses at about 4 s a megabyte and 300 MB, on desktop V8.
// Real pages sit far inside. The page fixtures, measured as the scan measures: the deepest prefix 8 characters, the
// longest block 4,103, the most marks in a block 69 (marks times length 283,107), the most blocks 278, escapes and
// references under 0.7% of the text, the longest article 163 KB.
// Fenced code is code to the parse, so its marks don't count. The scan opens a fence only where CommonMark surely
// would (at a block's start, after no ordered marker, never inside raw html) and leaves it wherever CommonMark might,
// so a fence the parse doesn't see can't hide marks from it.

export const LIMITS = {
  /**
   * Characters in all: a megabyte of ordinary Markdown took 4 s to parse and project (and 300 MB) where reading it
   * plain took a third of a second, a phone is slower still, and a synced text may be 20 MB. About 150,000 words.
   */
  length: 1_048_576,
  /** Characters of a line's container prefix: its indentation, quote markers and list markers. */
  prefix: 64,
  /** Characters in one block: a paragraph, a list item's text, a heading or a code block. */
  block: 65_536,
  /** Unescaped inline marks in one block: * _ (not between letters or digits) [ ] backticks, and < before a tag or address. */
  marks: 1_000,
  /** One block's marks times its length: what its unmatched marks can cost. */
  blockCost: 4_000_000,
  /** Blocks in the article. */
  blocks: 20_000,
  /** Distinct images an article fetches and shows; a figure past them is left out, so its block is too. */
  images: 500,
};

/** The whole article's marks: each block's marks squared, and its marks times its length, summed. */
const squaresAllowed = (n: number) => Math.max(4_000_000, 4 * n);
const costAllowed = (n: number) => Math.max(40_000_000, 300 * n);
/**
 * Backslash escapes and character references: each is a token of its own, so text dense with them parses ten times
 * slower than prose (Turndown escapes every literal * _ [ ] and backtick: a page of them, a second for 60 KB).
 */
const tokensAllowed = (n: number) => Math.max(20_000, n / 10);

const SPACE = 32;
const TAB = 9;
const GT = 62;
const LT = 60;
const BACKSLASH = 92;
const HASH = 35;
const AMP = 38;
const UNDERSCORE = 95;
const BACKTICK = 96;
const TILDE = 126;

/** The inline marks: * _ [ ] < and the backtick (by its code: the code gate's parser loses its place at one). */
const MARK = new Uint8Array(128);
for (const c of [42, 95, 91, 93, 60, BACKTICK]) MARK[c] = 1;

const blankAt = (s: string, i: number, end: number) => i >= end || s.charCodeAt(i) === SPACE || s.charCodeAt(i) === TAB;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isAlnum = (c: number) => isDigit(c) || isLetter(c);
/** What can follow < to open raw html or an address: a letter, / ! or ?. */
const opensTag = (c: number) => isLetter(c) || c === 47 || c === 33 || c === 63;

/** After an ordered list marker (1. or 1)) at i, or i when there is none. */
function afterOrdered(s: string, i: number, end: number): number {
  let k = i;
  while (k < end && k - i < 9 && isDigit(s.charCodeAt(k))) k++;
  const c = s.charCodeAt(k);
  return k > i && (c === 46 || c === 41) && blankAt(s, k + 1, end) ? k + 1 : i;
}

/** After the bullet or quote marker at i (- * + >), or i when there is none. */
function afterBullet(s: string, i: number, end: number): number {
  const c = s.charCodeAt(i);
  if (c === GT) return i + 1;
  return (c === 45 || c === 42 || c === 43) && blankAt(s, i + 1, end) ? i + 1 : i;
}

export type Prefix = {
  /** Where the line's text starts. */
  end: number;
  /** Columns of indentation after the last marker, a tab counted as four. */
  indent: number;
  /** Quote markers in it. */
  quotes: number;
  /** Whether it holds a list marker, which starts a block; and whether an ordered one, which can't open a fence. */
  item: boolean;
  ordered: boolean;
};

/** A line's container prefix: indentation, quote markers and list markers, from i to its text. */
export function prefixOf(s: string, i: number, end: number): Prefix {
  const p: Prefix = { end: i, indent: 0, quotes: 0, item: false, ordered: false };
  while (p.end < end) {
    const c = s.charCodeAt(p.end);
    if (c === SPACE || c === TAB) {
      p.indent += c === TAB ? 4 : 1;
      p.end++;
      continue;
    }
    const b = afterBullet(s, p.end, end);
    const m = b === p.end ? afterOrdered(s, p.end, end) : b;
    if (m === p.end) break;
    if (c === GT) p.quotes++;
    else p.item = true;
    p.ordered ||= b === p.end;
    p.end = m;
    p.indent = 0;
  }
  return p;
}

/** The run of three or more backticks or tildes at i, or ''. */
function fenceRun(s: string, i: number, end: number): string {
  const c = s.charCodeAt(i);
  if (c !== BACKTICK && c !== TILDE) return '';
  let k = i;
  while (k < end && s.charCodeAt(k) === c) k++;
  return k - i >= 3 ? s.slice(i, k) : '';
}

/** The fence a line's text opens: indented three or less, and a backtick fence with no backtick after it; or ''. */
export function fenceAt(s: string, p: Prefix, end: number, indent = p.indent): string {
  if (indent > 3) return '';
  const run = fenceRun(s, p.end, end);
  if (run.charCodeAt(0) !== BACKTICK) return run;
  const tick = s.indexOf(run[0], p.end + run.length);
  return tick === -1 || tick >= end ? run : '';
}

/** What ends the raw html a line's text opens, for CommonMark's kinds 1 to 5; '' (a blank line) for the rest. */
function htmlEnd(s: string, at: number): string {
  const head = s.slice(at, at + 10).toLowerCase();
  if (head.startsWith('<!--')) return '-->';
  if (head.startsWith('<?')) return '?>';
  if (head.startsWith('<![cdata[')) return ']]>';
  if (head.startsWith('<!')) return '>';
  const raw = /^<(script|pre|style|textarea)(?:[\s>]|$)/.exec(head);
  return raw ? `</${raw[1]}>` : '';
}

/** Whether a mark at k is live: '_' between letters or digits can't open or close, nor '<' before anything but a tag. */
function live(s: string, k: number, c: number): boolean {
  if (c === UNDERSCORE) return !(isAlnum(s.charCodeAt(k - 1)) && isAlnum(s.charCodeAt(k + 1)));
  return c !== LT || opensTag(s.charCodeAt(k + 1));
}

/** Unescaped live inline marks in s from i to end. */
export function marksIn(s: string, i: number, end: number): number {
  let n = 0;
  for (let k = i; k < end; k++) {
    const c = s.charCodeAt(k);
    if (c === BACKSLASH) k++;
    else if (c < 128 && MARK[c] && live(s, k, c)) n++;
  }
  return n;
}

/** Backslash escapes and character references (each & counts) in s from i to end. */
export function tokensIn(s: string, i: number, end: number): number {
  let n = 0;
  for (let k = i; k < end; k++) {
    const c = s.charCodeAt(k);
    if (c === BACKSLASH || c === AMP) n++;
    if (c === BACKSLASH) k++;
  }
  return n;
}

type Scan = {
  /** The open code fence, and its line's prefix: a line indented less, or with fewer quote markers, leaves it. */
  fence: string;
  fenceWidth: number;
  fenceQuotes: number;
  /** Inside raw html: what ends it ('' for a blank line), or null. No fence opens there. */
  html: string | null;
  /** The text column of the list item a line indented at least as far belongs to (Turndown indents its code there), or 0. */
  itemCol: number;
  /** The current block's length and marks. */
  len: number;
  marks: number;
  blocks: number;
  squares: number;
  cost: number;
  tokens: number;
};

/** Ends the block the scan is in, adding its marks to the article's. */
function close(s: Scan): void {
  if (s.len > 0) {
    s.blocks++;
    s.squares += s.marks * s.marks;
    s.cost += s.marks * s.len;
  }
  s.len = 0;
  s.marks = 0;
}

/** Whether a code line leaves its fence: its closing fence, or a line its container no longer holds. */
function leaves(md: string, i: number, end: number, p: Prefix, s: Scan): 'closed' | 'left' | null {
  const run = p.end - i - s.fenceWidth <= 3 ? fenceRun(md, p.end, end) : '';
  if (run[0] === s.fence[0] && run.length >= s.fence.length) return 'closed';
  return p.end - i < s.fenceWidth || p.quotes < s.fenceQuotes ? 'left' : null;
}

/** A line in an open code block: its length counts. A closing fence ends it; a line it can't hold is read as text. */
function codeLine(md: string, i: number, end: number, p: Prefix, s: Scan): boolean {
  const out = leaves(md, i, end, p, s);
  if (!out) {
    s.len += end - i + 1;
    return s.len > LIMITS.block;
  }
  close(s);
  s.fence = '';
  return out === 'left' ? textLine(md, i, end, p, s) : false;
}

/** The fence a line of text opens: where it starts a block, after no ordered marker, outside raw html; or ''. */
function opening(md: string, i: number, end: number, p: Prefix, s: Scan, starts: boolean): string {
  if (s.html !== null || p.ordered || !(starts || s.len === 0)) return '';
  // a list item's own code is indented to its text, and indented from there as anywhere else
  const width = p.end - i;
  const inItem = !p.item && p.quotes === 0 && s.itemCol > 0 && width >= s.itemCol;
  return fenceAt(md, p, end, inItem ? width - s.itemCol : p.indent);
}

/** The list item a line leaves the scan in: its own, for an item outside quotes; none, for text indented less. */
function itemAfter(i: number, p: Prefix, s: Scan): number {
  if (p.item) return p.quotes === 0 ? p.end - i : 0;
  return p.end - i < s.itemCol ? 0 : s.itemCol;
}

/** Raw html after a line: what the open block's end is, kept until a line holds it; what this line opens, if it opens one. */
function htmlAfter(md: string, end: number, p: Prefix, s: Scan): string | null {
  const html = p.indent <= 3 && md.charCodeAt(p.end) === LT && opensTag(md.charCodeAt(p.end + 1)) ? htmlEnd(md, p.end) : s.html;
  return html && md.slice(p.end, end).toLowerCase().includes(html) ? null : html;
}

/** A line of text: a blank line, a list item or a heading starts a block; its marks count towards it. */
function textLine(md: string, i: number, end: number, p: Prefix, s: Scan): boolean {
  if (p.end - i > LIMITS.prefix) return true;
  const blank = p.end === end;
  const starts = blank || p.item || md.charCodeAt(p.end) === HASH;
  if (starts) close(s);
  if (blank) {
    if (s.html === '') s.html = null;
    return false;
  }
  const fence = opening(md, i, end, p, s, starts);
  s.itemCol = itemAfter(i, p, s);
  if (fence) {
    close(s);
    Object.assign(s, { fence, fenceWidth: p.end - i, fenceQuotes: p.quotes });
    return false;
  }
  s.html = htmlAfter(md, end, p, s);
  s.len += end - i + 1;
  s.marks += marksIn(md, p.end, end);
  s.tokens += tokensIn(md, p.end, end);
  return s.len > LIMITS.block || s.marks > LIMITS.marks || s.marks * s.len > LIMITS.blockCost;
}

/**
 * Whether Markdown goes past what the parse and the projection take in linear time: too deep, a block too long or
 * too marked, too many blocks, or too many marks in all. One pass over the characters.
 */
export function beyondLimits(md: string): boolean {
  if (md.length > LIMITS.length) return true;
  const s: Scan = { fence: '', fenceWidth: 0, fenceQuotes: 0, html: null, itemCol: 0, len: 0, marks: 0, blocks: 0, squares: 0, cost: 0, tokens: 0 };
  for (let i = 0; i < md.length; ) {
    let end = md.indexOf('\n', i);
    if (end === -1) end = md.length;
    const p = prefixOf(md, i, end);
    // inside a fence, indentation past the fence's own is the code's: a line leaving it is checked as text
    if (s.fence ? codeLine(md, i, end, p, s) : textLine(md, i, end, p, s)) return true;
    if (s.blocks > LIMITS.blocks) return true;
    i = end + 1;
  }
  close(s);
  return s.blocks > LIMITS.blocks || s.squares > squaresAllowed(md.length) || s.cost > costAllowed(md.length) || s.tokens > tokensAllowed(md.length);
}
