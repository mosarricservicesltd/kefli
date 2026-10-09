// p3 · Quiet play. Run from this folder: node build.mjs
// The bookmark stays the hero: a small play, the app's own play button (Lucide's play, 14 deep by 18 tall, the shape
// the player uses), punched through the bookmark at its centre of mass. The icon says "saved" first and "you can
// listen" second. Every number below is a design decision; change it here and rebuild.
import fs from 'node:fs';
import * as g from '../../tools/geom.mjs';

const PAPER = '#F3F2EE', WHITE = '#FFFFFF';
const tri = (xl, yTop, h, w) => [[xl, yTop], [xl + w, yTop + h / 2], [xl, yTop + h]]; // right-pointing, flat side at xl
const path = (d, fill = PAPER) => `<path fill="${fill}" fill-rule="evenodd" d="${d}"/>`;
// a play drawn in whole pixels: x of the flat side, top row, column heights from the flat side to the tip
const pixelPlay = (x, top, cols) => {
  const mid = top + cols[0] / 2; let d = 'M' + x + ' ' + top, last = top;
  cols.forEach((hh, i) => { const t = mid - hh / 2; if (i && t !== last) d += 'V' + t; last = t; d += 'H' + (x + i + 1); });
  for (let i = cols.length - 1; i >= 0; i--) { const b = mid + cols[i] / 2; if (b !== last) d += 'V' + b; last = b; d += 'H' + (x + i); }
  return d + 'Z';
};

// ---------- master, 108 dp canvas ----------
// Bookmark as p1 and p2: 42.5 dp wide, today's proportions, drawn box centred (farthest ink 32.4 dp).
const W = 42.5, k = W / 34, TOP = 28.536, CX = 54;
const P = {
  h: 15,           // flat side in bookmark units, 36% of the bookmark's height: the smallest play a 48 px icon shows plainly
  ratio: 14 / 18,  // Lucide's play, as in the player (polygon 6 3, 20 12, 6 21)
  f: 0.40,         // flat side 0.40 of the depth left of the centre line: close to the centroid, as a small shape in a
                   // wide field is judged by its mass, not by its walls
  cy: 17.6,        // the play's axis 17.6 units below the top: the bookmark's centre of mass is 18.4, but a small play
                   // there reads low, as the eye takes the body above the notch for the bookmark's middle
  r: 1.7,          // corner radius: 0.11 of the play's height, the same softness as p1's play, which reads as soft as the
                   // shoulders (one corner language for the whole family)
};
{
  const h = P.h * k, w = h * P.ratio, xl = CX - P.f * w, yTop = TOP + P.cy * k - h / 2;
  const d = g.join(g.bookmark({ cx: CX, top: TOP, w: W }), g.roundedPolygon(tri(xl, yTop, h, w), P.r * k));
  fs.writeFileSync('mark.svg', g.svg(108, path(d),
    `p3 Quiet play. Bookmark ${W} dp wide in today's proportions, drawn box centred. Play hole: the app's play (14:18), ` +
    `flat side ${g.fmt(h)} dp, corners r ${g.fmt(P.r * k)}, centred on the bookmark by eye.`));
}

// ---------- tuned cuts: one unit = one pixel ----------
const BM = {
  48: { x0: 10, top: 7, bw: 28, tips: 41, apex: 32, rTop: 3 },
  32: { x0: 7, top: 5, bw: 18, tips: 27, apex: 21, rTop: 2 },
  16: { x0: 3, top: 2, bw: 10, tips: 14, apex: 11, rTop: 1 },
};
const HOLE = {
  // 48: 12 px tall, 9.3 deep, flat side on x 20: 10 px of paper at the flat side and 9.9 at the rounded tip
  48: g.roundedPolygon(tri(20, 15.5, 12, 9.33), 1.4),
  // 32: 8.5 px tall, 6.6 deep, flat side on x 13: 6 px at the flat side, 6.2 at the tip
  32: g.roundedPolygon(tri(13, 10, 8.5, 6.6), 0.9),
  // 16: whole pixels, columns of 5, 3 and 1 from x 7, rows 5 to 9
  16: pixelPlay(7, 5, [5, 3, 1]),
};
for (const n of [48, 32, 16]) {
  const c = BM[n];
  const bm = g.bookmark({ cx: c.x0 + c.bw / 2, top: c.top, w: c.bw, h: c.tips - c.top, notch: c.tips - c.apex, rTop: c.rTop, rTip: 0 });
  fs.writeFileSync(`cut-${n}.svg`, g.svg(n, g.tileRect(n) + path(g.join(bm, HOLE[n]))));
}

// ---------- status-bar glyph, 24 px, white on transparent, inside the central 20 x 20 ----------
// bookmark 16 x 20, notch 5; play 8.5 tall, flat side on x 9 (5 px wall), tip wall 5.2 px
{
  const bm = g.bookmark({ cx: 12, top: 2, w: 16, h: 20, notch: 5, rTop: 2, rTip: 0 });
  fs.writeFileSync('glyph-24.svg', g.svg(24, path(g.join(bm, g.roundedPolygon(tri(9, 6.5, 8.5, 6.6), 0.9)), WHITE)));
}
console.log('p3 built');
