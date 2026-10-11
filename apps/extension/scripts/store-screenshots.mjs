// The Chrome Web Store screenshots (docs/store/chrome-web-store.md): the signed-off extension mockup's browser window
// alone, drawn at 1024 x 640 and scaled by 1.25 to exactly 1280 x 800, in headless Chrome.
//
//   node apps/extension/scripts/store-screenshots.mjs [outdir]     default docs/store/screenshots
//
// It runs in the same headless Chrome as chrome.mjs, which loads the dev build, so build that first
// (npm run build -w @kefli/extension).
//
// Before each capture the address bar loses the mockup's real publication for an example address, and the placeholder
// QR becomes a real one, drawn as src/options.ts draws it, carrying an offer of the real shape with throwaway values.
// Each shot gets a fresh browser.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from '../../../tools/design-qa/cdp.mjs';
import { open } from './chrome.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..', '..');
const outdir = process.argv[2] ?? path.join(repo, 'docs', 'store', 'screenshots');
const { toQR } = createRequire(import.meta.url)('toqr');

/** In the listing's order: the mockup state and the file it becomes. */
const SHOTS = [['saved', '1-saved'], ['menu', '2-save-link'], ['o-pair', '3-connect'], ['o-connected', '4-connected']];
const W = 1024, H = 640, SCALE = 1.25;

const offer = JSON.stringify({ v: 1, device_pubkey: randomBytes(32).toString('hex'), relay: 'wss://relay.kefli.app', nonce: randomBytes(16).toString('hex'), expires: 1791700000, label: 'Chrome on a Windows PC' });
const m = toQR(offer), n = Math.sqrt(m.length);
let d = '';
for (let i = 0; i < m.length; i++) if (m[i]) d += `M${i % n} ${Math.floor(i / n)}h1v1h-1z`;
const QR = `<svg width="168" height="168" viewBox="-1 -1 ${n + 2} ${n + 2}" fill="currentColor" shape-rendering="crispEdges" role="img" aria-label="Connection code"><path d="${d}"/></svg>`;

const FILL = `
  html,body{margin:0!important;padding:0!important;overflow:hidden!important;background:#fff}
  .panel,.notes,.note,#jnote{display:none!important}
  .wrap{padding:0!important;margin:0!important;max-width:none!important;display:block!important}
  .win{width:${W}px!important;max-width:none!important;height:${H}px!important;margin:0!important;border-radius:0!important;box-shadow:none!important;border:0!important}
  .page{height:${H - 84}px!important}`;
const SWAPS = [['theatlantic.com/ideas/archive/2026/09/reading-long-things', 'example.com/essays/reading-long-things'], ['theatlantic.com', 'example.com']];

mkdirSync(outdir, { recursive: true });
for (const [jump, name] of SHOTS) {
  const x = await open({ w: W, h: H });
  const p = await x.page(`file://${repo}/docs/design/mockups/extension.html#${jump}`);
  await p.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: SCALE, mobile: false });
  await sleep(1500);
  const ev = async (e) => (await p.send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })).result.value;
  await ev(`(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(FILL)}; document.head.append(s); return true; })()`);
  await sleep(2500); // the cover draws itself in under a second; let every animation settle
  const left = await ev(`(() => {
    const swaps = ${JSON.stringify(SWAPS)};
    const w = document.createTreeWalker(document.getElementById('win'), NodeFilter.SHOW_TEXT);
    for (let t; (t = w.nextNode());) for (const [a, b] of swaps) t.nodeValue = t.nodeValue.split(a).join(b);
    for (const el of document.querySelectorAll('#win [title]')) for (const [a, b] of swaps) el.title = el.title.split(a).join(b);
    const qr = document.querySelector('#win .qr svg');
    if (qr) qr.outerHTML = ${JSON.stringify(QR)};
    // the options page at this scale overflows a little: no scrollbar, and its end in view rather than a line cut in half
    const o = document.querySelector('#win .opts');
    if (o) { o.style.scrollbarWidth = 'none'; o.scrollTop = o.scrollHeight; }
    return document.getElementById('win').innerText.match(/atlantic/gi);
  })()`);
  if (left) throw new Error(`${jump}: ${left.join(', ')} still on the page`);
  if (p.errors.length) throw new Error(`${jump}: ${p.errors.join('; ')}`);
  await sleep(200);
  const shot = await p.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
  const file = path.join(outdir, `${name}.png`);
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  console.log(file);
  // close() kills Chrome without waiting for it to exit; a moment's pause keeps the next shot's Chrome from meeting it
  p.ws.close();
  x.close();
  await sleep(1500);
}
process.exit(0);
