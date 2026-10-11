// The PDF fixtures (contract 4.2 and section 9; flow decision 103): PDFs printed by the pinned headless Chrome from
// pages written here, so every one is ours to publish; the text runs the vendored pdf.js reads from each
// (shared/vendor/pdf-runner.mjs); and what pdfMarkdown makes of them, with text_hash, the spoken projection and words.
//   npx tsx shared/fixtures/build-pdfs.ts            print the PDFs again, then read and lay them out
//   npx tsx shared/fixtures/build-pdfs.ts --layout   lay out the stored runs again, after a change to pdfMarkdown
//   npx tsx shared/fixtures/build-pdfs.ts --check    read the stored PDFs and fail if their runs differ (CI)
//   npx tsx shared/fixtures/build-pdfs.ts --browser  the same through the parser bundle's kefliRun in Chrome, with
//                                                    a KefliHost like the phone's, as its WebView reads them

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
// @ts-expect-error: plain ES modules without types
import { launch } from '../../tools/design-qa/cdp.mjs';
// @ts-expect-error: plain ES modules without types
import { kefliBundle } from '../vendor/build-parser-bundle.mjs';
import { countWords, normaliseMarkdown, pdfMarkdown, project, textHash, type PdfRuns } from '../../packages/protocol/src';
import { nodeCrypto } from '../../packages/protocol/src/node';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'pdfs');
const vendor = join(here, '..', 'vendor');

const words = (n: number, seed: number) => {
  const pool = ['reading', 'later', 'quietly', 'library', 'the', 'saved', 'article', 'phone', 'voice', 'offline', 'clean', 'text', 'and', 'every', 'page', 'keeps', 'its', 'place', 'when', 'you', 'return'];
  return Array.from({ length: n }, (_, i) => pool[(i * 7 + seed * 3) % pool.length]).join(' ');
};
const para = (n: number, seed: number) => `<p>${words(n, seed).replace(/^./, (c) => c.toUpperCase())}.</p>`;

const BASE = `<style>body{font:11pt/1.45 serif;margin:0} h1{font-size:22pt} h2{font-size:15pt} p{margin:0 0 9pt}</style>`;

type Doc = { id: string; html: string; pdf: Record<string, unknown> };

const DOCS: Doc[] = [
  {
    id: 'report-one-column',
    html: `<html lang="en"><title>Open Standards for Reading: a report</title>${BASE}<body><h1>Open Standards for Reading</h1><p>A report on keeping saved articles readable.</p>
<h2>1. Summary</h2>${para(90, 1)}<p>Large organi&shy;sations often hold docu&shy;ments in formats that only one firm’s soft&shy;ware can open, which makes the efficient office a difficult place to share files.</p>${para(80, 2)}
<h2>2. Principles</h2><ul><li>Text should outlive the service that saved it.</li><li>Every device should read the same words.</li><li>Listening should follow reading.</li></ul>${para(120, 3)}
<table border="1"><tr><th>Format</th><th>2024</th><th>2025</th></tr><tr><td>A</td><td>12</td><td>14</td></tr><tr><td>B</td><td>3</td><td>9</td></tr><tr><td>C</td><td>40</td><td>41</td></tr></table>
<h2>3. Findings</h2>${[4, 5, 6, 7, 8, 9].map((s) => para(110, s)).join('')}<h2>4. Next steps</h2>${para(60, 10)}</body></html>`,
    pdf: {
      displayHeaderFooter: true, marginTop: 0.8, marginBottom: 0.8,
      headerTemplate: '<div style="font-size:8pt;width:100%;text-align:center">Open Standards for Reading — draft</div>',
      footerTemplate: '<div style="font-size:8pt;width:100%;text-align:center">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    },
  },
  {
    id: 'paper-two-column',
    html: `<html lang="en"><style>body{font:10pt/1.4 serif;margin:0} .cols{columns:2;column-gap:18pt} h1{font-size:18pt;text-align:center} h2{font-size:12pt} p{margin:0 0 6pt;text-align:justify} sup{font-size:6pt}
.fn{font-size:8pt;border-top:1px solid #000;margin-top:12pt} .eq{text-align:center}</style><body><h1>Listening to Saved Articles</h1>
<p style="text-align:center">A. Reader<sup>∗</sup> and B. Listener<sup>†</sup></p><div class="cols"><h2>Abstract</h2>${para(70, 11)}<h2>1 Introduction</h2>${para(90, 12)}<p>Prior work<sup>1</sup> reads pages aloud with a server voice [3], while ours stays on the phone [4].</p>${para(80, 13)}
<h2>2 Method</h2>${para(100, 14)}<p class="eq">E = m × c² + ∑ x<sub>i</sub> (1)</p>${para(90, 15)}
<svg width="200" height="120" style="display:block;margin:auto"><text x="10" y="20" font-size="8">Words</text><text x="150" y="110" font-size="8">Time</text><text x="60" y="60" font-size="8">0.5</text><text x="60" y="90" font-size="8">0.1</text><line x1="20" y1="100" x2="190" y2="100" stroke="black"/></svg>
<p>Figure 1: Words spoken over time.</p><h2>3 Results</h2>${para(120, 16)}${para(100, 17)}<h2>References</h2><p>[1] A. Author. Reading on the move. Journal of Reading, 2019.</p><p>[2] B. Author and C. Author. Voices for everyone. In Proceedings of the Listening Workshop, pages 1–9, 2021.</p><p>[3] D. Author. Server voices. 2022.</p><p>[4] E. Author. On-device speech. 2024.</p></div>
<div class="fn"><p>∗Equal contribution.</p><p>†Work done while reading.</p></div></body></html>`,
    pdf: { marginTop: 0.7, marginBottom: 0.7 },
  },
  {
    id: 'slides-landscape',
    html: `<html lang="en"><style>body{font:20pt/1.3 sans-serif;margin:0} section{height:6.9in;page-break-after:always;padding:0.4in} h1{font-size:40pt} h2{font-size:30pt}</style><body>
<section><h1>Kefli in five slides</h1><p>A read-it-later app that reads to you.</p></section>
<section><h2>Save anything</h2><ul><li>Share a link from any app on the phone.</li><li>Press the shortcut in the browser.</li><li>The text arrives clean and stays offline.</li></ul></section>
<section><h2>Read it clean</h2><ul><li>One column, your size, your colours.</li><li>Images where the writer put them.</li><li>Your place kept on every device.</li></ul></section>
<section><h2>Listen to it</h2><ul><li>The phone's own voice reads the article aloud.</li><li>Each word lights up as it is spoken.</li><li>It keeps going with the screen locked.</li></ul></section>
<section><h2>Keep it</h2><ul><li>Your library lives under your own key.</li><li>Copies are mirrored away from our servers.</li><li>It outlives the service that saved it.</li></ul></section></body></html>`,
    pdf: { landscape: true },
  },
  {
    id: 'scan-image-only',
    html: `<html><body style="margin:0"><canvas id="c" width="800" height="1000"></canvas><script>const x=document.getElementById('c').getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,800,1000);x.fillStyle='#000';x.font='22px serif';
for(let i=0;i<30;i++)x.fillText('This page was scanned, so its words are only a picture of words. Line '+(i+1)+'.',40,60+i*30);</script></body></html>`,
    pdf: {},
  },
  {
    id: 'essay-across-columns',
    html: `<html lang="en"><style>body{font:10.5pt/1.45 serif;margin:0} .cols{columns:2;column-gap:20pt} h1{font-size:20pt} p{margin:0;text-indent:14pt} p.first{text-indent:0}</style><body><h1>A Short Essay on Keeping Things</h1>
<div class="cols">${[18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29].map((s, i) => `<p class="${i === 0 ? 'first' : ''}">${words(130, s).replace(/^./, (c) => c.toUpperCase())} and so it ends here${i}.</p>`).join('')}</div></body></html>`,
    pdf: {},
  },
];

type Expected = { id: string; ok: boolean; reason?: string; title?: string | null; byline?: string | null; markdown?: string; text_hash?: string; spoken?: string; words?: number };

async function readRuns(bytes: Uint8Array) {
  const g = globalThis as { pdfjsWorker?: unknown };
  g.pdfjsWorker ??= await import(pathToFileURL(join(vendor, 'pdfjs-4.10.38', 'pdf.worker.min.mjs')).href);
  const pdfjs = await import(pathToFileURL(join(vendor, 'pdfjs-4.10.38', 'pdf.min.mjs')).href);
  const { pdfRuns } = await import(pathToFileURL(join(vendor, 'pdf-runner.mjs')).href);
  return pdfRuns(pdfjs, bytes) as Promise<({ ok: true } & PdfRuns) | { ok: false; reason: string }>;
}

/** What the phone makes of the runs (mobile page.ts): fewer than 20 spoken words is a PDF with no text to read. */
function layout(id: string, runs: ({ ok: true } & PdfRuns) | { ok: false; reason: string }): Expected {
  if (!runs.ok) return { id, ok: false, reason: runs.reason };
  const a = pdfMarkdown(runs);
  const md = normaliseMarkdown(a.markdown);
  const n = countWords(md);
  if (n < 20) return { id, ok: false, reason: 'pdf_no_text' };
  return { id, ok: true, title: a.title, byline: a.byline, markdown: md, text_hash: textHash(md, nodeCrypto), spoken: project(md).text, words: n };
}

const runsPath = (id: string) => join(dir, `${id}.runs.json`);

function writeExpected(chrome: string, out: Expected[]) {
  writeFileSync(join(dir, 'expected.json'), `${JSON.stringify({ chrome, pdfjs: '4.10.38', pdfs: out }, null, 1)}\n`);
  for (const e of out) console.log(`${e.id}: ${e.ok ? `${e.words} words, “${e.title}”` : e.reason}`);
}

async function print(): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const chrome = await launch();
  try {
    const version = (await (await fetch(`http://127.0.0.1:${chrome.port}/json/version`)).json()).Browser;
    for (const d of DOCS) {
      await chrome.send('Page.navigate', { url: `data:text/html;charset=utf-8;base64,${Buffer.from(d.html).toString('base64')}` });
      await new Promise((r) => setTimeout(r, 600));
      const { data } = await chrome.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: false, ...d.pdf });
      writeFileSync(join(dir, `${d.id}.pdf`), Buffer.from(data, 'base64'));
    }
    return version;
  } finally {
    chrome.close();
    chrome.proc.kill();
  }
}

/** A KefliHost as Parser.kt gives the WebView: the job's input, its output, and the PDF modules by name. */
function hostShim(assets: Record<string, string>, input: string): string {
  return `window.KEFLI_OUT = null; window.KefliHost = {
    input: () => ${JSON.stringify(input)},
    output: (id, json) => { window.KEFLI_OUT = json; },
    asset: (name) => (${JSON.stringify(assets)})[name] ?? '',
  };`;
}

async function browserRuns(): Promise<string[]> {
  const read = (p: string) => readFileSync(join(vendor, p), 'utf8');
  const assets = { 'pdf.min.mjs': read('pdfjs-4.10.38/pdf.min.mjs'), 'pdf.worker.min.mjs': read('pdfjs-4.10.38/pdf.worker.min.mjs'), 'pdf-runner.mjs': read('pdf-runner.mjs') };
  const chrome = await launch();
  const bad: string[] = [];
  try {
    await chrome.send('Page.navigate', { url: 'data:text/html;charset=utf-8,<!doctype html><title>parser</title>' });
    await new Promise((r) => setTimeout(r, 300));
    await chrome.eval(kefliBundle({ pdf: true }));
    for (const d of DOCS) {
      const body = readFileSync(join(dir, `${d.id}.pdf`)).toString('base64');
      await chrome.eval(hostShim(assets, JSON.stringify({ kind: 'pdf', body })));
      await chrome.eval(`kefliRun('job')`);
      let out: string | null = null;
      for (let i = 0; i < 200 && out === null; i++) {
        await new Promise((r) => setTimeout(r, 100));
        out = await chrome.eval('window.KEFLI_OUT');
      }
      const want = JSON.parse(readFileSync(runsPath(d.id), 'utf8'));
      if (out === null || !isDeepStrictEqual(JSON.parse(out), want)) bad.push(`${d.id}: ${out === null ? 'no answer' : out.slice(0, 120)}`);
    }
  } finally {
    chrome.close();
    chrome.proc.kill();
  }
  return bad;
}

async function main() {
  if (process.argv.includes('--browser')) {
    const bad = await browserRuns();
    if (bad.length) throw new Error(`the bundle in Chrome read differently:\n${bad.join('\n')}`);
    console.log(`${DOCS.length} PDFs read by the parser bundle in Chrome as stored`);
    return;
  }
  const prior = (() => {
    try {
      return JSON.parse(readFileSync(join(dir, 'expected.json'), 'utf8')) as { chrome: string };
    } catch {
      return { chrome: 'unknown' };
    }
  })();
  if (process.argv.includes('--layout')) {
    writeExpected(prior.chrome, DOCS.map((d) => layout(d.id, JSON.parse(readFileSync(runsPath(d.id), 'utf8')))));
    return;
  }
  if (process.argv.includes('--check')) {
    const bad: string[] = [];
    for (const d of DOCS) {
      const runs = await readRuns(new Uint8Array(readFileSync(join(dir, `${d.id}.pdf`))));
      if (!isDeepStrictEqual(runs, JSON.parse(readFileSync(runsPath(d.id), 'utf8')))) bad.push(d.id);
    }
    if (bad.length) throw new Error(`runs differ from the stored ones: ${bad.join(', ')}`);
    console.log(`${DOCS.length} PDFs read as stored`);
    return;
  }
  const chrome = await print();
  const out: Expected[] = [];
  for (const d of DOCS) {
    const runs = await readRuns(new Uint8Array(readFileSync(join(dir, `${d.id}.pdf`))));
    writeFileSync(runsPath(d.id), `${JSON.stringify(runs)}\n`);
    out.push(layout(d.id, runs));
  }
  writeExpected(chrome, out);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
