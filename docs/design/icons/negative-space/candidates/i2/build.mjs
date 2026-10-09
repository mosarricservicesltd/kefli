// i2 · The page: a paper page with Shelf's bookmark cut into it near its top edge.
// Writes mark.svg, cut-48.svg, cut-32.svg, cut-16.svg and glyph-24.svg, then prints the walls and reach.
// Run from this folder (node build.mjs) or from the study folder (node candidates/i2/build.mjs).
// While sketching, OUT=<dir> writes elsewhere and PARAMS='{"w":28,"c16":{"top":2}}' overrides any number below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.env.OUT || HERE;
const OV = JSON.parse(process.env.PARAMS || '{}');
const PAPER = '#F3F2EE', WHITE = '#FFFFFF';
const out = (f, s) => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, f), s); };
const evenodd = (d, fill = PAPER) => `<path fill="${fill}" fill-rule="evenodd" d="${d}"/>`;

// ---------------------------------------------------------------- master, 108 dp canvas
// Two levels: the page, and the bookmark cut out of it. The bookmark sits at the head of the page in an even margin
// (the same paper above it as at its sides) and the page carries on below its tail, as a ribbon lies in a book.
const P = Object.assign({
  pw: 40, ph: 55,   // the page, centred on the canvas: 1 : 1.375, close to a sheet of A4, its corners inside the safe circle
  w: 28,            // bookmark width; every bookmark proportion is today's (geom.bookmark defaults)
  topWall: 6,       // paper above the bookmark, equal to the side walls ((pw - w) / 2): an even margin on three sides
}, OV);
const k = P.w / 34;
P.pr = OV.pr ?? 4 * k;                         // the page's corners take the bookmark's shoulder radius: one corner language
const px0 = 54 - P.pw / 2, py0 = 54 - P.ph / 2;
const master = {
  page: g.rect(px0, py0, P.pw, P.ph, P.pr),
  hole: g.bookmark({ cx: 54, top: py0 + P.topWall, w: P.w }),
};
out('mark.svg', g.svg(108, evenodd(g.join(master.page, master.hole)),
  `i2 master: a ${P.pw} x ${P.ph} paper page (corners r ${+P.pr.toFixed(2)}, the bookmark's shoulder radius) with Shelf's bookmark (${P.w} wide, today's proportions) cut out ${P.topWall} below its top edge. One evenodd path, two levels.`));

// ---------------------------------------------------------------- tuned cuts, one unit = one pixel
// Each cut: the page from x0 to x1 and y0 to y1 with corner radius pr; the bookmark from bx0 to bx1, top edge, sharp
// tips, notch apex on the centre line (a pixel boundary on these even tiles), shoulders rTop.
const C = {
  48: { x0: 11, x1: 37, y0: 6, y1: 42, pr: 2, bx0: 15, bx1: 33, top: 10, tips: 32, apex: 26, rTop: 2 },
  32: { x0: 7, x1: 25, y0: 4, y1: 28, pr: 1.5, bx0: 10, bx1: 22, top: 7, tips: 22, apex: 18, rTop: 1.5 },
  16: { x0: 3, x1: 13, y0: 1, y1: 15, pr: 0, bx0: 5, bx1: 11, top: 3, tips: 11, apex: 8, rTop: 0 },
  24: { x0: 5, x1: 19, y0: 2, y1: 22, pr: 1, bx0: 7, bx1: 17, top: 4, tips: 16, apex: 13, rTop: 1 },
};
for (const n of [48, 32, 16, 24]) Object.assign(C[n], OV['c' + n] || {});

const pageCut = c => g.rect(c.x0, c.y0, c.x1 - c.x0, c.y1 - c.y0, c.pr);
const bmCut = c => g.roundedPolygon([[c.bx0, c.top], [c.bx1, c.top], [c.bx1, c.tips], [(c.bx0 + c.bx1) / 2, c.apex], [c.bx0, c.tips]], [c.rTop, c.rTop, 0, 0, 0]);
const cut = (n, c, note) => g.svg(n, g.tileRect(n) + evenodd(g.join(pageCut(c), bmCut(c))), note);
const desc = c => `page ${c.x1 - c.x0} x ${c.y1 - c.y0}; bookmark hole ${c.bx1 - c.bx0} x ${c.tips - c.top} with a ${c.tips - c.apex} px notch, ` +
  `${c.top - c.y0} px of page above it, ${c.bx0 - c.x0} at the sides and ${c.y1 - c.tips} below its tips`;

out('cut-48.svg', cut(48, C[48], `48 px: ${desc(C[48])}; every edge on whole pixels except the notch`));
out('cut-32.svg', cut(32, C[32], `32 px: ${desc(C[32])}`));
out('cut-16.svg', cut(16, C[16], `16 px: ${desc(C[16])}; the notch at 45 degrees so it survives`));
out('glyph-24.svg', g.svg(24, evenodd(g.join(pageCut(C[24]), bmCut(C[24])), WHITE), `glyph: ${desc(C[24])}`));

// ---------------------------------------------------------------- checks
function flat(d) {
  const t = d.match(/[MLAZ]|-?\d*\.?\d+(?:e-?\d+)?/gi); let i = 0, p = [0, 0]; const pts = [];
  const n = () => parseFloat(t[i++]);
  while (i < t.length) {
    const c = t[i++];
    if (c === 'M' || c === 'L') { p = [n(), n()]; pts.push(p); }
    else if (c === 'A') {
      const r = n(); n(); n(); const large = n(), sweep = n(), e = [n(), n()];
      const [x1, y1] = p, [x2, y2] = e, dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, d2 = dx * dx + dy * dy;
      const rr = Math.max(r, Math.sqrt(d2)), co = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rr * rr - d2) / d2));
      const cx = co * dy + (x1 + x2) / 2, cy = -co * dx + (y1 + y2) / 2;
      let a1 = Math.atan2(y1 - cy, x1 - cx), da = Math.atan2(y2 - cy, x2 - cx) - a1;
      if (sweep && da < 0) da += 2 * Math.PI; if (!sweep && da > 0) da -= 2 * Math.PI;
      for (let s = 1; s <= 24; s++) pts.push([cx + rr * Math.cos(a1 + da * s / 24), cy + rr * Math.sin(a1 + da * s / 24)]);
      p = e;
    }
  }
  return pts;
}
function wall(A, B) {
  let m = Infinity;
  for (let a = 0; a < A.length; a++) {
    const p = A[a], q = A[(a + 1) % A.length];
    for (let s = 0; s < 8; s++) {
      const x = p[0] + (q[0] - p[0]) * s / 8, y = p[1] + (q[1] - p[1]) * s / 8;
      for (let b = 0; b < B.length; b++) {
        const u = B[b], v = B[(b + 1) % B.length], vx = v[0] - u[0], vy = v[1] - u[1], L = vx * vx + vy * vy;
        const tt = L ? Math.max(0, Math.min(1, ((x - u[0]) * vx + (y - u[1]) * vy) / L)) : 0;
        m = Math.min(m, Math.hypot(x - u[0] - tt * vx, y - u[1] - tt * vy));
      }
    }
  }
  return m;
}
const f2 = v => v.toFixed(2), Pg = flat(master.page), Hh = flat(master.hole);
console.log('master: reach', f2(Math.max(...Pg.map(([x, y]) => Math.hypot(x - 54, y - 54)))), '| page to hole', f2(wall(Hh, Pg)),
  '| side walls', f2((P.pw - P.w) / 2), '| below the tips', f2(py0 + P.ph - (py0 + P.topWall + 42 * k)), '(4.5 dp is 3 px at 48)');
for (const n of [48, 32, 16, 24]) console.log(`cut ${n}: page to hole ${f2(wall(flat(bmCut(C[n])), flat(pageCut(C[n]))))}`);
