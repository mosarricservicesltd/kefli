// The extension's capture against the twenty page fixtures (extension spec 8): each page is served at its own address
// in headless Chrome, the built parser.js and capture.js run on the rendered page as they do under activeTab, and the
// captured HTML goes through the phone's kefliMarkdown, whose text_hash must equal the fixture's. This is the proof that
// a browser save converts on the phone to the text the phone would get from its own fetch.
//
//   node apps/extension/build.mjs dev && node apps/extension/scripts/fixtures.mjs
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch, sleep } from '../../../tools/design-qa/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..', '..');
const dist = path.join(here, '..', 'dist', 'dev-chrome');
const pages = JSON.parse(readFileSync(path.join(repo, 'shared', 'fixtures', 'pages', 'pages.json'), 'utf8'));
const expected = Object.fromEntries(JSON.parse(readFileSync(path.join(repo, 'shared', 'fixtures', 'expected.json'), 'utf8')).pages.map((p) => [p.id, p]));
const parser = readFileSync(path.join(dist, 'parser.js'), 'utf8');
const capture = readFileSync(path.join(dist, 'capture.js'), 'utf8');
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const c = await launch();
await c.send('Page.enable');
await c.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
let serving = null;
c.on('Fetch.requestPaused', (e) => {
  const page = serving && e.request.url.split('#')[0] === serving.url.split('#')[0];
  if (page) {
    void c.send('Fetch.fulfillRequest', { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: serving.contentType }], body: serving.body });
  } else void c.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'BlockedByClient' });
});

// Each page is read once its load event has fired. A fixed 700 ms read the larger pages while Chrome was still parsing
// them whenever the machine was busy, so wikipedia-el (600 KB) differed from run to run; with Chrome's CPU slowed four
// or eight times, up to five Wikipedia pages lost the end of their text, or their title, byline and site. Every request
// but the page's own is refused at once, so a page's load follows its parse. Loads are kept by navigation, so one that
// fires before Page.navigate answers is still found, and a frame or an earlier page can't stand in for it.
const loads = new Set();
c.on('Page.lifecycleEvent', (e) => void (e.name === 'load' && loads.add(e.loaderId)));
await c.send('Page.setLifecycleEventsEnabled', { enabled: true });
const LOAD_MS = 60_000;

/** Opens url and waits for its load event: null once it has loaded, else why it didn't. */
async function open(url) {
  const { loaderId, errorText } = await c.send('Page.navigate', { url });
  if (errorText) return `didn't open: ${errorText}`;
  const until = Date.now() + LOAD_MS;
  // no loaderId: a navigation within the page already loaded, which fires no load of its own
  while (loaderId && !loads.has(loaderId)) {
    if (Date.now() > until) return `didn't load within ${LOAD_MS / 1000} s`;
    await sleep(10);
  }
  return null;
}

let bad = 0;
for (const p of pages) {
  const want = expected[p.id];
  serving = { url: p.url, contentType: p.contentType, body: readFileSync(path.join(repo, 'shared', 'fixtures', 'pages', `${p.id}.html`)).toString('base64') };
  const trouble = await open(p.url);
  if (trouble) {
    bad++;
    console.log(`✗ ${p.id}: ${trouble}`);
    continue;
  }
  await c.eval(parser);
  await c.eval(capture);
  const got = await c.eval(`(() => { const k = kefliCapture(); const md = k.html === null ? null : kefliMarkdown(k.html, k.url).markdown; return { ...k, html: k.html !== null, markdown: md }; })()`);
  const problems = [];
  if (want.ok && got.html) {
    if (sha(got.markdown) !== want.text_hash) problems.push(`text_hash ${sha(got.markdown).slice(0, 12)} ≠ ${want.text_hash.slice(0, 12)}`);
  } else if (want.ok !== got.html && !(want.ok && !got.html && !want.readerable && Number(want.words) < 120)) problems.push(`html ${got.html ? 'sent' : 'not sent'}, fixture ok=${want.ok}`);
  for (const k of ['canonical', 'hero', 'title', 'byline', 'site', 'lang']) if (want.ok && (got[k] ?? null) !== (want[k] ?? null)) problems.push(`${k} ${JSON.stringify(got[k])} ≠ ${JSON.stringify(want[k])}`);
  if (problems.length) bad++;
  console.log(`${problems.length ? '✗' : '✓'} ${p.id}${problems.length ? `: ${problems.join('; ')}` : ''}`);
}
c.close();
c.proc.kill();
console.log(bad ? `${bad} of ${pages.length} differ` : `all ${pages.length} pages match`);
process.exit(bad ? 1 : 0);
