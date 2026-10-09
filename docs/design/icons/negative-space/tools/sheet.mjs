// node docs/design/icons/negative-space/tools/sheet.mjs <candidate dir> [...]
// For each candidate: writes <dir>/sheet.png (every context at once) and <dir>/metrics.json, and prints the metrics.
import fs from 'node:fs';
import path from 'node:path';
import { readCandidate, urls, MASKS, PAGE_JS, tile, pix, render, esc, COL, THEMED } from './lib.mjs';

const NEIGHBOURS = ['#3E7BFA', '#F2B233', '#E5484D', '#2EB67D'];
const neighbour = (col, size) => `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${col};display:grid;place-items:center"><div style="width:${size * .36}px;height:${size * .36}px;border-radius:${size * .08}px;background:#fff;opacity:.92"></div></div>`;
const homeRow = (u, size, mask) => `<div class="home">${neighbour(NEIGHBOURS[0], size)}${neighbour(NEIGHBOURS[1], size)}${tile(u.mark, size, mask)}${neighbour(NEIGHBOURS[2], size)}${neighbour(NEIGHBOURS[3], size)}</div>`;
const fig = (inner, cap) => `<figure>${inner}<figcaption>${cap}</figcaption></figure>`;

function page(c) {
  const u = urls(c);
  const fb = f => (u.fallback[f] ? ' · <b class="warn">no tuned cut</b>' : '');
  const m = c.meta || {};
  return `<!doctype html><meta charset="utf-8"><title>${esc(c.id)}</title>
<style>
body{margin:0;background:#1A1A1C;color:#EDECE8;font:13px/1.45 system-ui,'DejaVu Sans',Arial,sans-serif}
.sec{padding:18px 24px;display:flex;gap:26px;align-items:flex-end;flex-wrap:wrap;border-top:1px solid #2E2E31}
.head{display:block}.head h1{font-size:18px;margin:0 0 4px}.head p{margin:0;max-width:110ch;color:#A7A59F}
.wall-d{background:linear-gradient(135deg,#0B0C0E,#24272D)}
.wall-l{background:linear-gradient(135deg,#ECE8DF,#CFD6DD);color:#17171A}
figure{margin:0;display:grid;gap:6px;justify-items:center}
figcaption{font-size:11px;opacity:.8;text-align:center;max-width:300px}
.home{display:flex;gap:18px;align-items:center}
.strip{display:flex;gap:14px;align-items:center;padding:8px 14px;border-radius:8px}
.pix{image-rendering:pixelated;display:block;box-shadow:0 0 0 1px rgba(128,128,128,.35)}
.warn{color:#E9A65E}
.status{background:#000;color:#fff;display:flex;gap:10px;align-items:center;padding:6px 12px;border-radius:6px;font-size:13px}
pre{margin:0;font:11px/1.4 ui-monospace,'DejaVu Sans Mono',monospace;color:#A7A59F;white-space:pre-wrap}
</style>${MASKS}
<div class="sec head"><h1>${esc(c.id)}${m.title ? ' · ' + esc(m.title) : ''}</h1><p>${esc(m.idea || '')}</p>${c.missing.length ? `<p class="warn">Missing: ${c.missing.join(', ')}</p>` : ''}</div>
<div class="sec wall-d">
  ${fig(tile(u.mark, 288, 'squircle'), 'Launcher, squircle mask (4× of 72 dp)')}
  ${fig(tile(u.mark, 144, 'circle'), 'Circle')}
  ${fig(tile(u.mark, 144, 'rounded'), 'Rounded square')}
  ${fig(tile(u.mark, 144, 'teardrop'), 'Teardrop')}
  ${fig(tile(u.themedDark, 144, 'circle', THEMED.dark.tile), 'Themed icon, dark')}
</div>
<div class="sec wall-l">
  ${fig(tile(u.mark, 144, 'squircle'), 'Same icon on a light home screen')}
  ${fig(tile(u.markLight, 144, 'squircle', COL.paper), 'Light colourway')}
  ${fig(tile(u.themedLight, 144, 'circle', THEMED.light.tile), 'Themed icon, light')}
  ${fig(`<img alt="" src="${u.markLight}" width="144" height="144" style="background:${COL.paper};border-radius:8px">`, 'Light launch screen (mark alone)')}
  ${fig(`<img alt="" src="${u.mark}" width="144" height="144" style="background:${COL.tile};border-radius:8px">`, 'Dark launch screen')}
</div>
<div class="sec wall-d">${fig(homeRow(u, 48, 'circle'), 'Home screen at 1× (48 px), circle')}${fig(homeRow(u, 64, 'squircle'), '64 px, squircle')}</div>
<div class="sec wall-l">${fig(homeRow(u, 48, 'circle'), 'Light home screen at 1×')}${fig(homeRow(u, 64, 'squircle'), '64 px, squircle')}</div>
<div class="sec">
  ${fig(`<div class="strip" style="background:#F1F3F4"><img alt="" src="${u['cut-16.svg']}" width="16" height="16"><img alt="" src="${u['cut-32.svg']}" width="32" height="32"><img alt="" src="${u['cut-48.svg']}" width="48" height="48"></div>`, 'Light toolbar: 16, 32, 48 at 1×')}
  ${fig(`<div class="strip" style="background:#35363A"><img alt="" src="${u['cut-16.svg']}" width="16" height="16"><img alt="" src="${u['cut-32.svg']}" width="32" height="32"><img alt="" src="${u['cut-48.svg']}" width="48" height="48"></div>`, 'Dark toolbar')}
  ${fig(`<div class="strip" style="background:#F1F3F4"><img alt="" src="${u['cut-16.svg:light']}" width="16" height="16"><img alt="" src="${u['cut-32.svg:light']}" width="32" height="32"><img alt="" src="${u['cut-48.svg:light']}" width="48" height="48"></div>`, 'Light colourway cuts')}
  ${fig(`<div class="status"><span>9:41</span><img alt="" src="${u.glyph}" width="24" height="24"><img alt="" src="${u.glyph}" width="18" height="18"><span style="opacity:.7">Now listening</span></div>`, 'Status bar glyph, 24 and 18 px')}
</div>
<div class="sec">
  ${fig(pix(u['cut-16.svg'], 16, 8, '#F1F3F4'), '16 px ×8' + fb('cut-16.svg'))}
  ${fig(pix(u['cut-32.svg'], 32, 4, '#F1F3F4'), '32 px ×4' + fb('cut-32.svg'))}
  ${fig(pix(u['cut-48.svg'], 48, 3, '#F1F3F4'), '48 px ×3' + fb('cut-48.svg'))}
  ${fig(pix(u.glyph, 24, 5, '#000000'), 'Glyph 24 px ×5' + fb('glyph-24.svg'))}
  ${fig(pix(u['cut-16.svg:light'], 16, 8, '#35363A'), 'Light cut 16 ×8')}
</div>
<div class="sec"><pre id="metrics">measuring…</pre></div>
<script>
const U = ${JSON.stringify({ mark: u.mark, c48: u['cut-48.svg'], c32: u['cut-32.svg'], c16: u['cut-16.svg'], glyph: u.glyph })};
${PAGE_JS}
(async () => {
  try {
    await drawPix();
    const out = { master: await markMetrics(U.mark), cuts: {
      'cut-48': await cutMetrics(U.c48, 48, '#111112', '#F3F2EE'),
      'cut-32': await cutMetrics(U.c32, 32, '#111112', '#F3F2EE'),
      'cut-16': await cutMetrics(U.c16, 16, '#111112', '#F3F2EE'),
      'glyph-24': await cutMetrics(U.glyph, 24, '#000000', '#FFFFFF') } };
    document.getElementById('metrics').textContent = 'master (dp, 108 canvas): ' + JSON.stringify(out.master) + '\\ncuts (soft = partly-covered pixels the mark touches; lower is crisper): ' + JSON.stringify(out.cuts);
    window.__out = out;
  } catch (e) { window.__err = String(e && e.stack || e); }
  window.__done = true;
})();
</script>`;
}

const dirs = process.argv.slice(2);
if (!dirs.length) { console.error('usage: node sheet.mjs <candidate dir> [...]'); process.exit(1); }
for (const d of dirs) {
  const c = readCandidate(d);
  const { png, out } = await render(page(c), 1200);
  fs.writeFileSync(path.join(c.dir, 'sheet.png'), png);
  const metrics = { id: c.id, missing: c.missing, ...(out || {}) };
  fs.writeFileSync(path.join(c.dir, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log(path.join(c.dir, 'sheet.png'));
  console.log(JSON.stringify(metrics));
}
process.exit(0);
