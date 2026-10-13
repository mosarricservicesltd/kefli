// Fetching and parsing a page (mobile spec 5.4, section 9), for a share and for a pending parse: a desktop Chrome
// user agent and a mobile one on 403, a 20 s timeout over the headers and the whole body, a 5 MB cap counted as the
// body streams, no cookies (net/http.ts), and only text/html and application/xhtml+xml parse. The parse runs in the kefli-parser WebView (a port here), then contract 4.2's guard: not readerable and
// fewer than 120 spoken words is a failed parse. A network failure is "offline": the save waits and tries again.
// A page still turned away with 403 by both is loaded once in a browser engine (the render port, 8.2), since bot
// checks such as Cloudflare's tell Android's HTTP client from a browser; its rendered HTML takes the same parse. So is a
// page whose answer arrives as a bare 1xx. A PDF (contract 4.2, PDFs; flow decision 103), known by its type or its
// first bytes, has a larger cap; the parser WebView reads its text runs with pdf.js and pdfMarkdown lays them out here.
import { base64 } from '@scure/base';
import { normaliseMarkdown, pdfMarkdown, type PdfRuns } from '@kefli/protocol';
import { deriveArticle, type Derived } from '../reader/blocks';
import { open, TimedOut, TooLarge, type Opened } from '../net/http';

export const PAGE_MAX_BYTES = 5 * 1024 * 1024;
/**
 * RULED: a page rendered by the engine may be larger: the 5 MB cap bounds what Kefli downloads, and a rendered page's
 * size is mostly what its scripts built (a Substack comment thread came to 5.1 MB stripped), which the parse discards.
 */
export const RENDER_MAX_BYTES = 16 * 1024 * 1024;
export const PAGE_TIMEOUT_MS = 20_000;
export const GUARD_WORDS = 120;
/** RULED: reports and papers run larger than pages; 20 MB keeps the parse inside the phone's WebView memory. */
export const PDF_MAX_BYTES = 20 * 1024 * 1024;
/** A PDF with fewer spoken words than this has no text layer worth the name: a scan, or slides of pictures. */
export const PDF_MIN_WORDS = 20;
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
  /** A PDF's text runs, read by pdf.js in the parser WebView. */
  pdf?: (bodyBase64: string) => Promise<({ ok: true } & PdfRuns) | { ok: false; reason: string }>;
};

export type FailReason = 'http' | 'not_html' | 'too_large' | 'not_readable' | 'pdf_no_text' | 'pdf_locked';

export type PageOutcome =
  /** timedOut: the server or the network was too slow, against the 20 s deadline, rather than not there. */
  | { kind: 'offline'; timedOut?: true }
  | { kind: 'failed'; reason: FailReason; finalUrl: string }
  | { kind: 'parsed'; finalUrl: string; result: Extract<ParserResult, { ok: true }>; words: number; spoken: string; derived: Derived };

const PDF_TYPE = /^\s*application\/(?:x-)?pdf\b/i;
const HTML_TYPE = /^\s*(text\/html|application\/xhtml\+xml)\b/i;

/** A PDF by its declared type or, since servers often say application/octet-stream, by its first bytes. */
export function isPdf(contentType: string, bytes: Uint8Array): boolean {
  return PDF_TYPE.test(contentType) || (bytes.length > 4 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-');
}

/** Why a response can't be parsed, or null when it can. */
export function refusal(status: number, contentType: string, bytes: number, pdf = false): FailReason | null {
  if (status < 200 || status > 299) return 'http';
  if (pdf) return bytes > PDF_MAX_BYTES ? 'too_large' : null;
  if (!HTML_TYPE.test(contentType)) return 'not_html';
  if (bytes > PAGE_MAX_BYTES) return 'too_large';
  return null;
}

function get(p: PagePorts, url: string, ua: string): Promise<Opened> {
  const headers = { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9', 'Accept-Language': 'en-GB,en;q=0.9' };
  return open(p.fetch, url, { headers }, PAGE_TIMEOUT_MS);
}

/** The cap a body is read under: a page's 5 MB, or with the pdf port a PDF's 20 MB for a body not served as a page, which may be a PDF known only by its first bytes. */
export function capFor(p: Pick<PagePorts, 'pdf'>, contentType: string): number {
  return p.pdf && !HTML_TYPE.test(contentType) ? PDF_MAX_BYTES : PAGE_MAX_BYTES;
}

type Answer = { res: Response; bytes: Uint8Array } | Extract<PageOutcome, { kind: 'offline' | 'failed' }>;

/** The page as fetched: as desktop Chrome, then as a phone on 403; or why it can't be had. */
async function answer(p: PagePorts, url: string): Promise<Answer> {
  let o: Opened | null = null;
  try {
    o = await get(p, url, DESKTOP_UA);
    if (o.res.status === 403) {
      o.done();
      o = await get(p, url, MOBILE_UA);
    }
    const { res } = o;
    return { res, bytes: await o.read(capFor(p, res.headers.get('content-type') ?? '')) };
  } catch (e) {
    if (e instanceof TooLarge) return { kind: 'failed', reason: 'too_large', finalUrl: o?.res.url || url };
    return e instanceof TimedOut ? { kind: 'offline', timedOut: true } : { kind: 'offline' };
  }
}

export async function fetchPage(p: PagePorts, url: string): Promise<PageOutcome> {
  const a = await answer(p, url);
  if ('kind' in a) return a;
  const { res, bytes } = a;
  const finalUrl = res.url || url;
  // RULED: a 1xx is also loaded in the engine: Android's HTTP client hands back a 103 Early Hints as the final answer
  // on some HTTP/2 sites (Substack, behind Cloudflare), with an empty body
  if ((res.status === 403 || res.status < 200) && p.render) {
    const rendered = await rendered403(p, finalUrl);
    if (rendered) return rendered;
  }
  const contentType = res.headers.get('content-type') ?? '';
  const pdf = !!p.pdf && isPdf(contentType, bytes);
  const refused = refusal(res.status, contentType, bytes.length, pdf);
  if (refused) {
    // the status alone, never the address (7.1); release builds strip it
    console.log(`[kefli-page] ${JSON.stringify({ refused, status: res.status, type: contentType.split(';')[0], bytes: bytes.length })}`);
    return { kind: 'failed', reason: refused, finalUrl };
  }
  return pdf ? parsePdf(p, bytes, finalUrl) : parseHtml(p, bytes, contentType, finalUrl);
}

const PDF_FAILURES: Record<string, FailReason> = { pdf_locked: 'pdf_locked', pdf_too_long: 'too_large' };

/** A PDF's runs laid out as Markdown (contract 4.2, PDFs): the same text, derivation and blob as a page's after this. */
export async function parsePdf(p: Pick<PagePorts, 'pdf'>, bytes: Uint8Array, finalUrl: string): Promise<Exclude<PageOutcome, { kind: 'offline' }>> {
  const read = await p.pdf!(base64.encode(bytes)).catch(() => ({ ok: false as const, reason: 'error' }));
  if (!read.ok) return { kind: 'failed', reason: PDF_FAILURES[read.reason] ?? 'not_readable', finalUrl };
  const article = pdfMarkdown(read);
  const markdown = normaliseMarkdown(article.markdown);
  const derived = deriveArticle(markdown);
  if (derived.words < PDF_MIN_WORDS) return { kind: 'failed', reason: 'pdf_no_text', finalUrl };
  const result = { ok: true as const, title: article.title, byline: article.byline, site: null, lang: null, hero: null, canonical: null, readerable: true, markdown };
  return { kind: 'parsed', finalUrl, result, words: derived.words, spoken: derived.spoken, derived };
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
