// An article read plain (mobile spec 6.7), for Markdown past what the CommonMark parse takes in linear time and the
// Reader lays out (./limits), or that throws all the same: all its text, without inline styling.
// Paragraphs run between blank lines, and a list item starts one; # headings and fenced code keep their kind, code
// as written; a line's indentation and quote markers go; a backslash escape reads as the character it escapes; a
// line that is only an image stays an image. One pass over the lines with nothing that backtracks, so its time is
// linear whatever the Markdown holds. Words are the spoken text's whitespace-separated runs, as in C§7.
import type { Sentence } from '@kefli/protocol';
import type { Block } from './blocks';
import { LIMITS } from './limits';

type Shown = Block extends infer B ? (B extends unknown ? Omit<B, 'firstWord' | 'words'> : never) : never;

type Part =
  | { kind: 'p'; start: number; text: string }
  | { kind: 'h'; start: number; text: string; level: number }
  | { kind: 'code'; start: number; text: string }
  | { kind: 'img'; start: number; src: string; alt: string };

/** A sentence's words and characters at most, so a voice is never handed a whole block of run-on text. */
export const SENTENCE_WORDS = 60;
export const SENTENCE_CHARS = 600;

// Built from strings, as in the protocol package: the code gate's parser loses its place at a backtick, and in a
// regex literal holding a slash, and then scores nothing after it.
const TICK = '\u0060';
const ESCAPE = new RegExp('\\\\([!-/:-@[-' + TICK + '{-~])', 'g');
const unescape = (s: string) => s.replace(ESCAPE, '$1');
const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();
// a whole line that is one image of a web address: its description holds no ], its address no space or )
const IMAGE = new RegExp('^!\\[([^\\]]*)\\]\\((https?://[^\\s)]+)\\)$');
const ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

/** Where a line's text starts after its indentation and quote markers. */
function textStart(md: string, i: number, end: number): number {
  let k = i;
  while (k < end && ' \t>'.includes(md[k])) k++;
  return k;
}

/** The fence a line opens or closes with: three or more backticks or tildes; or ''. */
function fenceOf(line: string): string {
  const c = line[0];
  if (c !== TICK && c !== '~') return '';
  let k = 0;
  while (k < line.length && line[k] === c) k++;
  return k >= 3 ? line.slice(0, k) : '';
}

/** An ATX heading's level, or 0: one to six # and then a space or the line's end. */
function headingLevel(line: string): number {
  let k = 0;
  while (k < 7 && line[k] === '#') k++;
  return k <= 6 && (k === line.length || line[k] === ' ') ? k : 0;
}

type Code = { fence: string; lines: string[]; start: number };
type Reading = { parts: Part[]; lines: string[]; start: number; code: Code | null };

/** The paragraph being read, ended: its lines joined, unescaped. */
function endParagraph(r: Reading): void {
  if (r.lines.length) r.parts.push({ kind: 'p', start: r.start, text: unescape(r.lines.join(' ')) });
  r.lines = [];
}

/** A line inside fenced code: kept as written, until its closing fence. */
function codeLine(r: Reading, line: string, raw: string): void {
  const code = r.code!;
  const fence = fenceOf(line);
  if (fence[0] === code.fence[0] && fence.length >= code.fence.length) {
    r.parts.push({ kind: 'code', start: code.start, text: code.lines.join('\n') });
    r.code = null;
  } else code.lines.push(raw);
}

/** A line that stands alone: a heading or a lone image; or a fence, which opens code; null for a paragraph's text. */
function alone(line: string, at: number): Part | { fence: string } | null {
  const fence = fenceOf(line);
  if (fence) return { fence };
  const level = headingLevel(line);
  if (level) return { kind: 'h', start: at, level, text: unescape(line.slice(level)) };
  const img = IMAGE.exec(line);
  return img ? { kind: 'img', start: at, alt: img[1], src: img[2] } : null;
}

/** A line outside code: a fence, a heading, a lone image, a blank line, or a paragraph's text (a list item starts one). */
function textLine(r: Reading, line: string, at: number): void {
  const part = alone(line, at);
  if (part || !line || ITEM.test(line)) endParagraph(r);
  if (part && 'fence' in part) r.code = { fence: part.fence, lines: [], start: at };
  else if (part) r.parts.push(part);
  else if (line) {
    if (!r.lines.length) r.start = at;
    r.lines.push(line);
  }
}

/** The Markdown's parts, line by line. */
function parts(md: string): Part[] {
  const r: Reading = { parts: [], lines: [], start: 0, code: null };
  for (let i = 0; i < md.length; ) {
    let end = md.indexOf('\n', i);
    if (end === -1) end = md.length;
    const line = md.slice(textStart(md, i, end), end);
    if (r.code) codeLine(r, line, md.slice(i, end));
    else textLine(r, line, i);
    i = end + 1;
  }
  endParagraph(r);
  // an unclosed fence runs to the end, as in CommonMark
  if (r.code) r.parts.push({ kind: 'code', start: r.code.start, text: r.code.lines.join('\n') });
  return r.parts;
}

// the straight quotes by their codes, as in the protocol package: the code gate's parser loses its place at them
const CLOSERS = '\u0022\u0027)]}”’»';
const OPENERS = '\u0022\u0027“‘«([';

/** Whether the word from..to ends a sentence: . ! ? or … before any closing quotes or brackets. */
function terminal(said: string, from: number, to: number): boolean {
  let k = to - 1;
  while (k > from && CLOSERS.includes(said[k])) k--;
  return '.!?…'.includes(said[k]);
}

/** Whether a word can start a sentence: a capital, a digit, or an opening quote or bracket. */
function opener(c: string): boolean {
  return OPENERS.includes(c) || (c >= '0' && c <= '9') || (c.toUpperCase() === c && c.toLowerCase() !== c);
}

/** The collapsed text's word starts: 0, and after each space. */
function wordStarts(said: string): number[] {
  const out: number[] = said ? [0] : [];
  for (let k = said.indexOf(' '); k !== -1; k = said.indexOf(' ', k + 1)) out.push(k + 1);
  return out;
}

/** A block's sentences: one ends at a terminal word before a capital, at SENTENCE_WORDS or SENTENCE_CHARS, or with the block. */
function sentencesOf(said: string, starts: number[], firstWord: number, out: Sentence[]): void {
  let first = 0;
  for (let w = 0; w < starts.length; w++) {
    const last = w + 1 === starts.length;
    const end = last ? said.length : starts[w + 1] - 1;
    const full = w - first + 1 >= SENTENCE_WORDS || end - starts[first] >= SENTENCE_CHARS;
    if (last || full || (terminal(said, starts[w], end) && opener(said[starts[w + 1]]))) {
      const at = starts[first];
      out.push({ text: said.slice(at, end), wordStarts: starts.slice(first, w + 1).map((s) => s - at), firstWord: firstWord + first });
      first = w + 1;
    }
  }
}

/**
 * A plain block's characters at most (no more than the voice takes in a sentence, VOICE_CHARS, should one word fill
 * it), and an article's blocks (as many as the parse takes, LIMITS.blocks): a longer paragraph is cut between words
 * and a longer code block between lines, and past PLAIN_BLOCKS neighbouring paragraphs run together (headings too,
 * if that isn't enough), so the Reader never lays out one text of a megabyte or mounts a hundred thousand.
 */
export const PLAIN_CHARS = 3_000;
export const PLAIN_BLOCKS = LIMITS.blocks;

/** A part as it shows and says: its text collapsed (code keeps its lines), and a heading's spoken full stop. */
type Piece = { part: Part; shown: string; said: string };

function pieceOf(p: Part): Piece | null {
  if (p.kind === 'img') return { part: p, shown: '', said: '' };
  const shown = collapse(p.text);
  if (!shown) return null;
  const said = p.kind === 'h' && !terminal(shown, 0, shown.length) ? `${shown}.` : shown;
  return { part: p, shown: p.kind === 'code' ? p.text : shown, said };
}

/**
 * Where to cut text from at: the last space (or line end, for code) in the second half of the cap after it, else at
 * the cap. Searched in that window only, so text with no space at all costs a cap a cut, not its whole length.
 */
function cutAt(text: string, at: number, cap: number, code: boolean): number {
  const from = at + Math.floor(cap / 2);
  const k = text.slice(from, at + cap).lastIndexOf(code ? '\n' : ' ');
  return k === -1 ? at + cap : from + k;
}

/**
 * A piece over cap, cut into pieces of at most cap characters, by index: slicing the rest off each time copies it
 * each time on Hermes, which has no shared substrings, and a 20 MB paragraph would be copied thousands of times.
 */
function cut(piece: Piece, cap: number, out: Piece[]): void {
  const code = piece.part.kind === 'code';
  const text = piece.shown;
  let at = 0;
  while (text.length - at > cap) {
    const k = cutAt(text, at, cap, code);
    const head = text.slice(at, k);
    out.push({ part: piece.part, shown: head, said: code ? collapse(head) : head });
    // a cut at a line's end or a space drops it; a cut inside a word or a line keeps every character
    at = text[k] === (code ? '\n' : ' ') ? k + 1 : k;
  }
  const rest = text.slice(at);
  if (rest) out.push({ part: piece.part, shown: rest, said: code ? collapse(rest) : rest });
}

/** Whether a piece can run into a paragraph: a paragraph, or a heading when they go too. */
const joinable = (x: Piece, headings: boolean) => x.part.kind === 'p' || (headings && x.part.kind === 'h');

/** Pieces run into one paragraph, a blank line between them as shown: joined once, not one at a time. */
function joined(group: Piece[]): Piece {
  if (group.length === 1) return group[0];
  return { part: { ...group[0].part, kind: 'p' } as Part, shown: group.map((g) => g.shown).join('\n\n'), said: group.map((g) => g.said).join(' ') };
}

/** Paragraphs next to each other (and headings, when they go too) run into paragraphs of up to cap characters. */
function runTogether(pieces: Piece[], cap: number, headings: boolean): Piece[] {
  const out: Piece[] = [];
  let group: Piece[] = [];
  let size = 0;
  for (const x of pieces) {
    const joins = joinable(x, headings);
    if (group.length && (!joins || size + 2 + x.shown.length > cap)) {
      out.push(joined(group));
      group = [];
      size = 0;
    }
    if (!joins) {
      out.push(x);
      continue;
    }
    size += (group.length ? 2 : 0) + x.shown.length;
    group.push(x);
  }
  if (group.length) out.push(joined(group));
  return out;
}

/** The parts as pieces of bounded size, run together when there are more than PLAIN_BLOCKS. */
function pieces(md: string): Piece[] {
  const cap = Math.max(PLAIN_CHARS, Math.ceil(md.length / PLAIN_BLOCKS) * 2);
  const out: Piece[] = [];
  for (const p of parts(md)) {
    const x = pieceOf(p);
    if (x && x.shown.length > cap) cut(x, cap, out);
    else if (x) out.push(x);
  }
  if (out.length <= PLAIN_BLOCKS) return out;
  // paragraphs first, between the headings; headings too only if that isn't enough
  const fewer = runTogether(out, cap, false);
  return fewer.length <= PLAIN_BLOCKS ? fewer : runTogether(fewer, cap, true);
}

/** What a piece shows, as a block before its words are counted. */
function blockOf({ part: p, shown }: Piece): Shown {
  if (p.kind === 'code') return { kind: 'code', start: p.start, text: shown };
  if (p.kind === 'img') return { kind: 'img', start: p.start, src: p.src, alt: p.alt };
  if (p.kind === 'h') return { kind: 'h', start: p.start, level: p.level, spans: [{ text: shown }] };
  return { kind: 'p', start: p.start, spans: [{ text: shown }] };
}

/** The article read plain: its blocks, words, sentences and spoken text (spoken blocks a blank line apart). */
export function plainArticle(md: string): { blocks: Block[]; words: number; sentences: Sentence[]; spoken: string } {
  const blocks: Block[] = [];
  const sentences: Sentence[] = [];
  const spoken: string[] = [];
  let words = 0;
  for (const x of pieces(md)) {
    const starts = wordStarts(x.said);
    blocks.push({ ...blockOf(x), firstWord: words, words: starts.length } as Block);
    if (!x.said) continue;
    sentencesOf(x.said, starts, words, sentences);
    spoken.push(x.said);
    words += starts.length;
  }
  return { blocks, words, sentences, spoken: spoken.join('\n\n') };
}
