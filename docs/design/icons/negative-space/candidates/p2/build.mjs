// p2 · Notch-cut play. Run from this folder: node build.mjs
// The two cuts that make the tail, folded to point forward, make the play: its slanted edges are the notch's edges
// (same slope, same length), so the play has exactly the notch's area. It sits on the tail, its lower edge running
// parallel to the notch's left edge with an even strap of paper between them, and its corners are rounded like the
// tail's tips, which have the same angle.
import fs from 'node:fs';
import * as g from '../../tools/geom.mjs';

const PAPER = '#F3F2EE', WHITE = '#FFFFFF';
const path = (d, fill = PAPER) => `<path fill="${fill}" fill-rule="evenodd" d="${d}"/>`;
// a play drawn in whole pixels: x of the flat side, top row, column heights from the flat side to the tip
const pixelPlay = (x, top, cols) => {
  const mid = top + cols[0] / 2; let d = 'M' + x + ' ' + top, last = top;
  cols.forEach((hh, i) => { const t = mid - hh / 2; if (i && t !== last) d += 'V' + t; last = t; d += 'H' + (x + i + 1); });
  for (let i = cols.length - 1; i >= 0; i--) { const b = mid + cols[i] / 2; if (b !== last) d += 'V' + b; last = b; d += 'H' + (x + i); }
  return d + 'Z';
};

// The construction, for any bookmark: x0 left edge, bw width, tips (y of the tail tips), apex (y of the notch apex).
// The play is the notch's triangle folded: flat side = twice the notch's depth, depth = half the bookmark's width,
// so its slanted edges have the notch's slope and length. xl: flat side; strap: paper between the play's lower edge and
// the notch's left edge, measured square to them.
function notchPlay({ x0, bw, tips, apex }, { xl, strap }) {
  const half = bw / 2, depth = tips - apex, slope = depth / half;
  const h = 2 * depth, w = half;
  const notchY = x => tips - slope * (x - x0);                 // the notch's left edge
  const bly = notchY(xl) - strap * Math.hypot(1, slope);     // lower edge offset square to the notch by the strap
  return { pts: [[xl, bly - h], [xl + w, bly - h / 2], [xl, bly]], h, w };
}

// ---------- master, 108 dp canvas ----------
// Bookmark as p1: 42.5 dp wide, today's proportions, drawn box centred (farthest ink 32.4 dp).
const W = 42.5, k = W / 34, TOP = 28.536, CX = 54;
const BOOK = { x0: CX - W / 2, bw: W, tips: TOP + 42 * k, apex: TOP + 31 * k };
const P = {
  f: 0.46,    // flat side 0.46 of the play's depth left of the centre line: with the sharper tip, walls of 9.2 units at the
              // flat side and 9.1 at the tip read as even
  strap: 5,   // bookmark units of paper between the play and the notch: thinner than the 9 unit walls on purpose, so the
              // play reads as resting on the tail
  r: 1.5,     // corner radius: the tail tips' 1.5 units, as the play's back corners have the tips' 57 degree angle
};
{
  const play = notchPlay(BOOK, { xl: CX - P.f * (W / 2), strap: P.strap * k });
  const d = g.join(g.bookmark({ cx: CX, top: TOP, w: W }), g.roundedPolygon(play.pts, P.r * k));
  fs.writeFileSync('mark.svg', g.svg(108, path(d),
    `p2 Notch-cut play. Bookmark ${W} dp wide in today's proportions, drawn box centred. Play hole: the notch folded, ` +
    `${g.fmt(play.h)} x ${g.fmt(play.w)} dp, slanted edges parallel to the notch's and as long; a ${g.fmt(P.strap * k)} dp strap ` +
    `along the notch's left edge; corners r ${g.fmt(P.r * k)}, as the tail tips.`));
}

// ---------- tuned cuts: one unit = one pixel ----------
// Each cut's play uses that cut's own notch, so its edges are parallel to the notch at every size.
const CUTS = {
  // 48: notch 9 over 14, play 18 x 14; flat side on x 18 (8 px wall, 7 at the tip), strap 4 px, 6.6 px above
  48: { book: { x0: 10, top: 7, bw: 28, tips: 41, apex: 32, rTop: 3 }, xl: 18, strap: 4.085, r: 1.2 },
  // 32: notch 6 over 9, play 12 x 9; flat side on x 12 (5 px wall), strap 2.6 px
  32: { book: { x0: 7, top: 5, bw: 18, tips: 27, apex: 21, rTop: 2 }, xl: 12, strap: 2.6, r: 0.8 },
  // 16: drawn in pixels (a drawn triangle this small is grey mush): columns of 6, 4, 4 and 2 from the flat side on
  // x 6, rows 4 to 9, so it rests on the tail: 2 px above, its lower steps 1 to 2 px from the notch and nearly parallel to it
  16: { book: { x0: 3, top: 2, bw: 10, tips: 14, apex: 11, rTop: 1 }, pixels: pixelPlay(6, 4, [6, 4, 4, 2]) },
};
for (const [n, c] of Object.entries(CUTS)) {
  const b = c.book, hole = c.pixels || g.roundedPolygon(notchPlay(b, c).pts, c.r);
  const bm = g.bookmark({ cx: b.x0 + b.bw / 2, top: b.top, w: b.bw, h: b.tips - b.top, notch: b.tips - b.apex, rTop: b.rTop, rTip: 0 });
  fs.writeFileSync(`cut-${n}.svg`, g.svg(+n, g.tileRect(+n) + path(g.join(bm, hole))));
}

// ---------- status-bar glyph, 24 px, white on transparent, inside the central 20 x 20 ----------
// bookmark 16 x 20, notch 5 over 8; play 10 x 8 with flat side on x 8, strap 3 px
{
  const b = { x0: 4, bw: 16, tips: 22, apex: 17 }, play = notchPlay(b, { xl: 8, strap: 3 });
  const bm = g.bookmark({ cx: 12, top: 2, w: 16, h: 20, notch: 5, rTop: 2, rTip: 0 });
  fs.writeFileSync('glyph-24.svg', g.svg(24, path(g.join(bm, g.roundedPolygon(play.pts, 0.8)), WHITE)));
}
console.log('p2 built');
