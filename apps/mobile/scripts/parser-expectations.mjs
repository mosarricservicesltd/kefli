// Runs the parser bundle on sample pages in desktop Chrome (headless, over the DevTools protocol) and writes
// src/gates/parse-expected.json: each page's bytes, Content-Type and address with Chrome's result. The phone's
// shelf-parser gate must give the same result, field for field: both are Blink, so the Markdown, and so
// text_hash, must match.
//   node apps/mobile/scripts/parser-expectations.mjs

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../../tools/design-qa/cdp.mjs';
import { shelfBundle } from '../../../shared/vendor/build-parser-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const para = [
  'A saved article waits quietly until there is time for it. When it opens on the train, the words are already on the phone, clean and easy to read.',
  'Nothing about the page needs the network once it has been saved. The text sits encrypted on the phone and on two servers that are not ours, so it outlives any one of them.',
  'Reading aloud uses the voice the phone already has. It starts at once, keeps going with the screen locked, and lights each word as it is spoken.',
  'The cover on each save is drawn from its address, so it looks the same on every device, today and after a restore on a new phone.',
  'There is no feed to scroll and nothing to follow. A shelf holds what its owner chose to keep, and it stays theirs if they leave.',
];
const body = (n) => Array.from({ length: n }, (_, i) => `<p>${para[i % para.length]} (${i + 1})</p>`).join('\n');

// windows-1252 bytes for the characters the sample uses.
const CP1252 = { '“': 0x93, '”': 0x94, '‘': 0x91, '’': 0x92, '—': 0x97, '€': 0x80 };
function cp1252(s) {
  return Buffer.from(Array.from(s, (c) => CP1252[c] ?? (c.charCodeAt(0) < 256 ? c.charCodeAt(0) : 0x3f)));
}

const PAGES = [
  {
    name: 'utf-8 article with canonical, og:image and structure',
    url: 'https://m.example.com/2026/10/quiet-reading/?utm_source=x#top',
    contentType: 'text/html; charset=utf-8',
    bytes: Buffer.from(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8">
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
    name: 'windows-1252 page labelled by meta only',
    url: 'https://legacy.example.org/essay.html',
    contentType: 'text/html',
    bytes: cp1252(`<html><head><meta http-equiv="Content-Type" content="text/html; charset=windows-1252"><title>An older page</title></head><body>
<div id="content"><h1>An older page</h1><p>“Quoted” words, ‘single’ quotes, a dash — and prices in £ and €, with é, ü and ñ.</p>${body(8)}</div></body></html>`),
  },
  {
    name: 'header charset wins over meta',
    url: 'https://mixed.example.net/a',
    contentType: 'text/html; charset=ISO-8859-1',
    bytes: cp1252(`<html><head><meta charset="utf-8"><title>Header wins</title></head><body><article><h1>Header wins</h1><p>Latin-1 bytes: café, über.</p>${body(7)}</article></body></html>`),
  },
  {
    name: 'page with its own relative base',
    url: 'https://docs.example.com/guide/start',
    contentType: 'text/html; charset=utf-8',
    bytes: Buffer.from(`<!doctype html><html><head><base href="/v2/"><title>Guide</title></head><body><main><h1>Guide</h1><p>See <a href="install">install</a> and <a href="/abs">an absolute path</a>.</p>${body(7)}</main></body></html>`),
  },
  {
    name: 'short page, not readerable',
    url: 'https://short.example.com/',
    contentType: 'text/html; charset=utf-8',
    bytes: Buffer.from('<!doctype html><html><head><title>Short</title></head><body><p>Just a line.</p></body></html>'),
  },
];

const chrome = await launch();
try {
  await chrome.eval(shelfBundle());
  const version = (await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).Browser;
  const out = [];
  for (const p of PAGES) {
    const b64 = p.bytes.toString('base64');
    const result = await chrome.eval(`shelfParse(${JSON.stringify(b64)}, ${JSON.stringify(p.contentType)}, ${JSON.stringify(p.url)})`);
    out.push({ name: p.name, url: p.url, contentType: p.contentType, body: b64, expect: result });
    console.log(`${p.name}: ok ${result.ok}, readerable ${result.readerable}, ${result.markdown?.length ?? 0} chars`);
  }
  const path = join(here, '..', 'src', 'gates', 'parse-expected.json');
  writeFileSync(path, `${JSON.stringify({ chrome: version, pages: out }, null, 1)}\n`);
  console.log(`wrote ${path} (${version})`);
} finally {
  chrome.close();
  chrome.proc.kill();
}
