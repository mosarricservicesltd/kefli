// Helpers for the negative-space icon study: read a candidate, recolour it, and render a page in headless Chrome.
// Uses the repo's CDP driver (tools/design-qa/cdp.mjs): Node 24 and Google Chrome, nothing to install.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, sleep } from '../../../../../tools/design-qa/cdp.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const STUDY = path.resolve(HERE, '..');

// Every candidate is drawn in these two colours only: the tile is the dark theme's background (Graphite) and
// the mark is paper. The light version swaps them for paper and ink. Holes are real transparency.
export const COL = { tile: '#111112', mark: '#F3F2EE', paper: '#F3F2EE', ink: '#17171A' };
// Android 13+ themed icons tint the monochrome layer: light and dark examples from a green wallpaper
export const THEMED = { light: { tile: '#D7E8DA', mark: '#1F3A28' }, dark: { tile: '#1F2B23', mark: '#B8DCC2' } };

export const FILES = ['mark.svg', 'cut-48.svg', 'cut-32.svg', 'cut-16.svg', 'glyph-24.svg'];

export function readCandidate(dir) {
  const abs = path.resolve(dir);
  const c = { id: path.basename(abs), dir: abs, files: {}, missing: [], meta: {} };
  for (const f of FILES) {
    const p = path.join(abs, f);
    if (fs.existsSync(p)) c.files[f] = withNs(fs.readFileSync(p, 'utf8'));
    else c.missing.push(f);
  }
  const m = path.join(abs, 'meta.json');
  if (fs.existsSync(m)) { try { c.meta = JSON.parse(fs.readFileSync(m, 'utf8')); } catch (e) { c.meta = { error: 'meta.json: ' + e.message }; } }
  return c;
}

function withNs(svg) {
  return /<svg[^>]*xmlns=/.test(svg) ? svg : svg.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
}

// swap the two study colours for any pair (case-insensitive)
export function recolour(svg, tile, mark) {
  return svg.replace(/#111112/gi, '@@T@@').replace(/#F3F2EE/gi, '@@M@@').replace(/@@T@@/g, tile).replace(/@@M@@/g, mark);
}
export const light = svg => recolour(svg, COL.paper, COL.ink);
export const dataUrl = svg => 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);

// The candidate's images as data URLs, in every colourway the sheets use. A missing cut falls back to the
// master drawn on a tile, flagged so the sheet can say so.
export function urls(c) {
  const mark = c.files['mark.svg'] || '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108"/>';
  const masterTile = n => {
    const inner = mark.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72" width="${n}" height="${n}"><rect x="18" y="18" width="72" height="72" rx="${72 * 7 / 32}" fill="${COL.tile}"/>${inner}</svg>`;
  };
  const cut = (f, n) => c.files[f] || masterTile(n);
  const u = {
    mark: dataUrl(mark),
    markLight: dataUrl(recolour(mark, COL.paper, COL.ink)),
    themedLight: dataUrl(recolour(mark, THEMED.light.tile, THEMED.light.mark)),
    themedDark: dataUrl(recolour(mark, THEMED.dark.tile, THEMED.dark.mark)),
    glyph: dataUrl(c.files['glyph-24.svg'] || recolour(mark, COL.tile, '#FFFFFF')),
    fallback: { 'cut-48.svg': !c.files['cut-48.svg'], 'cut-32.svg': !c.files['cut-32.svg'], 'cut-16.svg': !c.files['cut-16.svg'], 'glyph-24.svg': !c.files['glyph-24.svg'] },
  };
  for (const [f, n] of [['cut-48.svg', 48], ['cut-32.svg', 32], ['cut-16.svg', 16]]) {
    u[f] = dataUrl(cut(f, n));
    u[f + ':light'] = dataUrl(light(cut(f, n)));
  }
  return u;
}

// Shared page parts: the mask shapes (objectBoundingBox clip paths) and the in-page measuring code.
export const MASKS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <clipPath id="m-circle" clipPathUnits="objectBoundingBox"><circle cx=".5" cy=".5" r=".5"/></clipPath>
  <clipPath id="m-squircle" clipPathUnits="objectBoundingBox"><path d="${squircle()}"/></clipPath>
  <clipPath id="m-rounded" clipPathUnits="objectBoundingBox"><rect width="1" height="1" rx=".22" ry=".22"/></clipPath>
  <clipPath id="m-teardrop" clipPathUnits="objectBoundingBox"><path d="M.5 0A.5 .5 0 0 1 1 .5V.84A.16 .16 0 0 1 .84 1H.5A.5 .5 0 0 1 0 .5A.5 .5 0 0 1 .5 0Z"/></clipPath>
</defs></svg>`;

function squircle(n = 4, steps = 96) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / n), y = Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    pts.push(((x + 1) / 2).toFixed(4) + ' ' + ((y + 1) / 2).toFixed(4));
  }
  return 'M' + pts.join('L') + 'Z';
}

// <div> tile in a launcher mask: the 108 dp mark scaled so the central 72 dp fill the tile
export function tile(url, size, mask = 'squircle', bg = COL.tile) {
  return `<div class="tile" style="position:relative;flex:none;width:${size}px;height:${size}px;background:${bg};clip-path:url(#m-${mask})"><img alt="" src="${url}" style="position:absolute;display:block;max-width:none;width:${size * 1.5}px;height:${size * 1.5}px;left:${-size * 0.25}px;top:${-size * 0.25}px"></div>`;
}

// canvases filled in the page: data-src drawn at data-px, then shown data-zoom times larger with hard pixels
export function pix(url, px, zoom, bg = 'transparent') {
  return `<canvas class="pix" data-src="${url}" data-px="${px}" data-zoom="${zoom}" data-bg="${bg}" width="${px}" height="${px}" style="width:${px * zoom}px;height:${px * zoom}px"></canvas>`;
}

export const PAGE_JS = `
async function load(url){ const i = new Image(); i.src = url; await i.decode(); return i; }
async function drawPix(){
  for (const cv of document.querySelectorAll('canvas.pix')) {
    const n = +cv.dataset.px, g = cv.getContext('2d');
    if (cv.dataset.bg !== 'transparent') { g.fillStyle = cv.dataset.bg; g.fillRect(0, 0, n, n); }
    g.drawImage(await load(cv.dataset.src), 0, 0, n, n);
  }
}
const lum = (r, g, b) => (r + g + b) / 3;
// the master: ink box, centroid and reach from the canvas centre, in dp
async function markMetrics(url){
  const N = 1080, s = N / 108, cv = document.createElement('canvas'); cv.width = cv.height = N;
  const g = cv.getContext('2d'); g.drawImage(await load(url), 0, 0, N, N);
  const d = g.getImageData(0, 0, N, N).data;
  let sw = 0, sx = 0, sy = 0, maxR = 0, x0 = N, y0 = N, x1 = -1, y1 = -1, vis = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const a = d[(y * N + x) * 4 + 3] / 255; if (!a) continue;
    sw += a; sx += a * (x + .5); sy += a * (y + .5);
    if (a > .5) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (a > .12) { const r = Math.hypot(x + .5 - N / 2, y + .5 - N / 2); if (r > maxR) maxR = r; }
    if (x >= 18 * s && x < 90 * s && y >= 18 * s && y < 90 * s) vis += a;
  }
  const f = v => Math.round(v / s * 100) / 100;
  return { bbox: x1 < 0 ? null : { x: f(x0), y: f(y0), w: f(x1 - x0 + 1), h: f(y1 - y0 + 1) },
    centroid: sw ? { x: f(sx / sw), y: f(sy / sw) } : null,
    reach_dp: f(maxR), safe_circle_dp: 33, inside_safe: maxR / s <= 33.05,
    ink_of_viewport_pct: Math.round(vis / ((72 * s) ** 2) * 1000) / 10 };
}
// a tuned cut: of the pixels the mark touches inside the tile, how many are soft (partly mark, partly tile)
async function cutMetrics(url, n, tileHex, markHex){
  const cv = document.createElement('canvas'); cv.width = cv.height = n;
  // paint the tile colour first, so a transparent drawing (the glyph) is measured on its ground too
  const g = cv.getContext('2d'); g.fillStyle = tileHex; g.fillRect(0, 0, n, n); g.drawImage(await load(url), 0, 0, n, n);
  const d = g.getImageData(0, 0, n, n).data, hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const T = lum(...hex(tileHex)), M = lum(...hex(markHex));
  let touched = 0, soft = 0;
  for (let i = 0; i < n * n; i++) {
    if (d[i * 4 + 3] < 250) continue;
    const t = (lum(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) - T) / (M - T);
    if (t > .12) { touched++; if (t < .88) soft++; }
  }
  return { px: n, touched, soft, soft_pct: touched ? Math.round(soft / touched * 1000) / 10 : 0 };
}
`;

// Render an HTML page at the given width; returns the PNG buffer and whatever window.__out holds when done.
export async function render(html, width = 1200) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-ns-'));
  const file = path.join(tmp, 'page.html');
  fs.writeFileSync(file, html);
  const c = await launch(undefined, width, 900);
  try {
    await c.send('Page.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.send('Page.navigate', { url: pathToFileURL(file).href });
    let done = false;
    for (let i = 0; i < 200 && !done; i++) { await sleep(100); try { done = await c.eval('window.__done === true', false); } catch {} }
    if (!done) throw new Error('page did not finish: ' + (await c.eval('String(window.__err || "")', false).catch(() => '')));
    const out = await c.eval('window.__out', false);
    const h = await c.eval('Math.ceil(Math.max(document.body.getBoundingClientRect().bottom, 50))', false);
    await c.send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: false });
    await sleep(150);
    const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    return { png: Buffer.from(shot.data, 'base64'), out };
  } finally {
    c.close(); try { c.proc.kill(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
