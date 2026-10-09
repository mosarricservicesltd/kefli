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
