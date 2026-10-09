// The Reader's blocks (mobile spec 6.7): the article's Markdown parsed once with mdast-util-from-markdown, whose
// nodes carry exact source offsets, into paragraphs, headings, list items, quotes, code and images with their
// inline styling. Each block records the first spoken word it holds, through the spoken projection's map from
// spoken characters to Markdown offsets (C§7), so a stored word position finds its block and back.
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Nodes, PhrasingContent, RootContent } from 'mdast';
import { projectTree, sentences, type Sentence } from '@kefli/protocol';

export type Span = { text: string; em?: boolean; strong?: boolean; code?: boolean; href?: string };

type Base = { start: number; firstWord: number; words: number };
export type Block = Base & (
  | { kind: 'p' | 'quote'; spans: Span[] }
  | { kind: 'h'; level: number; spans: Span[] }
  | { kind: 'li'; ordered: boolean; marker: string; depth: number; spans: Span[] }
  | { kind: 'code'; text: string }
  | { kind: 'img'; src: string; alt: string }
  | { kind: 'hr' }
);

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Draft = DistOmit<Block, 'firstWord' | 'words'>;
type Style = Omit<Span, 'text'>;

const off = (n: Nodes) => n.position?.start.offset ?? 0;

type Inline = (n: PhrasingContent, style: Style, spans: Span[], images: Draft[]) => void;
const kids = (n: PhrasingContent) => ('children' in n ? (n.children as PhrasingContent[]) : []);
const INLINE: Partial<Record<PhrasingContent['type'], Inline>> = {
  text: (n, style, spans) => spans.push({ ...style, text: (n as { value: string }).value.replace(/\s+/g, ' ') }),
  emphasis: (n, style, spans, images) => inline(kids(n), { ...style, em: true }, spans, images),
  strong: (n, style, spans, images) => inline(kids(n), { ...style, strong: true }, spans, images),
  inlineCode: (n, style, spans) => spans.push({ ...style, code: true, text: (n as { value: string }).value }),
  link: (n, style, spans, images) => inline(kids(n), { ...style, href: (n as { url: string }).url }, spans, images),
  break: (_n, style, spans) => spans.push({ ...style, text: '\n' }),
  image: (n, _style, _spans, images) => {
    const img = n as { url: string; alt?: string | null };
    if (/^https?:\/\//.test(img.url)) images.push({ kind: 'img', src: img.url, alt: img.alt ?? '', start: off(n) });
  },
};

/** Anything else keeps its text: a node with children walks them, a node with a value (raw HTML) is read as written. */
function other(n: PhrasingContent, style: Style, spans: Span[], images: Draft[]): void {
  if ('children' in n) inline(kids(n), style, spans, images);
  else if ('value' in n) spans.push({ ...style, text: String(n.value) });
}

function inline(nodes: PhrasingContent[], style: Style, spans: Span[], images: Draft[]): void {
  for (const n of nodes) (INLINE[n.type] ?? other)(n, style, spans, images);
}

function trimSpans(spans: Span[]): Span[] {
  const out = spans.filter((s) => s.text !== '');
  if (out.length) {
    out[0] = { ...out[0], text: out[0].text.replace(/^ +/, '') };
    const l = out.length - 1;
    out[l] = { ...out[l], text: out[l].text.replace(/ +$/, '') };
  }
  return out.filter((s) => s.text !== '');
}

function phrasing(nodes: PhrasingContent[], at: number, make: (spans: Span[]) => Draft, out: Draft[]): void {
  const spans: Span[] = [];
  const images: Draft[] = [];
  inline(nodes, {}, spans, images);
  const t = trimSpans(spans);
  if (t.length) out.push({ ...make(t), start: at } as Draft);
  out.push(...images);
}

/** A list's items: each item's first paragraph carries its marker; nested blocks go one level in. */
function listBlocks(n: Extract<RootContent, { type: 'list' }>, out: Draft[], ctx: { quote?: boolean; depth: number }): void {
  n.children.forEach((item, i) => {
    const marker = n.ordered ? `${(n.start ?? 1) + i}.` : '•';
    item.children.forEach((child, k) => {
      if (child.type !== 'paragraph') return walk([child], out, { ...ctx, depth: ctx.depth + 1 });
      phrasing(child.children, off(child), (spans) => ({ kind: 'li', ordered: !!n.ordered, marker: k === 0 ? marker : '', depth: ctx.depth, spans, start: 0 }), out);
    });
  });
}

function walk(nodes: RootContent[], out: Draft[], ctx: { quote?: boolean; depth: number }): void {
  for (const n of nodes) {
    switch (n.type) {
      case 'paragraph':
        phrasing(n.children, off(n), (spans) => ({ kind: ctx.quote ? 'quote' : 'p', spans, start: 0 }), out);
        break;
      case 'heading':
        phrasing(n.children, off(n), (spans) => ({ kind: 'h', level: n.depth, spans, start: 0 }), out);
        break;
      case 'blockquote':
        walk(n.children, out, { ...ctx, quote: true });
        break;
      case 'list':
        listBlocks(n, out, ctx);
        break;
      case 'code':
        out.push({ kind: 'code', text: n.value, start: off(n) });
        break;
      case 'thematicBreak':
        out.push({ kind: 'hr', start: off(n) });
        break;
      case 'html':
        if (n.value.trim()) out.push({ kind: 'p', spans: [{ text: n.value }], start: off(n) });
        break;
      default:
        if ('children' in n) walk(n.children as RootContent[], out, ctx);
    }
  }
}

/** The first index in sorted xs whose value is at least v. */
function lowerBound(xs: number[], v: number): number {
  let lo = 0;
  let hi = xs.length;
  while (hi > lo) {
    const mid = (lo + hi) >> 1;
    if (v > xs[mid]) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type Article = { blocks: Block[]; words: number };

/** Everything the Reader and the voice need from an article, from one Markdown parse (6.7: blocks are derived once). */
export type Derived = Article & { v: number; sentences: Sentence[]; spoken: string };

/** The version of what deriveArticle writes; a stored file of another version is derived again. */
export const DERIVED_VERSION = 1;

export function deriveArticle(markdown: string): Derived {
  const tree = fromMarkdown(markdown);
  const drafts: Draft[] = [];
  walk(tree.children, drafts, { depth: 0 });
  const p = projectTree(markdown, tree);
  const wordOffsets = p.wordStarts.map((i) => p.offsets[i]);
  const starts = drafts.map((d) => lowerBound(wordOffsets, d.start));
  const blocks = drafts.map((d, i) => {
    const next = i + 1 < drafts.length ? starts[i + 1] : wordOffsets.length;
    return { ...d, firstWord: starts[i], words: Math.max(0, next - starts[i]) } as Block;
  });
  return { v: DERIVED_VERSION, blocks, words: wordOffsets.length, sentences: sentences(p), spoken: p.text };
}

export function articleBlocks(markdown: string): Article {
  const { blocks, words } = deriveArticle(markdown);
  return { blocks, words };
}

/** The block holding a word (the last block starting at or before it). */
export function blockOfWord(blocks: Block[], word: number): number {
  let lo = 0;
  let hi = blocks.length - 1;
  while (hi > lo) {
    const mid = (lo + hi + 1) >> 1;
    if (blocks[mid].firstWord <= word) lo = mid;
    else hi = mid - 1;
  }
  return Math.max(0, lo);
}
