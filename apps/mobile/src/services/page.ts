// Fetching and parsing a page (mobile spec 5.4, section 9), for a share and for a pending parse: a desktop Chrome
// user agent and a mobile one on 403, a 20 s timeout over the headers and the whole body, a 5 MB cap counted as the
// body streams, no cookies, redirects followed by hand, ten at most and each to a public address (net/http.ts), and
// only text/html and application/xhtml+xml parse. The parse runs in the kefli-parser WebView (a port here), then
// contract 4.2's guard: not readerable and fewer than 120 spoken words is a failed parse. A network failure is
// "offline": the save waits and tries again, until the pending queue has waited as long as a page may take to answer
// (ANSWER_WAIT_SECONDS); a redirect the phone won't follow, or plain http the build refuses, fails, the save keeping
// its link. No address is asked for or handed back with a user name and password in it.
// A page still turned away with 403 by both is loaded once in a browser engine (the render port, 8.2), since bot
// checks such as Cloudflare's tell Android's HTTP client from a browser; its rendered HTML takes the same parse. So is a
// page whose answer arrives as a bare 1xx. A PDF (contract 4.2, PDFs; flow decision 103), known by its type or its
// first bytes, has a larger cap; the parser WebView reads its text runs with pdf.js and pdfMarkdown lays them out here.
// Whatever a page holds, a parse ends as parsed or failed and never throws: a share's save and the pending parses
// behind it go on (a failed parse keeps the save's link, without text).
import { normaliseMarkdown, ownCanonical, pdfMarkdown, urlParts, withoutUserInfo, type PdfRuns } from '@kefli/protocol';
import { deriveArticle, type Derived } from '../reader/blocks';
import { Blocked, fromFiles, open, overHttps, strayed, TimedOut, TooLarge, WEB_HOPS, type Opened } from '../net/http';

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
/**
 * The most text a save keeps, as UTF-8: its blob, 16 bytes more, is what the default mirrors are chosen to take
 * (contract 5, at least 5 MB) and under the operator's 8 MB, so the text is backed up like any other. A page's
 * Markdown can outgrow its HTML (500 nested lists indent every line inside them), and longer text would be refused
 * at every upload. War and Peace whole is about 3.3 MB.
 */
export const TEXT_MAX_BYTES = 5 * 1024 * 1024 - 16;
/**
 * The most text runs a PDF's read may hand over, and their characters: 2,500 runs a page over the 400 pages read, as a
 * file setting a glyph at a time gives, and twice what TEXT_MAX_BYTES holds. pdf-runner.mjs stops at the same.
 */
export const PDF_MAX_RUNS = 1_000_000;
export const PDF_MAX_CHARS = 10_000_000;
/**
 * The longest a parse's own fields are kept, in UTF-16 code units, so a save's item fits its 16 KB event (contract
 * 3.3) whatever a page claims: a title, byline or site past its length is cut at it; a language tag, a canonical
 * or hero address past its length is left out (a cut address is a wrong one), and a final address past it after
 * redirects gives way to the address asked for, as a failed parse keeps it.
 */
export const FIELD_MAX = { title: 300, byline: 200, site: 100, lang: 35, url: 2048 } as const;
export const DESKTOP_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36';
export const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 17; Pixel 10a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Mobile Safari/537.36';

export type ParserResult =
  | { ok: true; title: string | null; byline: string | null; site: string | null; lang: string | null; hero: string | null; canonical: string | null; readerable: boolean; markdown: string }
  | { ok: false; reason: string };

/** A page loaded in a browser engine: its rendered HTML and final address, or that the page was too large to hand over. */
export type RenderAnswer = { url: string; html: string } | { url: string; tooLarge: true };

export type PagePorts = {
  fetch: typeof fetch;
  parse: (bodyBase64: string, contentType: string, url: string) => Promise<ParserResult>;
  /** The page loaded in a browser engine, or null when that failed. */
  render?: (url: string) => Promise<RenderAnswer | null>;
  /** A PDF's text runs, read by pdf.js in the parser WebView. */
  pdf?: (bodyBase64: string) => Promise<({ ok: true } & PdfRuns) | { ok: false; reason: string }>;
};

/** The render port's answer for what the native renderer gave (kefli-parser's Rendered). */
export function renderAnswer(r: { ok: true; url: string; html: string } | { ok: false; reason: string; url?: string }): RenderAnswer | null {
  if (r.ok) return { url: r.url, html: r.html };
  return r.reason === 'too_large' && r.url ? { url: r.url, tooLarge: true } : null;
}

/**
 * The parser WebView's word (kefli-parser) for a renderer the system killed (for memory, often with Kefli in the
 * background) or one that never loaded the bundle: nothing about the page is known, so it waits and is tried again as
 * a page that timed out is (PARSER_GONE). The inbox reads a browser's capture the same way (inbox.ts fromBrowser).
 */
export const RENDERER_GONE = 'renderer_gone';

/**
 * Why a save's page can't be read. offline: it never answered for as long as a save waits for its page (pending.ts,
 * ANSWER_WAIT_SECONDS), which only the pending queue judges; a fetch never ends with it.
 */
export type FailReason = 'http' | 'not_html' | 'too_large' | 'not_readable' | 'pdf_no_text' | 'pdf_locked' | 'offline';

export type PageOutcome =
  /**
   * timedOut: the server or the network was too slow, against the 20 s deadline, rather than not there. refused:
   * nothing answered with a page, but something refused the connection (REFUSED), as an address asked for over https
   * alone meets when its site has none; such a save waits like any other, until the rule below fails it. answered: the
   * page came whole, but the parser's renderer had gone before it read it (PARSER_GONE), so the save waits as a page
   * that timed out does, and is no page that never answers (ANSWER_WAIT_SECONDS). busy: the server answered that it
   * can't serve the page now (unavailable), and the save waits as for a page that doesn't answer.
   */
  | { kind: 'offline'; timedOut?: true; refused?: true; answered?: true; busy?: true }
  | { kind: 'failed'; reason: FailReason; finalUrl: string }
  | { kind: 'parsed'; finalUrl: string; result: Extract<ParserResult, { ok: true }>; words: number; spoken: string; derived: Derived };

type Settled = Exclude<PageOutcome, { kind: 'offline' }>;
/** A parse that read the page. */
type ParserOk = Extract<ParserResult, { ok: true }>;
/** A layout and derivation that may throw (guarded). */
type Derivation = () => Settled;
/** The page as fetched, or why it can't be had (answer). */
type Answer = { res: Response; url: string; bytes: Uint8Array } | Extract<PageOutcome, { kind: 'offline' | 'failed' }>;

/**
 * A page whose parse met RENDERER_GONE. RULED: its page answered, so its save waits at any age, the 14-day rule being
 * for a page that never answers (ANSWER_WAIT_SECONDS); read as one, a save past its 14 days whose page came whole was
 * failed for good whenever the system killed the parser's renderer, as it does for memory with Kefli in the
 * background, where pending parses run.
 */
const PARSER_GONE: PageOutcome = { kind: 'offline', answered: true };

const PDF_TYPE = /^\s*application\/(?:x-)?pdf\b/i;
const HTML_TYPE = /^\s*(text\/html|application\/xhtml\+xml)\b/i;
/** How far into a body a PDF's header is looked for: readers, pdf.js among them, find it anywhere in the first kilobyte. */
const PDF_HEADER_WITHIN = 1024;
const PDF_HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

/** Whether bytes holds %PDF- starting at an offset below within. */
function pdfHeader(bytes: Uint8Array, within: number): boolean {
  const last = Math.min(bytes.length - PDF_HEADER.length, within - 1);
  for (let at = 0; at <= last; at++) {
    if (PDF_HEADER.every((b, k) => bytes[at + k] === b)) return true;
  }
  return false;
}

/**
 * A PDF by its declared type or, since servers often say application/octet-stream, by its first bytes: a header after
 * a byte order mark, a blank line or a few bytes of junk is still a PDF to every reader. A body served as a page is
 * a PDF only when it starts with the header, so a page that mentions one near its top is still read as a page.
 */
export function isPdf(contentType: string, bytes: Uint8Array): boolean {
  return PDF_TYPE.test(contentType) || pdfHeader(bytes, HTML_TYPE.test(contentType) ? 1 : PDF_HEADER_WITHIN);
}

/**
 * RULED: a status that says the page can't be had now, rather than that it never can be (RFC 9110 15.5.9 and 15.6,
 * RFC 6585 4): the server timing the request out, turning it away for asking too often, or failing, as a site down
 * behind its proxy answers. Each was a failed parse at once, so the save went out without its text, never fetched
 * again on this phone, and an import of a blog's links that met its limit part way failed every one after it. The save
 * waits as for a page that doesn't answer instead, three in a row stopping the run, and fails as one once it is 14 days
 * old (ANSWER_WAIT_SECONDS).
 */
export function unavailable(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

const BUSY: PageOutcome = { kind: 'offline', busy: true };

/** Why a response can't be parsed, or null when it can. */
export function refusal(status: number, contentType: string, bytes: number, pdf = false): FailReason | null {
  if (status < 200 || status > 299) return 'http';
  if (pdf) return bytes > PDF_MAX_BYTES ? 'too_large' : null;
  if (!HTML_TYPE.test(contentType)) return 'not_html';
  if (bytes > PAGE_MAX_BYTES) return 'too_large';
  return null;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** A slice's length, a multiple of three so only the last has padding; its 8,192 characters go in one fromCharCode call. */
const B64_SLICE = 3 * 2048;

/**
 * Bytes as padded base64 (RFC 4648), a slice at a time. @scure/base, without the built-in toBase64 Hermes may lack,
 * holds every 6-bit group of the input as a number in an array: 15 s and 1.4 GB in Node for a 20 MB PDF.
 */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const codes = new Array<number>(4 * (B64_SLICE / 3));
  for (let start = 0; start < bytes.length; start += B64_SLICE) {
    const end = Math.min(bytes.length, start + B64_SLICE);
    let n = 0;
    for (let i = start; i < end; i += 3) {
      const rest = end - i;
      const v = (bytes[i] << 16) | ((rest > 1 ? bytes[i + 1] : 0) << 8) | (rest > 2 ? bytes[i + 2] : 0);
      codes[n++] = B64.charCodeAt(v >> 18);
      codes[n++] = B64.charCodeAt((v >> 12) & 63);
      codes[n++] = rest > 1 ? B64.charCodeAt((v >> 6) & 63) : 61;
      codes[n++] = rest > 2 ? B64.charCodeAt(v & 63) : 61;
    }
    parts.push(String.fromCharCode.apply(null, n === codes.length ? codes : codes.slice(0, n)));
  }
  return parts.join('');
}

/** The page asked for as ua, its user agent sent again at each hop. */
function get(p: PagePorts, url: string, ua: string): Promise<Opened> {
  const headers = { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml,application/pdf;q=0.9', 'Accept-Language': 'en-GB,en;q=0.9' };
  return open(p.fetch, url, { headers }, PAGE_TIMEOUT_MS, WEB_HOPS);
}

/**
 * A type that names something other than a PDF: a page, a picture, a film, a sound, a font, plain text, an archive.
 * Built from a string: the code gate's parser misreads a regex literal's escaped slashes.
 */
const NOT_PDF = new RegExp(
  '^\\s*(?:(?:text|image|video|audio|font|model|multipart)/|application/(?:xhtml\\+xml|zip|gzip|x-tar|x-7z-compressed|vnd\\.rar)\\b)', 'i',
);

/**
 * The cap a body is read under: with the pdf port, a PDF's 20 MB for a body that may be one, known by its type or,
 * served as octet-stream, a download or no type at all, only by its first bytes; a page's 5 MB for a type that names
 * anything else, so a large picture or film fails on its declared length without being downloaded.
 */
export function capFor(p: Pick<PagePorts, 'pdf'>, contentType: string): number {
  return p.pdf && !NOT_PDF.test(contentType) ? PDF_MAX_BYTES : PAGE_MAX_BYTES;
}

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
    // RULED: a 1xx's body is never read. OkHttp hands back a 103 Early Hints as the answer and holds it to an empty
    // body, so the page's own bytes, once they have arrived, fail its read ("expected 0 bytes but received 1360"),
    // which was taken for the network: the share said it was offline and never reached the engine (fetchPage)
    if (res.status < 200) {
      o.done();
      return { res, url: o.url, bytes: new Uint8Array(0) };
    }
    return { res, url: o.url, bytes: await o.read(capFor(p, res.headers.get('content-type') ?? '')) };
  } catch (e) {
    return unfetched(e, o, url);
  }
}

/**
 * What OkHttp ends a connection with when something answered but not with https the phone can use: a TLS failure (a
 * certificate for another site or none, a handshake refused, plain http on port 443), a connection refused or reset,
 * or a firewall's reject of port 443 as host unreachable (RHEL's and CentOS's default, ICMP host-prohibited), which
 * Android's socket throws as NoRouteToHostException and OkHttp passes on unwrapped, as it rewords only a
 * ConnectException. A reset is "Connection reset" in OkHttp's words and "recvfrom failed: ECONNRESET" in a plain
 * socket's on Android. Read from the start of the message expo/fetch rejects with, "fetch failed: " and the Java
 * exception's own words, so a host's name, which a failure to resolve it quotes, can't pass for one. A name that
 * resolves nowhere is the network, or no site at all, as for any address, and so is a connection the phone's own
 * network dropped (Software caused connection abort); a refusal on a network that reaches nothing past a captive
 * portal is told apart by the network's own state (pending.ts). Built from a string: the code gate misreads regex
 * literals.
 */
const REFUSED = new RegExp(
  '^(?:fetch failed: )?(?:javax\\.net\\.ssl\\.|java\\.security\\.cert\\.|java\\.net\\.(?:ConnectException|NoRouteToHostException)\\b|java\\.net\\.SocketException: (?:Connection reset|\\w+ failed: ECONNRESET)\\b)',
);

/**
 * Why a page couldn't be had: too large, a redirect the phone won't follow or cleartext the build refuses (net/http
 * Blocked) fails it, the save keeping its link; anything else is the network, timed out or not there, or a connection
 * refused before anything answered (REFUSED).
 */
function unfetched(e: unknown, o: Opened | null, url: string): Extract<PageOutcome, { kind: 'offline' | 'failed' }> {
  if (e instanceof TooLarge) return { kind: 'failed', reason: 'too_large', finalUrl: o ? landedAt(o.url, url) : url };
  if (e instanceof Blocked) {
    // why alone, never the address (7.1)
    console.log(`[kefli-page] ${JSON.stringify({ refused: 'http', blocked: e.why })}`);
    return { kind: 'failed', reason: 'http', finalUrl: url };
  }
  if (e instanceof TimedOut) return { kind: 'offline', timedOut: true };
  return refusedFirst(e, o) ? { kind: 'offline', refused: true } : { kind: 'offline' };
}

/**
 * Whether e refused the connection (REFUSED) before anything answered: a site that answered once, before a 403 sent
 * the second try or before its body broke off, has its https.
 */
function refusedFirst(e: unknown, o: Opened | null): boolean {
  return !o && REFUSED.test(String((e as Error | undefined)?.message ?? ''));
}

/**
 * RULED: how long a save at a public http address waits for its page over https, from its saved_at. Release builds
 * allow no cleartext and such an address is asked for over https alone (net/http overHttps), so a site with no https
 * could never be read, and its save waited unpublished for good, never backed up and tried at every sync. Past this,
 * an https attempt refused before anything answered, with the phone on the internet, fails the save as a page that
 * can't be read: published without its text, its link kept. Under it the save waits as before, so a captive portal or
 * a TLS hiccup can't fail it; offline or timed out, it waits as any save does (ANSWER_WAIT_SECONDS). A share is new,
 * so the rule reaches only saves waiting in the pending queue.
 */
export const HTTPS_WAIT_SECONDS = 3 * 86_400;

/** Whether a save at url, saved at savedAt, whose page came to outcome has waited for https as long as it may. */
export function waitedForHttps(url: string, outcome: PageOutcome, savedAt: number, now: number): boolean {
  return outcome.kind === 'offline' && outcome.refused === true && overHttps(url) !== url && now - savedAt > HTTPS_WAIT_SECONDS;
}

/**
 * RULED: how long a save waits for a page that never answers, from its saved_at: a domain that has gone, or a port
 * that drops packets so every try times out. Such a save waited unpublished for good, never backed up and tried at
 * every sync. Past this, a try that times out or meets the network once more, with the phone on the internet, fails the
 * save as a page that can't be read: published without its text, its link kept (pending.ts). Under it the save waits as
 * before, so a slow network, a site down for a few days or a fortnight away from a signal can't fail it. A page that
 * came, its parser's renderer gone (PARSER_GONE), answered and waits at any age. A share is new, so the rule reaches
 * only saves waiting in the pending queue.
 */
export const ANSWER_WAIT_SECONDS = 14 * 86_400;

/** Whether a save saved at savedAt, whose page came to outcome, has waited as long as it may for its page to answer. */
export function waitedForAnswer(outcome: PageOutcome, savedAt: number, now: number): boolean {
  return outcome.kind === 'offline' && !outcome.answered && now - savedAt > ANSWER_WAIT_SECONDS;
}

/**
 * Where a fetch ended, without any user name and password (contract 4.3, ruling 8), unless that is past FIELD_MAX.url:
 * then the address asked for, which a failed parse keeps too. OkHttp sends no user info, but the address it reports a
 * fetch ended at keeps any a redirect named, and what a save keeps is what Original and Open in browser are given.
 */
function landedAt(at: string, url: string): string {
  return at.length > FIELD_MAX.url ? url : withoutUserInfo(at);
}

// built from a string: the code gate's parser reads a regex literal's escaped slashes as a comment
const WEB = new RegExp('^https?://', 'i');

/**
 * Whether url is one fetchPage asks for: http(s) only, since expo/fetch reads file: URLs from the phone's own storage,
 * and never its stand-in for them, http://filesystem.local, nor any host that only begins with it, which it serves
 * from the phone's files too, before any network (net/http fromFiles). RULED: the host is read as the protocol's URL
 * parser reads it, as OkHttp does, so no way of writing it (http:///filesystem.local/, a backslash, capitals, a
 * trailing dot, fullwidth letters) gets past. A share made on this phone can name either; every other save's address,
 * a browser's, an import's or another phone's, goes through isPublicWebUrl first (pending.ts pageOf), and every
 * redirect through net/http publicWeb.
 */
export function fetchable(url: string): boolean {
  const host = WEB.test(url) ? urlParts(url)?.hostname : undefined;
  return !!host && !fromFiles(url);
}

/** A page fetched and parsed: asked for, and every address its outcome names, without a user name and password. */
export async function fetchPage(p: PagePorts, asked: string): Promise<PageOutcome> {
  const url = withoutUserInfo(asked);
  if (!fetchable(url)) return { kind: 'failed', reason: 'http', finalUrl: url };
  const a = await answer(p, url);
  if ('kind' in a) return a;
  const finalUrl = landedAt(a.url, url);
  // RULED: a 1xx is also loaded in the engine: Android's HTTP client hands back a 103 Early Hints as the final answer
  // on some HTTP/2 sites (Substack, behind Cloudflare), with an empty body
  if ((a.res.status === 403 || a.res.status < 200) && p.render) {
    const rendered = await rendered403(p, finalUrl);
    if (rendered) return rendered;
  }
  return fromAnswer(p, a.res, a.bytes, finalUrl);
}

/** A fetched answer read as a PDF or a page, or refused for its status, type or size. */
function fromAnswer(p: PagePorts, res: Response, bytes: Uint8Array, finalUrl: string): Promise<PageOutcome> | PageOutcome {
  if (unavailable(res.status)) return BUSY;
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

const PDF_FAILURES: Record<string, FailReason> = { pdf_locked: 'pdf_locked', pdf_too_long: 'too_large', too_large: 'too_large' };

/** Whether a PDF's read is past what a save can hold (PDF_MAX_RUNS, PDF_MAX_CHARS), counted before any layout. */
function overRuns(read: PdfRuns): boolean {
  let runs = 0;
  let chars = 0;
  for (const page of read.pages) {
    runs += page.runs.length;
    for (const r of page.runs) chars += r[0].length;
    if (runs > PDF_MAX_RUNS || chars > PDF_MAX_CHARS) return true;
  }
  return false;
}

/** A PDF's runs laid out as Markdown (contract 4.2, PDFs): the same text, derivation and blob as a page's after this. */
export async function parsePdf(p: Pick<PagePorts, 'pdf'>, bytes: Uint8Array, finalUrl: string): Promise<PageOutcome> {
  const read = await p.pdf!(toBase64(bytes)).catch(() => ({ ok: false as const, reason: 'error' }));
  if (!read.ok && read.reason === RENDERER_GONE) return PARSER_GONE;
  if (!read.ok) return { kind: 'failed', reason: PDF_FAILURES[read.reason] ?? 'not_readable', finalUrl };
  if (overRuns(read)) return { kind: 'failed', reason: 'too_large', finalUrl };
  return guarded(finalUrl, () => {
    const article = pdfMarkdown(read);
    const markdown = normaliseMarkdown(article.markdown);
    if (tooLong(markdown)) return { kind: 'failed', reason: 'too_large', finalUrl };
    const derived = deriveArticle(markdown);
    if (derived.words < PDF_MIN_WORDS) return { kind: 'failed', reason: 'pdf_no_text', finalUrl };
    const result = fitted({ ok: true as const, title: article.title, byline: article.byline, site: null, lang: null, hero: null, canonical: null, readerable: true, markdown }, finalUrl);
    return { kind: 'parsed', finalUrl, result, words: derived.words, spoken: derived.spoken, derived };
  });
}

/**
 * A page turned away from the fetch, loaded in a browser engine and parsed as fetched HTML; null when that failed too.
 * The engine follows the page's redirects and scripts itself: one that ends on an address no hop could go to (7.1)
 * fails as a redirect the fetch won't follow does, so nothing from the phone's own network becomes a save's text.
 */
async function rendered403(p: PagePorts, url: string): Promise<PageOutcome | null> {
  const r = await p.render!(url).catch(() => null);
  if (!r) return null;
  if (strayed(WEB_HOPS, url, r.url)) return { kind: 'failed', reason: 'http', finalUrl: url };
  const at = landedAt(r.url, url);
  // UTF-8 is at least a byte a code unit: a page past the cap in code units is refused before it is encoded
  if ('tooLarge' in r || r.html.length > RENDER_MAX_BYTES) return { kind: 'failed', reason: 'too_large', finalUrl: at };
  const bytes = new TextEncoder().encode(r.html);
  if (bytes.length > RENDER_MAX_BYTES) return { kind: 'failed', reason: 'too_large', finalUrl: at };
  return parseHtml(p, bytes, 'text/html; charset=utf-8', at);
}

/** The parse and contract 4.2's guard, for a fetched page and for a browser's own HTML (4.7). */
export async function parseHtml(p: Pick<PagePorts, 'parse'>, bytes: Uint8Array, contentType: string, finalUrl: string): Promise<PageOutcome> {
  const result = await p.parse(toBase64(bytes), contentType, finalUrl).catch((): ParserResult => ({ ok: false, reason: 'error' }));
  if (!result.ok && result.reason === RENDERER_GONE) return PARSER_GONE;
  if (!result.ok) return { kind: 'failed', reason: result.reason === 'too_large' ? 'too_large' : 'not_readable', finalUrl };
  return parsedOutcome(result, finalUrl);
}

/**
 * A parse's Markdown taken as a save's text: refused past TEXT_MAX_BYTES, derived, put to contract 4.2's guard, its
 * fields fitted. Never throws, so a browser save's HTML (the inbox, 4.7) can take the same guards.
 */
export function parsedOutcome(result: Extract<ParserResult, { ok: true }>, finalUrl: string): Settled {
  if (tooLong(result.markdown)) return { kind: 'failed', reason: 'too_large', finalUrl };
  return guarded(finalUrl, () => {
    const derived = deriveArticle(result.markdown);
    if (!result.readerable && derived.words < GUARD_WORDS) return { kind: 'failed', reason: 'not_readable', finalUrl };
    return { kind: 'parsed', finalUrl, result: fitted(result, finalUrl), words: derived.words, spoken: derived.spoken, derived };
  });
}

/**
 * The layout and derivation, which run here on Hermes, as a parse that fails: text they can't take (a run of stacked
 * marks normalisation refuses, a depth or size past the engine's stack) leaves the save's link without text.
 */
function guarded(finalUrl: string, f: Derivation): Settled {
  try {
    return f();
  } catch (e) {
    console.log(`[kefli-page] ${JSON.stringify({ refused: 'not_readable', threw: (e as Error)?.name ?? 'unknown' })}`);
    return { kind: 'failed', reason: 'not_readable', finalUrl };
  }
}

/** Whether normalised Markdown is past TEXT_MAX_BYTES as UTF-8 (a code unit is one to three bytes, a pair four). */
function tooLong(markdown: string): boolean {
  if (markdown.length > TEXT_MAX_BYTES) return true;
  if (markdown.length * 3 <= TEXT_MAX_BYTES) return false;
  return new TextEncoder().encode(markdown).length > TEXT_MAX_BYTES;
}

/** s cut to at most max code units, never inside a surrogate pair, and trimmed; null stays null. */
function cut(s: string | null, max: number): string | null {
  if (s === null || s.length <= max) return s;
  const end = /[\uD800-\uDBFF]/.test(s[max - 1]) ? max - 1 : max;
  return s.slice(0, end).trimEnd() || null;
}

/** s if it is at most max code units, else null. */
const upTo = (s: string | null, max: number): string | null => (s !== null && s.length > max ? null : s);

/**
 * The page's canonical link as a save keeps it (contract 4.3): none past FIELD_MAX.url, left out before it is read,
 * since whatwg-url reads an address a code point at a time (a page's canonical of a megabyte took 8 s on Node, one of
 * 5 MB 51 s); then only from the page's own site, ruled on the address the page was read at, so a page at
 * amp.evil.example can't send its save to another site's address.
 */
function canonicalAt(canonical: string | null, finalUrl: string): string | null {
  return ownCanonical(finalUrl, upTo(canonical, FIELD_MAX.url));
}

/** The page's picture as a save keeps it: none past FIELD_MAX.url, and without a user name and password (ruling 8). */
function heroAt(hero: string | null): string | null {
  const kept = upTo(hero, FIELD_MAX.url);
  return kept && withoutUserInfo(kept);
}

/** A parse's fields fitted to FIELD_MAX, for the page read at finalUrl. */
function fitted(r: ParserOk, finalUrl: string): ParserOk {
  return {
    ...r,
    title: cut(r.title, FIELD_MAX.title), byline: cut(r.byline, FIELD_MAX.byline), site: cut(r.site, FIELD_MAX.site),
    lang: upTo(r.lang, FIELD_MAX.lang), hero: heroAt(r.hero), canonical: canonicalAt(r.canonical, finalUrl),
  };
}
