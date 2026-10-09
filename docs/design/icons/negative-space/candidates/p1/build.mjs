// p1 · Centred play. Run from this folder: node build.mjs
// Shelf's bookmark with one hole, an equilateral play with rounded corners, optically centred in the body.
// Every number below is a design decision; change it here and rebuild.
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
// The bookmark at 42.5 dp wide (1.25 x today's 34), its drawn box centred on the canvas: farthest ink 32.4 dp from the
// centre, inside the 33 dp safe circle. Play proportions in today's bookmark units (34 wide), so k scales them.
const W = 42.5, k = W / 34, TOP = 28.536, CX = 54;
const P = {
  h: 22,          // flat side: about half the bookmark's 42 unit height, large but the bookmark still reads first
  ratio: 0.866,   // equilateral
  f: 0.42,        // flat side 0.42 of the depth left of the centre line (box centre 0.5, centroid 0.333):
                  // walls of 9 units at the flat side and 8.5 at the rounded tip, which read as even
  cy: 17.25,      // centre of the flat side, 17.25 units below the top: 8.1 units of paper above the hole, 6.4 to the
                  // notch's apex, which balances because the apex is a point
  r: 2.5,         // corner radius: on a 60 degree corner it reads as soft as the 4 unit shoulders on their 90
};
{
  const h = P.h * k, w = h * P.ratio, xl = CX - P.f * w, yTop = TOP + P.cy * k - h / 2;
  const d = g.join(g.bookmark({ cx: CX, top: TOP, w: W }), g.roundedPolygon(tri(xl, yTop, h, w), P.r * k));
  fs.writeFileSync('mark.svg', g.svg(108, path(d),
    `p1 Centred play. Bookmark ${W} dp wide in today's proportions, drawn box centred. Play hole: equilateral, flat side ` +
    `${g.fmt(h)} dp, corners r ${g.fmt(P.r * k)}, flat side ${P.f} of its depth left of the centre line so the walls at the flat side and the tip read even.`));
}

// ---------- tuned cuts: one unit = one pixel ----------
// bookmark: left edge, top, width, tip line, notch apex, shoulder radius (tips drawn sharp at these sizes)
const BM = {
  48: { x0: 10, top: 7, bw: 28, tips: 41, apex: 32, rTop: 3 },
  32: { x0: 7, top: 5, bw: 18, tips: 27, apex: 21, rTop: 2 },
  16: { x0: 3, top: 2, bw: 10, tips: 14, apex: 11, rTop: 1 },
};
const HOLE = {
  // 48: flat side on x 17 (7 px wall), 18 px tall and 16 deep (a shade longer than equilateral, so the rounded tip also
  // leaves 7 px); 6.5 px above, 5.2 to the apex
  48: g.roundedPolygon(tri(17, 12, 18, 16), 2),
  // 32: flat side on x 12 (5 px wall), 11 px tall, tip wall 4.9 px; 4.5 px above, 3.3 to the apex
  32: g.roundedPolygon(tri(12, 8.5, 11, 9.5), 1.4),
  // 16: the play in whole pixels (a drawn triangle this small is only grey pixels): columns of 5, 3, 3 and 1, the
  // nearest to equilateral that whole pixels allow, flat side on x 6, rows 4 to 8, so it floats with 2 px of paper
  // above and 2 to 3 below
  16: pixelPlay(6, 4, [5, 3, 3, 1]),
};
for (const n of [48, 32, 16]) {
  const c = BM[n];
  const bm = g.bookmark({ cx: c.x0 + c.bw / 2, top: c.top, w: c.bw, h: c.tips - c.top, notch: c.tips - c.apex, rTop: c.rTop, rTip: 0 });
  fs.writeFileSync(`cut-${n}.svg`, g.svg(n, g.tileRect(n) + path(g.join(bm, HOLE[n]))));
}

// ---------- status-bar glyph, 24 px, white on transparent, inside the central 20 x 20 ----------
// bookmark 16 x 20 (x 4..20, y 2..22), notch 5; play flat side on x 8 (4 px wall), 10 tall, tip wall 4 px
{
  const bm = g.bookmark({ cx: 12, top: 2, w: 16, h: 20, notch: 5, rTop: 2, rTip: 0 });
  fs.writeFileSync('glyph-24.svg', g.svg(24, path(g.join(bm, g.roundedPolygon(tri(8, 5, 10, 9.2), 1.2)), WHITE)));
}
console.log('p1 built');
