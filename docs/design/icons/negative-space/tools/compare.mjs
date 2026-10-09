// node docs/design/icons/negative-space/tools/compare.mjs <out.png> <candidate dir> [...]
// One row per candidate, the same contexts in every row, so candidates can be judged side by side.
// More than ROWS candidates (default 8, env ROWS) are split over <out>-1.png, <out>-2.png and so on.
import fs from 'node:fs';
import path from 'node:path';
import { readCandidate, urls, MASKS, PAGE_JS, tile, pix, render, esc, COL, THEMED } from './lib.mjs';

const [outArg, ...dirs] = process.argv.slice(2);
if (!outArg || !dirs.length) { console.error('usage: node compare.mjs <out.png> <candidate dir> [...]'); process.exit(1); }
const ROWS = +(process.env.ROWS || 8);

const cell = (inner, cls = '') => `<td class="${cls}">${inner}</td>`;
function row(c) {
  const u = urls(c), m = c.meta || {};
  const warn = Object.entries(u.fallback).filter(([, v]) => v).map(([k]) => k.replace('.svg', ''));
  return `<tr>
  ${cell(`<b>${esc(c.id)}</b><br>${esc(m.title || '')}${warn.length ? `<br><span class="warn">no tuned ${warn.join(', ')}</span>` : ''}`, 'label')}
  ${cell(tile(u.mark, 132, 'squircle'), 'wd')}
  ${cell(tile(u.mark, 84, 'circle'), 'wd')}
  ${cell(tile(u.mark, 84, 'squircle'), 'wl')}
  ${cell(tile(u.markLight, 84, 'squircle', COL.paper), 'wl')}
  ${cell(tile(u.themedLight, 64, 'circle', THEMED.light.tile), 'wl')}
  ${cell(`<div class="strip"><img alt="" src="${u['cut-48.svg']}" width="48" height="48"><img alt="" src="${u['cut-32.svg']}" width="32" height="32"><img alt="" src="${u['cut-16.svg']}" width="16" height="16"></div>`, 'tb')}
  ${cell(pix(u['cut-16.svg'], 16, 6, '#F1F3F4'), 'tb')}
  ${cell(pix(u['cut-32.svg'], 32, 3, '#F1F3F4'), 'tb')}
  ${cell(`<div class="status"><img alt="" src="${u.glyph}" width="24" height="24"></div>${pix(u.glyph, 24, 4, '#000000')}`, 'sb')}
</tr>`;
}

function page(cs) {
  return `<!doctype html><meta charset="utf-8"><title>compare</title>
<style>
body{margin:0;background:#1A1A1C;color:#EDECE8;font:12px/1.4 system-ui,'DejaVu Sans',Arial,sans-serif}
table{border-collapse:collapse}
th{font-weight:500;font-size:11px;color:#A7A59F;padding:8px 10px;text-align:center}
td{padding:12px 14px;border-top:1px solid #2E2E31;vertical-align:middle}
td > *{margin:0 auto}
.label{width:150px;font-size:12px}
.wd{background:linear-gradient(135deg,#0B0C0E,#24272D)}
.wl{background:linear-gradient(135deg,#ECE8DF,#CFD6DD)}
.tb{background:#F1F3F4}
.sb{background:#000}
.strip{display:flex;gap:10px;align-items:center}
.status{display:flex;justify-content:center;margin-bottom:8px}
.pix{image-rendering:pixelated;display:block}
.warn{color:#E9A65E}
</style>${MASKS}
<table><tr><th></th><th>Launcher (dark wallpaper)</th><th>Circle</th><th>Light wallpaper</th><th>Light colourway</th><th>Themed</th><th>48 · 32 · 16 at 1×</th><th>16 ×6</th><th>32 ×3</th><th>Glyph 24, ×4</th></tr>
${cs.map(row).join('\n')}</table>
<script>${PAGE_JS}
(async () => { try { await drawPix(); window.__out = {}; } catch (e) { window.__err = String(e); } window.__done = true; })();
</script>`;
}

const all = dirs.map(readCandidate);
const pages = [];
for (let i = 0; i < all.length; i += ROWS) pages.push(all.slice(i, i + ROWS));
for (let p = 0; p < pages.length; p++) {
  const out = pages.length === 1 ? outArg : outArg.replace(/\.png$/i, '') + '-' + (p + 1) + '.png';
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const { png } = await render(page(pages[p]), 1480);
  fs.writeFileSync(out, png);
  console.log(path.resolve(out));
}
process.exit(0);
