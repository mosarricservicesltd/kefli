// node docs/design/icons/negative-space/tools/blind.mjs <out.png> <candidate dir> [...]
// A cold-read sheet: the candidates numbered 1, 2, 3… in the order given, with no names, among drawn neighbour apps on
// a dark and a light home screen, larger in a row, and at 16 px in a browser toolbar. Nothing on it says what the app is.
import fs from 'node:fs';
import path from 'node:path';
import { readCandidate, urls, MASKS, PAGE_JS, tile, render } from './lib.mjs';

const [outArg, ...dirs] = process.argv.slice(2);
if (!outArg || !dirs.length) { console.error('usage: node blind.mjs <out.png> <candidate dir> [...]'); process.exit(1); }
const cs = dirs.map(readCandidate).map((c, i) => ({ n: i + 1, u: urls(c) }));

const GLYPH = {
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="3"/>',
  map: '<path d="M14.1 6 9 3 3 6v15l6-3 6 3 6-3V3Z"/><path d="M9 3v15"/><path d="M15 6v15"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  cloud: '<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
};
const APPS = [['clock', '#FFFFFF', '#2B3140'], ['chat', '#3D6FD9', '#FFFFFF'], ['camera', '#2E2E33', '#FFFFFF'], ['map', '#2EB67D', '#FFFFFF'],
  ['mail', '#E5484D', '#FFFFFF'], ['cal', '#FFFFFF', '#3D6FD9'], ['cloud', '#69B7F0', '#FFFFFF'], ['bag', '#F2B233', '#FFFFFF']];
const app = ([g, bg, fg], size) => `<div class="app"><span class="nb" style="width:${size}px;height:${size}px;background:${bg};color:${fg}"><svg viewBox="0 0 24 24" width="${size * .46}" height="${size * .46}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${GLYPH[g]}</svg></span><span class="lab">&nbsp;</span></div>`;
const cand = (c, size, mask = 'circle') => `<div class="app">${tile(c.u.mark, size, mask)}<span class="lab">${c.n}</span></div>`;

// interleave: a neighbour app, then a candidate, so no two candidates sit side by side
function grid(size) {
  const cells = [];
  cs.forEach((c, i) => { cells.push(app(APPS[i % APPS.length], size)); cells.push(cand(c, size)); });
  cells.push(app(APPS[(cs.length) % APPS.length], size));
  return cells.join('');
}

const html = `<!doctype html><meta charset="utf-8"><title>sheet</title>
<style>
body{margin:0;background:#1A1A1C;font:13px/1.3 system-ui,'DejaVu Sans',Arial,sans-serif}
.sec{padding:22px 24px}
.home{display:grid;grid-template-columns:repeat(6,80px);gap:18px 10px;justify-content:start}
.app{display:grid;justify-items:center;gap:6px}
.nb{display:grid;place-items:center;border-radius:50%}
.lab{font-size:13px;font-weight:600}
.d{background:linear-gradient(135deg,#0B0C0E,#24272D);color:#F2F2F2}
.l{background:linear-gradient(135deg,#ECE8DF,#CFD6DD);color:#1F1F1F}
.big{display:flex;gap:22px;flex-wrap:wrap}
.tb{background:#F1F3F4;color:#1F1F1F;display:flex;gap:22px;align-items:center;padding:10px 24px}
.tb span{display:inline-flex;gap:6px;align-items:center;font-weight:600}
.tbd{background:#35363A;color:#E8EAED}
</style>${MASKS}
<div class="sec d"><div class="home">${grid(56)}</div></div>
<div class="sec l"><div class="home">${grid(56)}</div></div>
<div class="sec d"><div class="big">${cs.map(c => cand(c, 112, 'squircle')).join('')}</div></div>
<div class="tb">${cs.map(c => `<span><img alt="" src="${c.u['cut-16.svg']}" width="16" height="16">${c.n}</span>`).join('')}</div>
<div class="tb tbd">${cs.map(c => `<span><img alt="" src="${c.u['cut-16.svg']}" width="16" height="16">${c.n}</span>`).join('')}</div>
<script>${PAGE_JS}
(async () => { try { window.__out = {}; } catch (e) { window.__err = String(e); } window.__done = true; })();
</script>`;

const { png } = await render(html, 600);
fs.mkdirSync(path.dirname(path.resolve(outArg)), { recursive: true });
fs.writeFileSync(outArg, png);
console.log(path.resolve(outArg));
process.exit(0);
