// Where a word is on the page and which word is at a place (mobile spec 5.6, 6.7): the Reader lays out at the
// stored word before it shows, keeps a word still across a size change, and reads its position from the scroll.
// Pure, over the blocks' measured places (y and height inside the prose, which starts at proseY in the content).
import { blockOfWord, type Block } from './blocks';

export type Place = { y: number; h: number };

/** The scroll offset that puts word at `at` pixels below the top of the view, or null until every block is measured. */
export function scrollYForWord(blocks: Block[], places: (Place | undefined)[], proseY: number, word: number, at: number): number | null {
  if (!blocks.length) return 0;
  for (let i = 0; blocks.length > i; i++) if (!places[i]) return null;
  const i = blockOfWord(blocks, word);
  const b = blocks[i];
  const p = places[i]!;
  const frac = b.words ? Math.min(1, Math.max(0, (word - b.firstWord) / b.words)) : 0;
  return Math.max(0, proseY + p.y + frac * p.h - at);
}

/**
 * The word `at` pixels below the top of the view when scrolled to scrollY. At the bottom of the page it is the last
 * word, so an article read to its end counts as read.
 */
export function wordAtScroll(blocks: Block[], places: (Place | undefined)[], proseY: number, scrollY: number, at: number, view: { height: number; content: number; words: number }): number {
  if (view.words === 0) return 0;
  if (scrollY + view.height >= view.content - 4) return view.words - 1;
  const y = scrollY + at - proseY;
  let i = -1;
  for (let k = 0; blocks.length > k; k++) if (places[k] && y >= places[k]!.y) i = k;
  if (i < 0) return 0;
  const p = places[i]!;
  const b = blocks[i];
  return Math.min(view.words - 1, b.firstWord + Math.floor(Math.max(0, Math.min(1, (y - p.y) / Math.max(1, p.h))) * b.words));
}
