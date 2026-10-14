// The spoken projection (contract 4.2): what a voice reads and what words counts, with each spoken
// character mapped to its offset in the normalised Markdown for word highlighting (contract 7).
// Runs on Hermes from the normalised string (mobile spec 2.6). Where this and the page fixtures
// disagree, the fixtures win; choices the contract leaves open are marked RULED (contract 1.4, section 11.9).
// Every pass is linear in the Markdown, and none recurses: the tree is walked with a stack of its own (Walk below).

import { fromMarkdown } from 'mdast-util-from-markdown';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import type { Code, Html, InlineCode, Link, ListItem, Nodes, Parents, Root, Text } from 'mdast';

export interface Projection {
  /** The spoken text: blocks separated by a blank line. */
  text: string;
  /** offsets[i] is the Markdown offset of text[i]. Added characters (separators, full stops) take the previous character's offset. */
  offsets: number[];
  /** Start index in text of each whitespace-separated word; words = wordStarts.length. */
  wordStarts: number[];
  /** Start index in text of each block, in order. */
  blockStarts: number[];
}

/**
 * A closing quote or bracket that may follow terminal punctuation. This, ENTITY, ASCII_PUNCT, FENCE and the word match
 * are built from plain strings: the code gate's parser loses its place in a template or a regex literal holding quotes,
 * a backtick or a slash, and stops scoring the functions after it.
 */
const CLOSERS = '\u0022\u0027”’»)]}';
const TERMINAL = new RegExp('[.!?][' + CLOSERS.replace(']', '\\]') + ']?$');

const ENTITY = new RegExp('^&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{0,31}));');

function decodeEntity(m: RegExpExecArray): string | null {
  if (m[3]) {
    const named = decodeNamedCharacterReference(m[3]);
    return named === false ? null : named;
  }
  const cp = m[1] ? parseInt(m[1], 16) : parseInt(m[2], 10);
  // CommonMark: 0 and anything invalid become U+FFFD.
  return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp);
}

const ASCII_PUNCT = new RegExp('[!-/:-@[-\u0060{-~]');

/** A backslash escape at src[i] of c, the character the value holds next: CommonMark escapes ASCII punctuation only. */
function escapes(src: string, i: number, c: string): boolean {
  return src[i] === '\\' && ASCII_PUNCT.test(src[i + 1] ?? '') && src[i + 1] === c;
}

/**
 * Map each character of a node's decoded value to its offset in the source, between start and end.
 * Walks both together: escapes (\*) map to the escaped character, references (&amp;) to their '&',
 * and source characters the value doesn't have (container prefixes after a line break, the stripped
 * indentation of a continuation line) are skipped.
 */
function align(value: string, src: string, start: number, end: number): number[] {
  const out: number[] = [];
  let i = start;
  let j = 0;
  let ref: { source: number; decoded: number } | null;
  while (j < value.length) {
    if (i >= end) {
      // Nothing left to align with; keep the map monotonic.
      out.push(Math.max(start, end - 1));
      j++;
    } else if (src[i] === value[j]) {
      out.push(i++);
      j++;
    } else if (escapes(src, i, value[j])) {
      out.push(i + 1);
      i += 2;
      j++;
    } else if (src[i] === '&' && (ref = referenceAt(src, i, value, j))) {
      for (let k = 0; k < ref.decoded; k++) out.push(i);
      i += ref.source;
      j += ref.decoded;
    } else {
      i++;
    }
  }
  return out;
}

/** A character reference at src[i] that decodes to what value holds at j: how long it is in each, or null. */
function referenceAt(src: string, i: number, value: string, j: number): { source: number; decoded: number } | null {
  const m = ENTITY.exec(src.slice(i, i + 40));
  const decoded = m && decodeEntity(m);
  return m && decoded && value.startsWith(decoded, j) ? { source: m[0].length, decoded: decoded.length } : null;
}

/**
 * Appends xs to out one at a time: push(...xs) passes every element as an argument, and a block of a few hundred
 * thousand characters (a long <pre>, a PDF paragraph that never ends a sentence) is past the engine's stack for that.
 */
function append(out: number[], xs: number[]): void {
  for (const x of xs) out.push(x);
}

class Builder {
  text = '';
  offsets: number[] = [];
  blockStarts: number[] = [];
  #block = '';
  #blockOffsets: number[] = [];

  constructor(readonly src: string) {}

  push(value: string, offsets: number[]) {
    this.#block += value;
    append(this.#blockOffsets, offsets);
  }

  /** End a block: each run of whitespace (JS \s, so no-break spaces too) becomes one space (RULED), and headings and list items get a full stop. */
  end(fullStop: boolean) {
    // Collapse and trim whitespace, keeping the offset of each kept character: a run becomes one space at its first
    // character's offset, written once something follows it. Nothing reads back the block while it is built, since
    // V8 copies a string grown a character at a time whole to read its end, which made a long block quadratic.
    const raw = this.#block;
    const parts: string[] = [];
    const offs: number[] = [];
    let space = -1;
    for (let k = 0; k < raw.length; k++) {
      const c = raw[k];
      if (/\s/.test(c)) {
        if (offs.length > 0 && space === -1) space = this.#blockOffsets[k];
        continue;
      }
      if (space !== -1) {
        parts.push(' ');
        offs.push(space);
        space = -1;
      }
      parts.push(c);
      offs.push(this.#blockOffsets[k]);
    }
    const block = parts.join('');
    this.#block = '';
    this.#blockOffsets = [];
    if (block === '') return;
    if (this.text !== '') {
      const at = this.offsets[this.offsets.length - 1];
      this.text += '\n\n';
      this.offsets.push(at, at);
    }
    this.blockStarts.push(this.text.length);
    this.text += block;
    append(this.offsets, offs);
    if (fullStop && !TERMINAL.test(block)) {
      this.text += '.';
      this.offsets.push(offs[offs.length - 1]);
    }
  }
}

/** Pushes items onto a stack the last first, so the first of them is the next taken from its top. */
function later<T>(stack: T[], items: readonly T[]): void {
  for (let k = items.length - 1; k >= 0; k--) stack.push(items[k]);
}

/** A link target's fragment, percent-decoded where it can be; '' when there is none. */
function fragment(url: string): string {
  const at = url.indexOf('#');
  if (at === -1) return '';
  const f = url.slice(at + 1);
  try {
    return decodeURIComponent(f);
  } catch {
    return f;
  }
}

/** The text of a node and all it holds, in document order, gathered with a stack: a link may hold emphasis of any depth. */
function textOf(node: Nodes): string {
  const parts: string[] = [];
  const stack: Nodes[] = [node];
  for (let n = stack.pop(); n; n = stack.pop()) {
    if ('value' in n && typeof n.value === 'string') parts.push(n.value);
    else if ('children' in n) later<Nodes>(stack, n.children);
  }
  return parts.join('');
}

/**
 * Citation and footnote markers, which the voice skips (contract 4.2, flow decision 102); the Reader still shows
 * them. MediaWiki's markers link to the page's own #cite_note-… whatever their text ([1], [a], [原 1]), so the rule
 * reads the target: a bracket in the text alone could be IPA, as in the Greek fixture's [eliniˈka].
 */
function silentLink(link: Link): boolean {
  const f = fragment(link.url);
  const t = textOf(link).trim();
  if (/^cite_note-/.test(f)) return true;
  // Other sites' footnotes (Substack, Ghost, Markdown generators): a bare number to #footnote-1, #fn1, #note-1.
  if (/^(?:fn|footnote|note)[-_:.]?\w/i.test(f) && /^\[?\d{1,3}\]?$/.test(t)) return true;
  // Their back-links: an arrow or caret to #fnref1, #footnote-anchor-1, #cite_ref-1.
  return /^(?:fnref|footnote-anchor|cite_ref)/i.test(f) && /^[\s^↑↩︎️]+$/.test(t);
}

/** Wikipedia's own project namespace, in the languages that localise its name; most keep "Wikipedia". */
const PROJECT_PAGE = new RegExp('/wiki/(?:Wikipedia|Wikipédia|Project|Википедия|Вікіпедія|Βικιπαίδεια|ويكيبيديا|ویکی‌پدیا|ויקיפדיה|위키백과|विकिपीडिया|วิกิพีเดีย):', 'i');

function decodedPath(url: string): string {
  try {
    return decodeURI(url.split('#')[0]);
  } catch {
    return url;
  }
}

/**
 * The inline nodes the voice may skip, decided once for the whole tree, each node after everything it holds, so a run
 * of emphasis nested however deep is decided in one pass rather than afresh at each of its levels.
 */
interface Skips {
  /** Citation and footnote markers (silentLink), and emphasis holding nothing else. */
  unspoken: Set<Nodes>;
  /** Links into the project namespace, alone or in emphasis: a maintenance tag, when bracketed (inlines). */
  project: Set<Nodes>;
}

/** Every node of the tree, each after all it holds: the reverse of the order a stack walk meets them in. */
function bottomUp(tree: Root): Nodes[] {
  const met: Nodes[] = [];
  const stack: Nodes[] = [tree];
  for (let n = stack.pop(); n; n = stack.pop()) {
    met.push(n);
    if ('children' in n) for (const c of n.children) stack.push(c);
  }
  return met.reverse();
}

/** A marker, or emphasis (or strikethrough) holding only markers. */
function unspoken(node: Nodes, skips: Skips): boolean {
  if (node.type === 'link') return silentLink(node);
  if (node.type !== 'emphasis' && node.type !== 'strong' && node.type !== 'delete') return false;
  return node.children.length > 0 && node.children.every((c) => skips.unspoken.has(c));
}

/** A link into the project namespace, alone or in emphasis: a maintenance tag such as citation needed or dead link. */
function projectLink(node: Nodes, skips: Skips): boolean {
  if (node.type === 'link') return PROJECT_PAGE.test(decodedPath(node.url));
  if (node.type === 'emphasis' || node.type === 'strong') return node.children.length === 1 && skips.project.has(node.children[0]);
  return false;
}

function skipsOf(tree: Root): Skips {
  const skips: Skips = { unspoken: new Set(), project: new Set() };
  for (const n of bottomUp(tree)) {
    if (unspoken(n, skips)) skips.unspoken.add(n);
    if (projectLink(n, skips)) skips.project.add(n);
  }
  return skips;
}

const opens = (n: Nodes | undefined) => n?.type === 'text' && n.value.endsWith('[');
const closes = (n: Nodes | undefined) => n?.type === 'text' && n.value.startsWith(']');

/**
 * A MediaWiki reference list entry: its first paragraph opens, after any caret or arrow, with a back-link to
 * #cite_ref-…. The voice skips the whole entry, notes nested in it included.
 */
function isReferenceEntry(item: ListItem): boolean {
  const first = item.children[0];
  if (!first || first.type !== 'paragraph') return false;
  for (const c of first.children) {
    if (c.type === 'text' && /^[\s^↑]*$/.test(c.value)) continue;
    return c.type === 'link' && /^cite_ref-/.test(fragment(c.url));
  }
  return false;
}

/**
 * What the walk does next: read a block or an inline node, push a text's value as it is spoken (without the bracket of
 * a maintenance tag beside it), or end a block.
 */
type Step =
  | { kind: 'block'; node: Nodes; inListItem: boolean }
  | { kind: 'inline'; node: Nodes }
  | { kind: 'text'; value: string; start: number; end: number }
  | { kind: 'end'; fullStop: boolean };

const blockSteps = (nodes: readonly Nodes[], inListItem: boolean): Step[] => nodes.map((node) => ({ kind: 'block', node, inListItem }));

/** A text node's step, without the '[' before a skipped tag and the ']' after one. */
function textStep(c: Text, afterSkipped: boolean, beforeSkipped: boolean): Step {
  let value = c.value;
  if (beforeSkipped && value.endsWith('[')) value = value.slice(0, -1);
  if (afterSkipped && value.startsWith(']')) value = value.slice(1);
  return { kind: 'text', value, start: c.position!.start.offset!, end: c.position!.end.offset! };
}

/**
 * A run of inline siblings as steps, without the unspoken ones. Maintenance tags ("[citation needed]", "[dead link]")
 * keep their brackets outside the link, in the text either side, so a tag counts only when bracketed, and its '[' and
 * ']' go with it; a project link in running prose is read.
 */
function inlines(kids: readonly Nodes[], skips: Skips): Step[] {
  const skip = kids.map((c, k) => skips.unspoken.has(c) || (skips.project.has(c) && opens(kids[k - 1]) && closes(kids[k + 1])));
  const steps: Step[] = [];
  kids.forEach((c, k) => {
    if (skip[k]) return;
    if (c.type === 'text' && c.position) steps.push(textStep(c, skip[k - 1], skip[k + 1]));
    else steps.push({ kind: 'inline', node: c });
  });
  return steps;
}

/** A node read as written, its characters mapped to the source; nothing for one without a position. */
function literal(b: Builder, node: Text | Html | InlineCode): void {
  const pos = node.position;
  if (pos) b.push(node.value, align(node.value, b.src, pos.start.offset!, pos.end.offset!));
}

// A fence of three backticks or tildes, built from strings: the code gate's parser loses its place at a backtick.
const FENCE = new RegExp('^[ \\t>]*(' + '\u0060'.repeat(3) + '|~~~)');

/**
 * RULED: code blocks are spoken, as the text of a node. Each value line is the end of its source line, since the
 * parser only removes indentation from the front. A code block without a position says nothing.
 */
function codeBlock(b: Builder, node: Code): void {
  if (!node.position) return;
  const start = node.position.start.offset!;
  // A fenced block's content starts on the line after its fence; an indented block's on its own first line.
  const lineOf = b.src.lastIndexOf('\n', start - 1) + 1;
  const fenced = FENCE.test(b.src.slice(lineOf, node.position.end.offset!));
  let lineStart = fenced ? b.src.indexOf('\n', start) + 1 : lineOf;
  const lines = node.value.split('\n');
  lines.forEach((line, n) => {
    let lineEnd = b.src.indexOf('\n', lineStart);
    if (lineEnd === -1) lineEnd = b.src.length;
    const srcLine = b.src.slice(lineStart, lineEnd);
    const at = lineStart + Math.max(0, srcLine.length - line.length);
    b.push(line, Array.from(line, (_, k) => at + k));
    if (n < lines.length - 1) b.push('\n', [lineEnd]);
    lineStart = lineEnd + 1;
  });
  b.end(false);
}

/**
 * The tree read in document order with a stack of steps rather than by recursion, so nesting of any depth is read:
 * quotes 5,000 deep overflowed desktop V8's stack, and the phone's Hermes has less of it. A step puts what it holds on
 * the stack the last first, so the step on top is always the next in the document.
 */
class Walk {
  readonly todo: Step[] = [];

  constructor(
    readonly b: Builder,
    readonly skips: Skips,
  ) {}

  run(nodes: readonly Nodes[]): void {
    later(this.todo, blockSteps(nodes, false));
    for (let step = this.todo.pop(); step; step = this.todo.pop()) this.take(step);
  }

  take(step: Step): void {
    switch (step.kind) {
      case 'block':
        return block(this, step.node, step.inListItem);
      case 'inline':
        return inline(this, step.node);
      case 'text':
        return this.b.push(step.value, align(step.value, this.b.src, step.start, step.end));
      default:
        return this.b.end(step.fullStop);
    }
  }

  /** A heading's or a paragraph's inline content, then its end. */
  phrasing(kids: readonly Nodes[], fullStop: boolean): void {
    const steps = inlines(kids, this.skips);
    steps.push({ kind: 'end', fullStop });
    later(this.todo, steps);
  }
}

function block(w: Walk, node: Nodes, inListItem: boolean): void {
  switch (node.type) {
    case 'heading':
      return w.phrasing(node.children, true);
    case 'paragraph':
      // RULED: the full stop goes on each paragraph directly inside a list item.
      return w.phrasing(node.children, inListItem);
    case 'code':
      return codeBlock(w.b, node);
    case 'html':
      literal(w.b, node);
      return w.b.end(false);
    case 'listItem':
      if (!isReferenceEntry(node)) later(w.todo, blockSteps(node.children, true));
      return;
    default:
      // A thematic break or a definition holds nothing, and is silent.
      if ('children' in node) later(w.todo, blockSteps((node as Parents).children, false));
  }
}

function inline(w: Walk, node: Nodes): void {
  switch (node.type) {
    case 'text':
    case 'html':
    case 'inlineCode':
      // Raw HTML is read as written: Turndown writes no tags of its own (turndown-rules.json keeps none), so
      // any in the Markdown was literal text in the article, such as prose about <div>.
      return literal(w.b, node);
    case 'break':
      if (node.position) w.b.push(' ', [node.position.start.offset!]);
      return;
    case 'image':
    case 'imageReference':
    case 'definition':
      // Images go with their alt text; definitions are syntax.
      return;
    default:
      if ('children' in node) later(w.todo, inlines(node.children, w.skips));
  }
}

/** The spoken projection of normalised Markdown, parsed as CommonMark. */
export function project(markdown: string): Projection {
  return projectTree(markdown, fromMarkdown(markdown));
}

/** The projection from a CommonMark tree already parsed from markdown, so a caller that needs the tree too parses once. */
export function projectTree(markdown: string, tree: Root): Projection {
  const b = new Builder(markdown);
  new Walk(b, skipsOf(tree)).run(tree.children);
  const wordStarts: number[] = [];
  const re = new RegExp('\\S+', 'g');
  for (let m = re.exec(b.text); m; m = re.exec(b.text)) wordStarts.push(m.index);
  return { text: b.text, offsets: b.offsets, wordStarts, blockStarts: b.blockStarts };
}

/** words for the item JSON: the whitespace-separated tokens of the projection. */
export function countWords(markdown: string): number {
  return project(markdown).wordStarts.length;
}
