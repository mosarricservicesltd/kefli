// The capture content script (contract 4.2 and 4.4, extension spec 4), injected under activeTab after parser.js, the
// phone's own parser bundle. It reads the live page as the fixtures read a fetched one: the serialised document through
// kefliParse (canonical, hero and readerable first, then Readability and the Markdown) and kefliArticle (Readability's
// content HTML, which is what a save sends). The guard and the 2 MB cap are applied here, so only what a save needs
// crosses to the background, and a page too large to read in good time isn't read at all (captured.ts, PAGE_LIMITS).
// The background calls window.kefliCapture() once both files are in.
import { keepHtml, pageUrl, tooLargeToRead, unread, type Captured, type PageSize, type Parsed } from './captured';
declare function kefliParse(bodyBase64: string, contentType: string, url: string): Parsed;
declare function kefliArticle(bodyBase64: string, contentType: string, url: string): { ok: boolean; content?: string };

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The base Readability resolves against, as parser-runner's documentFor sets it: the page's own <base>, made absolute,
 * when that is an http or https address, else the page's address. A <base href="javascript:…"> would otherwise have made
 * every fragment link a javascript: link in the text sent to the phone.
 */
export function baseOf(doc: Pick<Document, 'querySelector'>, url: string): string {
  const own = doc.querySelector('base[href]')?.getAttribute('href')?.trim();
  try {
    const base = own ? new URL(own, url) : null;
    return base && (base.protocol === 'http:' || base.protocol === 'https:') ? base.href : url;
  } catch {
    return url;
  }
}

/**
 * The page's elements, its text and its widest parent, without serialising or reading it (PAGE_LIMITS). The widest
 * parent's count is kept as it is found: childElementCount counts the children each time it is asked.
 */
function sizeOf(doc: Document): Omit<PageSize, 'chars'> {
  let elements = 0;
  let widest: Element | null = null;
  let children = 0;
  for (const el of doc.getElementsByTagName('*')) {
    elements++;
    const n = el.childElementCount;
    if (n > children) [widest, children] = [el, n];
  }
  let readable = doc.body?.textContent?.length ?? 0;
  for (const el of doc.body?.querySelectorAll('script, style') ?? []) readable -= el.textContent?.length ?? 0;
  return { elements, readable, children, text: widest?.textContent?.length ?? 0 };
}

/**
 * Fragment-only links made absolute, as Readability makes them wherever the document's address isn't its base: in the
 * phone's WebView and in the fixture generator, both on about:blank. On the live page the two are equal and Readability
 * leaves "#note-1" as it is, so without this the same page would read differently here than on the phone, and differently
 * again with a fragment in the address. base is the document's base, the page's own <base> when it has one, as
 * Readability's is.
 */
export function absoluteFragments(content: string, base: string): string {
  if (!/href=["']?#/.test(content)) return content;
  const doc = new DOMParser().parseFromString(content, 'text/html');
  for (const a of doc.querySelectorAll('a[href^="#"]')) a.setAttribute('href', new URL(a.getAttribute('href')!, base).href);
  return doc.body.innerHTML;
}

export function capture(doc: Document, href: string): Captured {
  const url = pageUrl(href);
  // a page too large to read in good time is saved unread, before anything is serialised (PAGE_LIMITS)
  const size = sizeOf(doc);
  if (tooLargeToRead({ ...size, chars: 0 })) return unread(url, doc.title);
  const serialised = '<!doctype html>' + doc.documentElement.outerHTML;
  if (tooLargeToRead({ ...size, chars: serialised.length })) return unread(url, doc.title);
  const body = base64(new TextEncoder().encode(serialised));
  const type = 'text/html; charset=utf-8';
  const parsed = kefliParse(body, type, url);
  const content = parsed.ok ? kefliArticle(body, type, url).content : undefined;
  const html = keepHtml(parsed, content === undefined ? undefined : absoluteFragments(content, baseOf(doc, url)));
  return {
    url,
    canonical: parsed.canonical ?? null,
    hero: parsed.hero ?? null,
    title: parsed.title ?? (doc.title.trim() || null),
    site: parsed.site ?? null,
    byline: parsed.byline ?? null,
    lang: parsed.lang ?? null,
    html,
  };
}

(globalThis as { kefliCapture?: () => Captured }).kefliCapture = () => capture(document, location.href);
