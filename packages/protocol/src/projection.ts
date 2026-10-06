// The spoken projection (contract 4.2): what a voice reads and what words counts, with each spoken
// character mapped to its offset in the normalised Markdown for word highlighting (contract 7).
// Runs on Hermes from the normalised string (mobile spec 2.6). Where this and the page fixtures
// disagree, the fixtures win; choices the contract leaves open are marked RULED (contract 1.4, section 11.1).

import { fromMarkdown } from 'mdast-util-from-markdown';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';
import type { Nodes, Parents, Root } from 'mdast';

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

/** A closing quote or bracket that may follow terminal punctuation. */
const CLOSERS = `"'”’»)]}`;
const TERMINAL = new RegExp(`[.!?][${CLOSERS.replace(']', '\\]')}]?$`);

const ENTITY = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{0,31}));/;

function decodeEntity(m: RegExpExecArray): string | null {
  if (m[3]) {
    const named = decodeNamedCharacterReference(m[3]);
    return named === false ? null : named;
  }
  const cp = m[1] ? parseInt(m[1], 16) : parseInt(m[2], 10);
  // CommonMark: 0 and anything invalid become U+FFFD.
  return cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp);
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

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
  while (j < value.length) {
    if (i >= end) {
      // Nothing left to align with; keep the map monotonic.
      out.push(Math.max(start, end - 1));
      j++;
      continue;
    }
    const s = src[i];
    if (s === value[j]) {
      out.push(i++);
      j++;
    } else if (s === '\\' && ASCII_PUNCT.test(src[i + 1] ?? '') && src[i + 1] === value[j]) {
      out.push(i + 1);
      i += 2;
      j++;
    } else if (s === '&') {
      const m = ENTITY.exec(src.slice(i, i + 40));
      const decoded = m && decodeEntity(m);
      if (m && decoded && value.startsWith(decoded, j)) {
        for (let k = 0; k < decoded.length; k++) out.push(i);
        i += m[0].length;
        j += decoded.length;
      } else {
        i++;
      }
    } else {
      i++;
    }
  }
  return out;
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
    this.#blockOffsets.push(...offsets);
  }

  /** Add synthetic characters, mapped to the last real offset. */
  #synthetic(s: string) {
    const at = this.#blockOffsets.length ? this.#blockOffsets[this.#blockOffsets.length - 1] : (this.offsets[this.offsets.length - 1] ?? 0);
    this.#block += s;
    for (let k = 0; k < s.length; k++) this.#blockOffsets.push(at);
  }

  /** End a block: each run of whitespace (JS \s, so no-break spaces too) becomes one space (RULED), and headings and list items get a full stop. */
  end(fullStop: boolean) {
    // Collapse and trim whitespace, keeping the offset of each kept character.
    let block = '';
    const offs: number[] = [];
    for (let k = 0; k < this.#block.length; k++) {
      const c = this.#block[k];
      if (/\s/.test(c)) {
        if (block !== '' && !block.endsWith(' ')) {
          block += ' ';
          offs.push(this.#blockOffsets[k]);
        }
      } else {
        block += c;
        offs.push(this.#blockOffsets[k]);
      }
    }
    if (block.endsWith(' ')) {
      block = block.slice(0, -1);
      offs.pop();
    }
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
    this.offsets.push(...offs);
    if (fullStop && !TERMINAL.test(block)) {
      this.text += '.';
      this.offsets.push(offs[offs.length - 1]);
    }
  }
}

function inline(b: Builder, node: Nodes): void {
  const pos = node.position;
  switch (node.type) {
    case 'text':
    case 'html':
      // Raw HTML is read as written: Turndown writes no tags of its own (turndown-rules.json keeps none), so
      // any in the Markdown was literal text in the article, such as prose about <div>.
      if (pos) b.push(node.value, align(node.value, b.src, pos.start.offset!, pos.end.offset!));
      return;
    case 'inlineCode':
      if (pos) b.push(node.value, align(node.value, b.src, pos.start.offset!, pos.end.offset!));
      return;
    case 'break':
      if (pos) b.push(' ', [pos.start.offset!]);
      return;
    case 'image':
    case 'imageReference':
    case 'definition':
      // Images go with their alt text; definitions are syntax.
      return;
    default:
      if ('children' in node) for (const c of node.children) inline(b, c);
  }
}

function block(b: Builder, node: Nodes, inListItem: boolean): void {
  const pos = node.position;
  switch (node.type) {
    case 'heading':
      for (const c of node.children) inline(b, c);
      b.end(true);
      return;
    case 'paragraph':
      for (const c of node.children) inline(b, c);
      // RULED: the full stop goes on each paragraph directly inside a list item.
      b.end(inListItem);
      return;
    case 'code': {
      // RULED: code blocks are spoken, as the text of a node. Each value line is the end of its source line,
      // since the parser only removes indentation from the front.
      if (!pos) return;
      // A fenced block's content starts on the line after its fence; an indented block's on its own first line.
      const lineOf = b.src.lastIndexOf('\n', pos.start.offset! - 1) + 1;
      const fenced = /^[ \t>]*(```|~~~)/.test(b.src.slice(lineOf, pos.end.offset!));
      let lineStart = fenced ? b.src.indexOf('\n', pos.start.offset!) + 1 : lineOf;
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
      return;
    }
    case 'html':
      if (pos) b.push(node.value, align(node.value, b.src, pos.start.offset!, pos.end.offset!));
      b.end(false);
      return;
    case 'thematicBreak':
    case 'definition':
      return;
    case 'listItem':
      for (const c of node.children) block(b, c, true);
      return;
    default:
      if ('children' in node) for (const c of (node as Parents).children) block(b, c, false);
  }
}

/** The spoken projection of normalised Markdown, parsed as CommonMark. */
export function project(markdown: string): Projection {
  const tree: Root = fromMarkdown(markdown);
  const b = new Builder(markdown);
  for (const c of tree.children) block(b, c, false);
  const wordStarts: number[] = [];
  const re = /\S+/g;
  for (let m = re.exec(b.text); m; m = re.exec(b.text)) wordStarts.push(m.index);
  return { text: b.text, offsets: b.offsets, wordStarts, blockStarts: b.blockStarts };
}

/** words for the item JSON: the whitespace-separated tokens of the projection. */
export function countWords(markdown: string): number {
  return project(markdown).wordStarts.length;
}
