// The capture content script (contract 4.2 and 4.4, extension spec 4), injected under activeTab after parser.js, the
// phone's own parser bundle. It reads the live page as the fixtures read a fetched one: the serialised document through
// kefliParse (canonical, hero and readerable first, then Readability and the Markdown) and kefliArticle (Readability's
// content HTML, which is what a save sends). The guard and the 2 MB cap are applied here, so only what a save needs
// crosses to the background. The background calls window.kefliCapture() once both files are in.
import { keepHtml, pageUrl, type Captured, type Parsed } from './captured';
declare function kefliParse(bodyBase64: string, contentType: string, url: string): Parsed;
declare function kefliArticle(bodyBase64: string, contentType: string, url: string): { ok: boolean; content?: string };

function base64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** The base Readability resolves against: the page's own <base>, made absolute, else its address (parser-runner). */
function baseOf(doc: Document, url: string): string {
  const own = doc.querySelector('base[href]')?.getAttribute('href');
  try {
    return own ? new URL(own, url).href : url;
  } catch {
    return url;
  }
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
  const body = base64(new TextEncoder().encode('<!doctype html>' + doc.documentElement.outerHTML));
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
