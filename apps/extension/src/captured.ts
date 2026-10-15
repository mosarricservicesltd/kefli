// What the capture script hands the background (contract 4.4's save request, before the HTML is encrypted), and the
// rules it applies that need no page: the address, the canonical, the guard and the cap.
import { ownCanonical, withoutUserInfo } from '../../../packages/protocol/src/normalise';
import { CANONICAL_MAX, SAVE_REQUEST_MAX_BYTES } from '../../../packages/protocol/src/pairing';
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

// built from a string: the code gate's parser reads a regex literal's escaped slashes as a comment, and lost the
// functions after it
const WEB_ADDRESS = new RegExp('^https?://', 'i');

/** Whether an address can be saved at all: a web page's, http or https (contract 4.3; decision 100). */
export function isWebAddress(url: string): boolean {
  return WEB_ADDRESS.test(url);
}

/**
 * A save made from a link or a page where no script can run: the address alone (extension spec 4), without any user
 * name and password in it, which no save keeps (contract 4.3, ruling 8).
 */
export function linkOnly(url: string): Captured {
  return { url: withoutUserInfo(url), canonical: null, hero: null, title: null, site: null, byline: null, lang: null, html: null };
}

/** What kefliParse returns (shared/vendor/parser-runner.js). */
export type Parsed = { ok: boolean; title?: string | null; byline?: string | null; site?: string | null; lang?: string | null; hero?: string | null; canonical?: string | null; readerable?: boolean; markdown?: string };

/** The page's address without its fragment (contract 4.4), or any user name and password (contract 4.3, ruling 8). */
export function pageUrl(href: string): string {
  const u = new URL(href);
  u.hash = '';
  return withoutUserInfo(u.href);
}

/**
 * The shortest address no save request can carry, in UTF-16 code units (contract 4.4, F39): a wrap has to stay under
 * SAVE_REQUEST_MAX_BYTES, NIP-44's two layers of base64 make it more than 16/9 of the rumor inside, and the rumor holds
 * the address at a byte or more a character. So 4,608 characters can never go, whatever the request leaves out.
 */
export const ADDRESS_UNWRAPPABLE = Math.ceil((SAVE_REQUEST_MAX_BYTES * 9) / 16);

/** Whether no save request could carry the address (ADDRESS_UNWRAPPABLE): its save is refused before anything is read. */
export function unwrappableAddress(url: string): boolean {
  return url.length >= ADDRESS_UNWRAPPABLE;
}

/**
 * The page's canonical as its save request carries it (contract 4.3): none past CANONICAL_MAX, measured as the parse read
 * it and left out before it is read, as the phone leaves out its own parse's and a browser's; then only one on the page's
 * own site, without a user name and password (ownCanonical), which is never longer, since the parse writes the address
 * as the browser does. Sent whole, the phone dropped it all the same, and the wrap left out the page's details first to
 * make room for it: one of 2,500 characters took the title, site, byline, language and picture with it.
 */
export function keptCanonical(url: string, canonical: string | null | undefined): string | null {
  return canonical != null && canonical.length <= CANONICAL_MAX ? ownCanonical(url, canonical) : null;
}

/**
 * How much of a page's Markdown the guard counts words in, when the page isn't readerable. 120 words of prose take a
 * kilobyte, of links several. The count runs in the page's own thread, and parses the Markdown before it counts. The
 * spoken projection after the parse is linear, so 3 MB of prose counts in a second, but the parse costs more than its
 * length: 3 MB of one list took 13 to 29 s, runs of * and _ 3 to 5 s for 16 KB and minutes for 64 KB, and list markers
 * nested on one line, each a list inside the one before, cost the most for their length. Turndown escapes a marker only
 * where a run of text starts with one, so a pre keeps them on a line that opens with a space and on every line after its
 * first, and 4 KB of them, 2,040 deep, took 0.6 to 1.7 s of the tab's time in Chrome 150, half as many 0.2 to 1 s, and
 * twice as many, counted whole, 4 to 6 s. A page whose opening 4 KB holds fewer than 120 words is taken as no article,
 * and the phone fetches it itself; a page of links still holds 150 or so there.
 */
export const GUARD_SAMPLE_CHARS = 4_096;

/** At least GUARD_WORDS spoken words in the Markdown's opening, or false when they can't be counted. */
function enoughWords(markdown: string): boolean {
  try {
    return countWords(markdown.slice(0, GUARD_SAMPLE_CHARS)) >= GUARD_WORDS;
  } catch {
    return false;
  }
}

/** The guard (contract 4.2): readerable, or at least 120 spoken words; and the HTML no more than 2 MB as UTF-8. */
export function keepHtml(parsed: Parsed, content: string | undefined): string | null {
  if (!parsed.ok || !content || !parsed.markdown) return null;
  if (!parsed.readerable && !enoughWords(parsed.markdown)) return null;
  return new TextEncoder().encode(content).length <= HTML_MAX_BYTES ? content : null;
}

/** A page's size, measured without reading it: its elements, its text, the serialised length and its widest parent. */
export interface PageSize {
  elements: number;
  /** The body's text, less what is inside its script and style elements, which reading drops at once. */
  readable: number;
  /** The serialised page; 0 until it is serialised. */
  chars: number;
  /** The most element children any one element has, and that element's text length. */
  children: number;
  text: number;
}

/**
 * Past any of these a page isn't read: the save goes without its text, which the phone fetches itself, as it does for a
 * page whose text is over 2 MB. Reading runs on the page's own thread, so while it runs the tab is frozen. The HTML
 * standard's single page (337,128 elements, 4.7 million characters of text) froze its tab for two minutes, and 10 MB of
 * article (9 million) for 52 s, each with its text over 2 MB anyway. The longest real pages tried are inside: World War
 * II on Wikipedia (17,011 elements, read in 2.8 s) and War and Peace on Project Gutenberg (3.6 million characters of
 * text, 7.9 s). Scripts, styles and attributes cost only their copying (10 million characters of an app's data around a
 * short article read in 2.6 s, a 20 MB attribute in 4.4 s), up to serialised in all, past which the copies alone would
 * take the tab's memory. widest is Turndown's cost: it joins a parent's children into a string it reads back at every
 * child, so a parent with many children costs about children × text / 2 characters copied, and 20,000 one-line
 * paragraphs in one article (25,000 million) took 54 s. Moby-Dick, its 2,846 paragraphs all in the body, costs 1,964
 * million.
 */
export const PAGE_LIMITS = { elements: 200_000, readable: 4_000_000, serialised: 32_000_000, widest: 4_000_000_000 } as const;

/** Whether reading the page would freeze its tab for too long, by PAGE_LIMITS. */
export function tooLargeToRead(s: PageSize): boolean {
  const L = PAGE_LIMITS;
  return s.elements > L.elements || s.readable > L.readable || s.chars > L.serialised || (s.children * s.text) / 2 > L.widest;
}

/** A page's address and title, with nothing read from it: a page too large to read (PAGE_LIMITS). */
export function unread(url: string, title: string): Captured {
  return { ...linkOnly(url), title: title.trim() || null };
}

/** A detail the parse found, or null for one it didn't. */
function found(detail: string | null | undefined): string | null {
  return detail ?? null;
}

/**
 * What a capture of the page at url keeps once the page is read (contract 4.3 and 4.4): the parse's details, its
 * canonical as keptCanonical keeps it (only from the page's own site, so a page can't send a save to another site's
 * address, and none longer than the phone keeps), the page's own title where the parse found none, and the HTML the
 * guard and the cap let through.
 */
export function fromParse(url: string, parsed: Parsed, pageTitle: string, html: string | null): Captured {
  return {
    url,
    canonical: keptCanonical(url, parsed.canonical),
    hero: found(parsed.hero),
    title: parsed.title ?? (pageTitle.trim() || null),
    site: found(parsed.site),
    byline: found(parsed.byline),
    lang: found(parsed.lang),
    html,
  };
}

/** p's value, or fallback once ms have passed without one; p itself goes on, and whatever it gives later is let go. */
export function orAfter<T, F>(p: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<F>((done) => (timer = setTimeout(() => done(fallback), ms)));
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}
