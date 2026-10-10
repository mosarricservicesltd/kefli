// The twenty fixture pages (contract section 9): saved HTML with what the canonical pipeline makes of each, run by
// desktop Chrome with the vendored parser bundle. Every platform must give the same Markdown and text_hash.
//   npx tsx shared/fixtures/build-pages.ts           rerun Chrome on the saved pages, rewriting expected.json
//   npx tsx shared/fixtures/build-pages.ts --fetch   download the real pages again first (they change upstream)
//   npx tsx shared/fixtures/build-pages.ts --spoken  recompute only the spoken projection and words, after a projection change
//
// Eight pages are written here for the awkward cases; twelve are real pages under open licences (pages/SOURCES.md).
// expected.json holds, per page: the parse's fields, Readability's content HTML, the normalised Markdown, its
// text_hash, the spoken projection and words, and the Chrome version that made them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error: plain ES modules without types
import { launch } from '../../tools/design-qa/cdp.mjs';
// @ts-expect-error: plain ES modules without types
import { kefliBundle } from '../vendor/build-parser-bundle.mjs';
import { countWords, project, textHash } from '../../packages/protocol/src';
import { nodeCrypto } from '../../packages/protocol/src/node';

const here = dirname(fileURLToPath(import.meta.url));
const pagesDir = join(here, 'pages');

type Page = { id: string; url: string; contentType: string; licence: string; source?: string };

// The real pages, fetched as bytes with a desktop Chrome user agent.
const REAL: Omit<Page, 'contentType'>[] = [
  { id: 'wikipedia-en', url: 'https://en.wikipedia.org/wiki/Bookmark_(digital)', licence: 'CC BY-SA 4.0' },
  { id: 'wikipedia-de', url: 'https://de.wikipedia.org/wiki/Lesezeichen_(Internet)', licence: 'CC BY-SA 4.0' },
  { id: 'wikipedia-fr', url: 'https://fr.wikipedia.org/wiki/Marque-page', licence: 'CC BY-SA 4.0' },
  { id: 'wikipedia-ja', url: 'https://ja.wikipedia.org/wiki/ソーシャルブックマーク', licence: 'CC BY-SA 4.0' },
  { id: 'wikipedia-ar', url: 'https://ar.wikipedia.org/wiki/علامة_مرجعية', licence: 'CC BY-SA 4.0' },
  { id: 'wikipedia-ru', url: 'https://ru.wikipedia.org/wiki/Социальные_закладки', licence: 'CC BY-SA 4.0' },
  { id: 'wikipedia-el', url: 'https://el.wikipedia.org/wiki/Ελληνική_γλώσσα', licence: 'CC BY-SA 4.0' },
  { id: 'wikipedia-zh', url: 'https://zh.wikipedia.org/wiki/书签', licence: 'CC BY-SA 4.0' },
  { id: 'wikipedia-simple', url: 'https://simple.wikipedia.org/wiki/World_Wide_Web', licence: 'CC BY-SA 4.0' },
  { id: 'wikisource-story', url: 'https://en.wikisource.org/wiki/The_Gift_of_the_Magi', licence: 'Public domain text; page CC BY-SA 4.0' },
  { id: 'mdn-article', url: 'https://developer.mozilla.org/en-US/docs/Web/HTML/Element/article', licence: 'CC BY-SA 2.5 (MDN contributors)' },
  { id: 'govuk-standards', url: 'https://www.gov.uk/government/publications/open-standards-principles/open-standards-principles', licence: 'Open Government Licence v3.0' },
];

const para = [
  'A saved article waits quietly until there is time for it. When it opens on the train, the words are already on the phone, clean and easy to read.',
  'Nothing about the page needs the network once it has been saved. The text sits encrypted on the phone and on two servers that are not ours, so it outlives any one of them.',
  'Reading aloud uses the voice the phone already has. It starts at once, keeps going with the screen locked, and lights each word as it is spoken.',
  'The cover on each save is drawn from its address, so it looks the same on every device, today and after a restore on a new phone.',
  'There is no feed to scroll and nothing to follow. A shelf holds what its owner chose to keep, and it stays theirs if they leave.',
];
const body = (n: number) => Array.from({ length: n }, (_, i) => `<p>${para[i % para.length]} (${i + 1})</p>`).join('\n');
const CP1252: Record<string, number> = { '“': 0x93, '”': 0x94, '‘': 0x91, '’': 0x92, '—': 0x97, '€': 0x80 };
const cp1252 = (s: string) => Buffer.from(Array.from(s, (c) => CP1252[c] ?? (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f)));
const utf8 = (s: string) => Buffer.from(s);

// The written pages: encodings, base and canonical rules, structures Turndown must keep, and honest failures.
const WRITTEN: (Page & { bytes: Buffer })[] = [
  {
    id: 'utf8-structure', url: 'https://m.example.com/2026/10/quiet-reading/?utm_source=x#top', contentType: 'text/html; charset=utf-8', licence: 'written for Shelf',
    bytes: utf8(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
<title>The quiet return of reading later — Example</title>
<link rel="alternate" href="/feed"><link rel="Canonical amphtml" href="/2026/10/quiet-reading/">
<meta property="og:image" content="/img/cover.jpg"><meta name="twitter:image" content="https://cdn.example.com/other.jpg">
<meta property="og:site_name" content="Example Weekly"></head><body>
<header><nav><a href="/">Home</a> · <a href="/news">News</a></nav></header>
<article><h1>The quiet return of reading later</h1><p class="byline">By Ana Pérez</p>
${body(6)}
<h2>What “later” means</h2><p>Café owners, naïve résumés and <em>emphasis</em>, <strong>strong words</strong>, and <a href="/more">a relative link</a>.</p>
<ul><li>One thing</li><li>Another thing!</li></ul>
<pre><code>let saved = true;</code></pre>
${body(4)}
</article><footer>© Example</footer></body></html>`),
  },
  {
    id: 'windows-1252-meta', url: 'https://legacy.example.org/essay.html', contentType: 'text/html', licence: 'written for Shelf',
    bytes: cp1252(`<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>An older page</title></head><body>
<div id="content"><h1>An older page</h1><p>“Quoted” words, ‘single’ quotes, a dash — and prices in £ and €, with é, ü and ñ.</p>${body(8)}</div></body></html>`),
  },
  {
    id: 'header-charset-wins', url: 'https://mixed.example.net/a', contentType: 'text/html; charset=ISO-8859-1', licence: 'written for Shelf',
    bytes: cp1252(`<html><head><meta charset="utf-8"><title>Header wins</title></head><body><article><h1>Header wins</h1><p>Latin-1 bytes: café, über.</p>${body(7)}</article></body></html>`),
  },
  {
    id: 'relative-base', url: 'https://docs.example.com/guide/start', contentType: 'text/html; charset=utf-8', licence: 'written for Shelf',
    bytes: utf8(`<!doctype html><html><head><base href="/v2/"><title>Guide</title></head><body><main><h1>Guide</h1><p>See <a href="install">install</a> and <a href="/abs">an absolute path</a>.</p>${body(7)}</main></body></html>`),
  },
  {
    id: 'short-not-readerable', url: 'https://short.example.com/', contentType: 'text/html; charset=utf-8', licence: 'written for Shelf',
    bytes: utf8('<!doctype html><html><head><title>Short</title></head><body><p>Just a line.</p></body></html>'),
  },
  {
    id: 'tables-figures-lazy', url: 'https://figures.example.com/2026/charts', contentType: 'text/html; charset=utf-8', licence: 'written for Shelf',
    bytes: utf8(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Reading by the numbers</title></head><body><article>
<h1>Reading by the numbers</h1>${body(3)}
<figure><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/chart.png" alt="A chart of minutes read"><figcaption>Minutes read a week, <em>2025</em>.</figcaption></figure>
<table><thead><tr><th>Month</th><th>Saves</th><th>Read</th></tr></thead><tbody><tr><td>January</td><td>41</td><td>30</td></tr><tr><td>February</td><td>38</td><td>35</td></tr></tbody></table>
<picture><source srcset="/img/wide.webp 2x" type="image/webp"><img src="/img/wide.jpg" alt="A shelf of books"></picture>
${body(4)}</article></body></html>`),
  },
  {
    id: 'quotes-notes-lists', url: 'https://notes.example.org/essays/kept', contentType: 'text/html; charset=utf-8', licence: 'written for Shelf',
    bytes: utf8(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>What we keep</title></head><body><article>
<h1>What we keep</h1>${body(2)}
<blockquote><p>A library is not a luxury but one of the necessities of life.<sup id="r1"><a href="#n1">1</a></sup></p></blockquote>
<ol><li>Save it<ul><li>from the phone</li><li>from the laptop</li></ul></li><li>Read it, or listen</li></ol>
<dl><dt>Archive</dt><dd>Where finished saves go.</dd></dl>
<p>Inline <code>code</code>, a line<br>break, H<sub>2</sub>O and x<sup>2</sup>, and a <del>struck</del> word.</p>
${body(4)}
<hr><section class="footnotes"><ol><li id="n1">Henry Ward Beecher. <a href="#r1">↩</a></li></ol></section>
</article></body></html>`),
  },
  {
    id: 'script-only-app', url: 'https://app.example.com/read/42', contentType: 'text/html; charset=utf-8', licence: 'written for Shelf',
    bytes: utf8('<!doctype html><html><head><title>Loading…</title><script src="/static/app.js"></script></head><body><div id="root"></div><noscript>You need to enable JavaScript to run this app.</noscript></body></html>'),
  },
];

async function fetchReal(): Promise<Page[]> {
  const pages: Page[] = [];
  for (const r of REAL) {
    const res = await fetch(r.url, { headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0 Safari/537.36', 'Accept-Language': 'en-GB,en;q=0.9' } });
    if (!res.ok) throw new Error(`${r.url}: HTTP ${res.status}`);
    writeFileSync(join(pagesDir, `${r.id}.html`), Buffer.from(await res.arrayBuffer()));
    pages.push({ ...r, url: res.url || r.url, contentType: res.headers.get('content-type') ?? 'text/html', source: r.url });
    console.log(`fetched ${r.id}`);
  }
  return pages;
}

/** --spoken: the projection changed and the parse didn't, so only spoken and words are recomputed from the stored Markdown. */
function respeak() {
  const path = join(here, 'expected.json');
  const expected = JSON.parse(readFileSync(path, 'utf8')) as { chrome: string; pages: { id: string; markdown: string | null; spoken: string | null; words: number | null }[] };
  for (const p of expected.pages) {
    const before = p.words;
    p.spoken = typeof p.markdown !== 'string' ? null : project(p.markdown).text;
    p.words = typeof p.markdown !== 'string' ? null : countWords(p.markdown);
    if (before !== p.words) console.log(`${p.id}: ${before} → ${p.words} words`);
  }
  writeFileSync(path, `${JSON.stringify(expected, null, 1)}\n`);
  console.log('rewrote spoken and words in shared/fixtures/expected.json');
}

async function main() {
  if (process.argv.includes('--spoken')) return respeak();
  mkdirSync(pagesDir, { recursive: true });
  const indexPath = join(pagesDir, 'pages.json');
  const real: Page[] = process.argv.includes('--fetch') || !existsSync(indexPath)
    ? await fetchReal()
    : (JSON.parse(readFileSync(indexPath, 'utf8')) as Page[]).filter((p) => p.licence !== 'written for Shelf');
  for (const w of WRITTEN) writeFileSync(join(pagesDir, `${w.id}.html`), w.bytes);
  const pages: Page[] = [...WRITTEN.map(({ bytes: _b, ...p }) => p), ...real];
  writeFileSync(indexPath, `${JSON.stringify(pages, null, 1)}\n`);

  const chrome = await launch();
  try {
    await chrome.eval(kefliBundle());
    const version = (await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).Browser;
    const out = [];
    for (const p of pages) {
      const b64 = readFileSync(join(pagesDir, `${p.id}.html`)).toString('base64');
      const args = `${JSON.stringify(b64)}, ${JSON.stringify(p.contentType)}, ${JSON.stringify(p.url)}`;
      const result = await chrome.eval(`kefliParse(${args})`);
      const article = await chrome.eval(`kefliArticle(${args})`);
      const md: string | null = result.ok ? result.markdown : null;
      const expected = {
        id: p.id, ...result, content: article.ok ? article.content : null,
        text_hash: md === null ? null : textHash(md, nodeCrypto),
        spoken: md === null ? null : project(md).text,
        words: md === null ? null : countWords(md),
      };
      out.push(expected);
      console.log(`${p.id}: ok ${result.ok}, readerable ${result.readerable}, ${expected.words ?? 0} words`);
    }
    writeFileSync(join(here, 'expected.json'), `${JSON.stringify({ chrome: version, pages: out }, null, 1)}\n`);
    console.log(`wrote shared/fixtures/expected.json (${version})`);
  } finally {
    chrome.close();
    chrome.proc.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
