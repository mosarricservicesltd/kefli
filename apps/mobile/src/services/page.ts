// Fetching and parsing a page (mobile spec 5.4, section 9), for a share and for a pending parse: a desktop Chrome
// user agent and a mobile one on 403, a 20 s timeout, a 5 MB cap, and only text/html and application/xhtml+xml
// parse. The parse runs in the shelf-parser WebView (a port here), then contract 4.2's guard: not readerable and
// fewer than 120 spoken words is a failed parse. A network failure is "offline": the save waits and tries again.
import { base64 } from '@scure/base';
import { deriveArticle, type Derived } from '../reader/blocks';

export const PAGE_MAX_BYTES = 5 * 1024 * 1024;
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

export async function fetchPage(p: PagePorts, url: string): Promise<PageOutcome> {
  let res: Response;
  let bytes: Uint8Array;
  try {
    res = await get(p, url, DESKTOP_UA);
    if (res.status === 403) res = await get(p, url, MOBILE_UA);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > PAGE_MAX_BYTES) return { kind: 'failed', reason: 'too_large', finalUrl: res.url || url };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { kind: 'offline' };
  }
  const finalUrl = res.url || url;
  const contentType = res.headers.get('content-type') ?? '';
  const refused = refusal(res.status, contentType, bytes.length);
  if (refused) return { kind: 'failed', reason: refused, finalUrl };
  const result = await p.parse(base64.encode(bytes), contentType, finalUrl).catch((): ParserResult => ({ ok: false, reason: 'error' }));
  if (!result.ok) return { kind: 'failed', reason: 'not_readable', finalUrl };
  const derived = deriveArticle(result.markdown);
  if (!result.readerable && derived.words < GUARD_WORDS) return { kind: 'failed', reason: 'not_readable', finalUrl };
  return { kind: 'parsed', finalUrl, result, words: derived.words, spoken: derived.spoken, derived };
}
