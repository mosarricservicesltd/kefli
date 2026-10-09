// i1 · Paused bookmark, punched from a paper disc.
// Writes mark.svg, cut-48.svg, cut-32.svg, cut-16.svg and glyph-24.svg, then prints the narrowest walls.
// Run from this folder (node build.mjs) or from the study folder (node candidates/i1/build.mjs).
// While sketching, OUT=<dir> writes elsewhere and PARAMS='{"w":33,"c16":{"top":4}}' overrides any number below.
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
// Three levels: the paper disc, Shelf's bookmark cut out of it, and a pause left standing in the bookmark.
const P = Object.assign({
  r: 32,            // disc radius about the canvas centre
  w: 34,            // bookmark width: today's, so every bookmark proportion is today's (geom.bookmark defaults)
  top: 34.2,        // bookmark top edge: the box centre sits 0.5 below the disc's centre
  barW: 5.5, barH: 18, gap: 5.5, barR: 1.5,   // bars take the tips' radius (1.5/34 of 34): two radii in the whole drawing
  pauseY: 17,       // pause centre below the bookmark's top edge: a little below the body's centre, as the V under it reads as extra room
}, OV);

const master = {
  disc: g.circle(54, 54, P.r),
  hole: g.bookmark({ cx: 54, top: P.top, w: P.w }),
  pause: g.pause({ cx: 54, cy: P.top + P.pauseY, barW: P.barW, barH: P.barH, gap: P.gap, r: P.barR }),
};
out('mark.svg', g.svg(108, evenodd(g.join(master.disc, master.hole, master.pause)),
  `i1 master: a paper disc (r ${P.r}), Shelf's bookmark cut out of it (${P.w} wide, today's proportions), and a paper pause left standing in the hole (bars ${P.barW} x ${P.barH}, gap ${P.gap}). One evenodd path, three levels.`));

// ---------------------------------------------------------------- tuned cuts, one unit = one pixel
// Each cut: disc radius r about the tile centre; the bookmark from x0 to x1, top edge, sharp tips, notch apex on the
// centre line (a pixel boundary on these even tiles); bars barW x barH from barTop with a gap, centred.
const C = {
  48: { r: 21, x0: 13, x1: 35, top: 11, tips: 38, apex: 31, rTop: 3, barW: 4, barH: 12, gap: 4, barTop: 16 },
  32: { r: 14, x0: 9, x1: 23, top: 7, tips: 25, apex: 20, rTop: 2, barW: 2, barH: 8, gap: 2, barTop: 10 },
  16: { r: 7, x0: 5, x1: 11, top: 3, tips: 12, apex: 9, rTop: 1, stepped: [3, 5, 6, 6, 7, 7, 7] },
  24: { r: 10, x0: 7, x1: 17, top: 6, tips: 18, apex: 15, rTop: 1.5 },
};
for (const n of [48, 32, 16, 24]) Object.assign(C[n], OV['c' + n] || {});

const bmCut = ({ x0, x1, top, tips, apex, rTop }) =>
  g.roundedPolygon([[x0, top], [x1, top], [x1, tips], [(x0 + x1) / 2, apex], [x0, tips]], [rTop, rTop, 0, 0, 0]);
const barsCut = (n, { barW, barH, gap, barTop }) =>
  g.rect(n / 2 - gap / 2 - barW, barTop, barW, barH) + g.rect(n / 2 + gap / 2, barTop, barW, barH);

// A disc drawn on whole pixels for the 16 px cut: stepped gives the half-widths of the top half's rows (mirrored
// below), so there is no part-tone edge. A hand-drawn pixel circle: two-pixel steps at the top, one-pixel steps
// round the shoulders, flat runs at the sides, rounder than a coverage threshold's octagon.
function pixelDisc(cx, cy, half) {
  const rows = [...half, ...half.slice().reverse()].map((h, i) => [cy - half.length + i, cx - h, cx + h]);
  const right = rows.flatMap(([y, , b]) => [[b, y], [b, y + 1]]), left = rows.slice().reverse().flatMap(([y, a]) => [[a, y + 1], [a, y]]);
  const pts = [...right, ...left].filter((p, i, A) => { const q = A[(i - 1 + A.length) % A.length], s = A[(i + 1) % A.length]; return !((q[0] === p[0] && p[0] === s[0]) || (q[1] === p[1] && p[1] === s[1])); });
  return 'M' + pts.map(([x, y]) => x + ' ' + y).join('L') + 'Z';
}
const discCut = (n, c) => c.stepped ? pixelDisc(n / 2, n / 2, c.stepped) : g.circle(n / 2, n / 2, c.r);
const cut = (n, body, note) => g.svg(n, g.tileRect(n) + evenodd(body), note);
const desc = c => `disc r ${c.r}; bookmark hole ${c.x1 - c.x0} x ${c.tips - c.top} with a ${c.tips - c.apex} px notch`;

out('cut-48.svg', cut(48, g.join(discCut(48, C[48]), bmCut(C[48]), barsCut(48, C[48])),
  `48 px: ${desc(C[48])}; pause bars ${C[48].barW} x ${C[48].barH}, gap ${C[48].gap}; every edge on whole pixels except the disc and the notch`));
out('cut-32.svg', cut(32, g.join(discCut(32, C[32]), bmCut(C[32]), barsCut(32, C[32])),
  `32 px: ${desc(C[32])}; pause bars ${C[32].barW} x ${C[32].barH}, gap ${C[32].gap}`));
out('cut-16.svg', cut(16, g.join(discCut(16, C[16]), bmCut(C[16])),
  `16 px: ${desc(C[16])}; the disc stepped on whole pixels; the pause drops out`));
out('glyph-24.svg', g.svg(24, evenodd(g.join(discCut(24, C[24]), bmCut(C[24])), WHITE),
  `glyph: ${desc(C[24])}; no pause, so the status bar never shows a paused symbol while Shelf is reading aloud`));

// ---------------------------------------------------------------- checks
const subs = d => d.match(/M[^M]*/g);
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
const f2 = v => v.toFixed(2);
const D = flat(master.disc), Hh = flat(master.hole), Bars = subs(master.pause).map(flat);
console.log('master: reach', f2(Math.max(...D.map(([x, y]) => Math.hypot(x - 54, y - 54)))), '| disc to hole', f2(wall(Hh, D)),
  '| hole to bars', Bars.map(b => f2(wall(b, Hh))).join(' '), '(4.5 dp is 3 px at 48)');
for (const n of [48, 32, 16, 24]) {
  const c = C[n], d = flat(discCut(n, c)), h = flat(bmCut(c)), bars = c.barW ? subs(barsCut(n, c)).map(flat) : [];
  console.log(`cut ${n}: disc to hole ${f2(wall(h, d))}` + (bars.length ? ` | hole to bars ${bars.map(b => f2(wall(b, h))).join(' ')}` : ''));
}
