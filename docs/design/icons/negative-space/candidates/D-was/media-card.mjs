// The evidence for D's glyph: Android's status bar, media card (playing and paused) and collapsed notification while
// Shelf reads aloud, drawn at 2x, with the glyph cut as D on the left and the plain shared bookmark on the right.
// Writes media-card.png next to this file:   node candidates/D/media-card.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, dataUrl, esc } from '../../tools/lib.mjs';
import { draw, OPT, GLYPH_STUDY } from './build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const asD = draw({ ...OPT, glyph: GLYPH_STUDY }).out['glyph-24.svg'];   // study only
const plain = draw().out['glyph-24.svg'];
const img = (svg, s) => `<img alt="" src="${dataUrl(svg)}" width="${s}" height="${s}" style="display:block">`;
const ICON = {   // the transport controls, filled
  play: '<path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/>',
  pause: '<rect x="6" y="4.5" width="4" height="15" rx="1"/><rect x="14" y="4.5" width="4" height="15" rx="1"/>',
  prev: '<rect x="5" y="5" width="2.4" height="14" rx=".8"/><path d="M19 6.2v11.6a.9.9 0 0 1-1.4.75L9.6 12.75a.9.9 0 0 1 0-1.5l8-5.8A.9.9 0 0 1 19 6.2Z"/>',
  next: '<rect x="16.6" y="5" width="2.4" height="14" rx=".8"/><path d="M5 6.2v11.6a.9.9 0 0 0 1.4.75l8-5.8a.9.9 0 0 0 0-1.5l-8-5.8A.9.9 0 0 0 5 6.2Z"/>',
};
const icon = (k, s, c = '#F3F2EE') => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="${c}" style="display:block">${ICON[k]}</svg>`;
const card = (g, playing) => `<div class="card">
  <div class="top">${img(g, 36)}<span class="chip">Phone</span></div>
  <div class="mid"><div><div class="t">Why we should read slowly</div><div class="s">The Guardian · 12 min</div></div>
  <div class="btn">${icon(playing ? 'pause' : 'play', 52, '#111112')}</div></div>
  <div class="bar">${icon('prev', 30)}<div class="track"><div class="done"></div><div class="knob"></div></div>${icon('next', 30)}</div>
</div><div class="cap">${playing ? 'Playing: the button says pause' : 'Paused: the button says play'}</div>`;
const phone = (g, label) => `<div class="col"><div class="lab">${esc(label)}</div><div class="phone">
  <div class="sbar"><span>9:41</span>${img(g, 34)}<span class="sp"></span><span class="sig">▾◢▮</span></div>
  ${card(g, true)}${card(g, false)}
  <div class="mini">${img(g, 34)}<span class="mt">Shelf · Now listening</span><span class="sp"></span>${icon('prev', 30)}${icon('pause', 34)}${icon('next', 30)}</div>
</div></div>`;
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#1A1A1C;color:#EDECE8;font:15px/1.4 system-ui,'DejaVu Sans',sans-serif}
.head{padding:18px 20px 0;color:#A7A59F;max-width:1300px}
.wrap{display:flex;gap:40px;padding:16px 20px 24px}.col{display:grid;gap:10px}.lab{font-weight:600;font-size:18px}
.phone{width:680px;background:#0E0E10;border-radius:44px;padding:22px 24px 30px;display:grid;gap:14px}
.sbar{display:flex;align-items:center;gap:16px;font-size:28px;padding:0 16px 18px}.sp{flex:1}.sig{font-size:20px;letter-spacing:2px}
.card{background:#2B2B2F;border-radius:40px;padding:30px 32px}
.top{display:flex;justify-content:space-between;align-items:center}.chip{background:#3A3A3F;border-radius:20px;padding:6px 20px;font-size:24px}
.mid{display:flex;justify-content:space-between;align-items:center;margin:18px 0 26px}.t{font-size:33px}.s{font-size:26px;color:#A7A59F}
.btn{width:104px;height:104px;border-radius:28px;background:#F3F2EE;display:grid;place-items:center}
.bar{display:flex;align-items:center;gap:22px}.track{flex:1;height:6px;border-radius:3px;background:#55555B;position:relative}
.done{position:absolute;left:0;top:0;bottom:0;width:38%;background:#F3F2EE;border-radius:3px}.knob{position:absolute;left:38%;top:-14px;width:6px;height:34px;background:#F3F2EE;border-radius:3px}
.cap{color:#A7A59F;font-size:24px;padding:4px 4px 10px}
.mini{background:#2B2B2F;border-radius:30px;padding:22px 34px;display:flex;align-items:center;gap:28px}.mt{font-size:28px}
</style><div class="head">Option D while Shelf reads aloud: the status bar, the media card playing and paused, and the collapsed notification, drawn at 2x. Left, the glyph cut as D (a 2 px slot and a 3 px drop on the 16 x 20 px glyph bookmark); right, the plain shared bookmark, which D uses.</div>
<div class="wrap">${phone(asD, 'Glyph cut as D (split and play)')}${phone(plain, 'Plain bookmark glyph (base), which D uses')}</div>
<script>window.__out={};window.__done=true;</script>`;
const { png } = await render(html, 1480);
fs.writeFileSync(path.join(HERE, 'media-card.png'), png);
console.log(path.join(HERE, 'media-card.png'));
process.exit(0);
