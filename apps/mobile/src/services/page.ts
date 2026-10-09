// Fetching and parsing a page (mobile spec 5.4, section 9), for a share and for a pending parse: a desktop Chrome
// user agent and a mobile one on 403, a 20 s timeout, a 5 MB cap, and only text/html and application/xhtml+xml
// parse. The parse runs in the kefli-parser WebView (a port here), then contract 4.2's guard: not readerable and
// fewer than 120 spoken words is a failed parse. A network failure is "offline": the save waits and tries again.
// A page still turned away with 403 by both is loaded once in a browser engine (the render port, 8.2), since bot
// checks such as Cloudflare's tell Android's HTTP client from a browser; its rendered HTML takes the same parse. So is a
// page whose answer arrives as a bare 1xx.
import { base64 } from '@scure/base';
import { deriveArticle, type Derived } from '../reader/blocks';

export const PAGE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * RULED: a page rendered by the engine may be larger: the 5 MB cap bounds what Kefli downloads, and a rendered page's
 * size is mostly what its scripts built (a Substack comment thread came to 5.1 MB stripped), which the parse discards.
 */
export const RENDER_MAX_BYTES = 16 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 20_000;
export const GUARD_WORDS = 120;
export const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36';
export const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 17; Pixel 10a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Mobile Safari/537.36';

export type ParserResult =
  | { ok: true; title: string | null; byline: string | null; site: string | null; lang: string | null; hero: string | null; canonical: string | null; readerable: boolean; markdown: string }
  | { ok: false; reason: string };

export type PagePorts = {
  fetch: typeof fetch;
  parse: (bodyBase64: string, contentType: string, url: string) => Promise<ParserResult>;
  /** The page loaded in a browser engine: its rendered HTML and final address, or null. */
  render?: (url: string) => Promise<{ url: string; html: string } | null>;
};

export type FailReason = 'http' | 'not_html' | 'too_large' | 'not_readable';

export type PageOutcome =
  | { kind: 'offline' }
  | { kind: 'failed'; reason: FailReason; finalUrl: string }
  | { kind: 'parsed'; finalUrl: string; result: Extract<ParserResult, { ok: true }>; words: number; spoken: string; derived: Derived };

/** Why a response can't be parsed, or null when it can. */
export function refusal(status: number, contentType: string, bytes: number): FailReason | null {
  if (status < 200 || status > 299) return 'http';
  if (!/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) return 'not_html';
  if (bytes > PAGE_MAX_BYTES) return 'too_large';
  return null;
}

async function get(p: PagePorts, url: string, ua: string): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PAGE_TIMEOUT_MS);
  try {
    return await p.fetch(url, { signal: ctl.signal, headers: { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'en-GB,en;q=0.9' } });
  } finally {
    clearTimeout(timer);
  }
}

type Answer = { res: Response; bytes: Uint8Array } | { tooLarge: string } | null;

/** The page as fetched: as desktop Chrome, then as a phone on 403; null when the network failed. */
async function answer(p: PagePorts, url: string): Promise<Answer> {
  try {
    let res = await get(p, url, DESKTOP_UA);
    if (res.status === 403) res = await get(p, url, MOBILE_UA);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > PAGE_MAX_BYTES) return { tooLarge: res.url || url };
    return { res, bytes: new Uint8Array(await res.arrayBuffer()) };
  } catch {
    return null;
  }
}

export async function fetchPage(p: PagePorts, url: string): Promise<PageOutcome> {
  const a = await answer(p, url);
  if (!a) return { kind: 'offline' };
  if ('tooLarge' in a) return { kind: 'failed', reason: 'too_large', finalUrl: a.tooLarge };
  const { res, bytes } = a;
  const finalUrl = res.url || url;
  // RULED: a 1xx is also loaded in the engine: Android's HTTP client hands back a 103 Early Hints as the final answer
  // on some HTTP/2 sites (Substack, behind Cloudflare), with an empty body
  if ((res.status === 403 || res.status < 200) && p.render) {
    const rendered = await rendered403(p, finalUrl);
    if (rendered) return rendered;
  }
  const contentType = res.headers.get('content-type') ?? '';
  const refused = refusal(res.status, contentType, bytes.length);
  if (refused) {
    // the status alone, never the address (7.1); release builds strip it
    console.log(`[kefli-page] ${JSON.stringify({ refused, status: res.status, type: contentType.split(';')[0], bytes: bytes.length })}`);
    return { kind: 'failed', reason: refused, finalUrl };
  }
  return parseHtml(p, bytes, contentType, finalUrl);
}

/** A page turned away from the fetch, loaded in a browser engine and parsed as fetched HTML; null when that failed too. */
async function rendered403(p: PagePorts, url: string): Promise<Exclude<PageOutcome, { kind: 'offline' }> | null> {
  const r = await p.render!(url).catch(() => null);
  if (!r) return null;
  const bytes = new TextEncoder().encode(r.html);
  if (bytes.length > RENDER_MAX_BYTES) return { kind: 'failed', reason: 'too_large', finalUrl: r.url };
  return parseHtml(p, bytes, 'text/html; charset=utf-8', r.url);
}

/** The parse and contract 4.2's guard, for a fetched page and for a browser's own HTML (4.7). */
export async function parseHtml(p: Pick<PagePorts, 'parse'>, bytes: Uint8Array, contentType: string, finalUrl: string): Promise<Exclude<PageOutcome, { kind: 'offline' }>> {
  const result = await p.parse(base64.encode(bytes), contentType, finalUrl).catch((): ParserResult => ({ ok: false, reason: 'error' }));
  if (!result.ok) return { kind: 'failed', reason: 'not_readable', finalUrl };
  const derived = deriveArticle(result.markdown);
  if (!result.readerable && derived.words < GUARD_WORDS) return { kind: 'failed', reason: 'not_readable', finalUrl };
  return { kind: 'parsed', finalUrl, result, words: derived.words, spoken: derived.spoken, derived };
}
