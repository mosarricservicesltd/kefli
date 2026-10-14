// What the capture script hands the background (contract 4.4's save request, before the HTML is encrypted), and the
// rules it applies that need no page: the address, the guard and the cap.
import { countWords } from '../../../packages/protocol/src/projection';

export interface Captured {
  url: string;
  canonical: string | null;
  hero: string | null;
  title: string | null;
  site: string | null;
  byline: string | null;
  lang: string | null;
  /** Readability's content HTML, or null when capture failed, the guard tripped or it was over 2 MB. */
  html: string | null;
}

/** contract 4.2: a parse that isn't readerable and has fewer spoken words than this counts as failed. */
export const GUARD_WORDS = 120;
/** contract 4.4: content HTML over this many bytes as UTF-8 is not sent. */
export const HTML_MAX_BYTES = 2_097_152;

/** Whether an address can be saved at all: a web page's, http or https (contract 4.3; decision 100). */
export function isWebAddress(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** A save made from a link or a page where no script can run: the address alone (extension spec 4). */
export function linkOnly(url: string): Captured {
  return { url, canonical: null, hero: null, title: null, site: null, byline: null, lang: null, html: null };
}

/** What kefliParse returns (shared/vendor/parser-runner.js). */
export type Parsed = { ok: boolean; title?: string | null; byline?: string | null; site?: string | null; lang?: string | null; hero?: string | null; canonical?: string | null; readerable?: boolean; markdown?: string };

/** The page's address without its fragment (contract 4.4). */
export function pageUrl(href: string): string {
  const u = new URL(href);
  u.hash = '';
  return u.href;
}

/** The guard (contract 4.2): readerable, or at least 120 spoken words; and the HTML no more than 2 MB as UTF-8. */
export function keepHtml(parsed: Parsed, content: string | undefined): string | null {
  if (!parsed.ok || !content || !parsed.markdown) return null;
  if (!parsed.readerable && countWords(parsed.markdown) < GUARD_WORDS) return null;
  return new TextEncoder().encode(content).length <= HTML_MAX_BYTES ? content : null;
}

/** A page's size, measured without reading it: its elements, the serialised length, and its widest parent. */
export interface PageSize {
  elements: number;
  chars: number;
  /** The most element children any one element has, and that element's text length. */
  children: number;
  text: number;
}

/**
 * Past any of these a page isn't read: the save goes without its text, which the phone fetches itself, as it does for a
 * page whose text is over 2 MB. Reading runs on the page's own thread, so while it runs the tab is frozen. The HTML
 * standard's single page (337,128 elements, 15.8 million characters) froze its tab for two minutes, and its text was
 * over 2 MB anyway. The longest real pages tried are well inside: World War II on Wikipedia (17,011 elements, 2.5
 * million characters, read in 2.8 s) and War and Peace on Project Gutenberg (14,900 and 3.8 million, 7.9 s). widest is
 * Turndown's cost: it joins a parent's children into a string it reads back at every child, so a parent with many
 * children costs about children × text / 2 characters copied, and 20,000 one-line paragraphs in one article (25,000
 * million) took 54 s. Pride and Prejudice, all 2,165 of its paragraphs in the body, costs 778 million and reads in 2.5 s.
 */
export const PAGE_LIMITS = { elements: 200_000, chars: 8_000_000, widest: 4_000_000_000 } as const;

/** Whether reading the page would freeze its tab for too long, by PAGE_LIMITS. */
export function tooLargeToRead(s: PageSize): boolean {
  return s.elements > PAGE_LIMITS.elements || s.chars > PAGE_LIMITS.chars || (s.children * s.text) / 2 > PAGE_LIMITS.widest;
}

/** A page's address and title, with nothing read from it: a page too large to read (PAGE_LIMITS). */
export function unread(url: string, title: string): Captured {
  return { ...linkOnly(url), title: title.trim() || null };
}

/** p's value, or fallback once ms have passed without one; p itself goes on, and whatever it gives later is let go. */
export function orAfter<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((done) => (timer = setTimeout(() => done(fallback), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
