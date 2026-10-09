// r1 · Ribbon with a play hole. node build.mjs (from this folder or anywhere): writes the five SVGs next to it.
// The tile is the book; Shelf's bookmark hangs from its top edge like a hardback's ribbon marker, and only its body
// and notched tail show. A play is cut out of the body. Every angle comes from Shelf's notch (tan = 11/17, 32.9 deg):
// the play's slanted edges are parallel to the notch's edges, so its two back corners have the tips' 57.1 deg and the
// band of paper under it runs parallel to the notch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const write = (f, s) => fs.writeFileSync(path.join(HERE, f), s);
const PAPER = '#F3F2EE', WHITE = '#FFFFFF';
const f = g.fmt;
const TAN = 11 / 17, COS = Math.cos(Math.atan(TAN));

// ---------------------------------------------------------------- master, 108 dp canvas
const M = {
  cx: 54,
  W: 40,          // ribbon width (today's bookmark is 34; the reference solid is 40)
  yT: 79,         // the tail's sharp tips; the ribbon runs from y = 0, off the top of every mask
  playH: 24,      // the play's flat side
  k: 0.35,        // horizontal placement: 0 = box centred in the ribbon, 1 = centroid centred
  band: 10.5,     // paper between the play's lower edge and the notch's left edge, measured square to both
};
M.N = M.W * 11 / 34;              // Shelf's notch, 11/34 of the width
M.rTip = M.W * 1.5 / 34;          // Shelf's tip radius
M.playW = (M.playH / 2) / TAN;    // edges parallel to the notch
M.playX = M.cx + M.k * M.playW / 6 - M.playW / 2;           // flat side
{
  const x0 = M.cx - M.W / 2, yEdge = M.yT - (M.playX - x0) * TAN; // notch edge under the play's back corner
  M.playCy = yEdge - M.band / COS - M.playH / 2;
}
const ribbon = g.bookmark({ cx: M.cx, top: 0, w: M.W, h: M.yT, rTop: 0 });
const play = g.play({ cx: M.playX + M.playW / 2, cy: M.playCy, h: M.playH, w: M.playW, r: M.rTip, at: 'box' });
const walls = {
  left: M.playX - (M.cx - M.W / 2),
  right: (M.cx + M.W / 2) - (M.playX + M.playW - (M.rTip / Math.sin(Math.atan(TAN)) - M.rTip)),
  band: M.band,
};
write('mark.svg', g.svg(108, `<path fill="${PAPER}" fill-rule="evenodd" d="${g.join(ribbon, play)}"/>`,
  `r1, ribbon with a play hole. Ribbon ${M.W} wide from y 0 (off the top of every mask) to tips at ${M.yT}; Shelf's notch ` +
  `${f(M.N)} deep, tips r ${f(M.rTip)}. Play ${M.playH} tall, ${f(M.playW)} deep, its slanted edges parallel to the notch ` +
  `(tan 11/17), corners r ${f(M.rTip)} like the tips, centred at y ${f(M.playCy)}, ${M.k} of the way from box to centroid ` +
  `centring. Walls: left ${f(walls.left)}, right ${f(walls.right)} (from the rounded tip), under ${f(walls.band)}.`));

// ---------------------------------------------------------------- tuned cuts: one unit = one pixel
// Polygons with every straight edge on whole pixels; diagonals only on the notch and the play.
// The cuts keep a lip of tile above the ribbon (3 px at 48, 2 at 32, 1 at 16: the smallest detail each size allows).
// Bled to the edge, the paper merged with Chrome's and Firefox's light toolbars and the tile read as a dark U round a
// floating play; with the lip the tile stays closed on any toolbar, and the ribbon's square top corners still say it
// comes from under the top edge.
const poly = pts => 'M' + pts.map(([x, y]) => f(x) + ' ' + f(y)).join('L') + 'Z';
const cut = (n, d, note) => g.svg(n, `${g.tileRect(n)}\n  <path fill="${PAPER}" fill-rule="evenodd" d="${d}"/>`, note);

// 48 px (1 px = 1.5 dp). Ribbon 28 px (10..38), notch 9 deep over a 14 px half width (slope 0.643, Shelf's 0.647).
// Play: flat side 17 px (rows 11 to 28), edges at the notch's slope, flat side on column 18: 0.27 of the way from box to
// centroid centring, near the master's 0.35. Walls 8 left, 6.8 right, 6.6 under (a 16 px play on 18 looked left).
{
  const x0 = 10, x1 = 38, yT = 41, N = 9, cx = 24, s = N / 14;
  const pH = 17, pW = (pH / 2) / s, pX = 18, pCy = 19.5;
  const lip = 3, rib = poly([[x0, lip], [x1, lip], [x1, yT], [cx, yT - N], [x0, yT]]);
  const pl = poly([[pX, pCy - pH / 2], [pX + pW, pCy], [pX, pCy + pH / 2]]);
  write('cut-48.svg', cut(48, rib + pl, 'r1 at 48 px: ribbon 28 px from under a 3 px lip of tile, tips on row 41, notch 9 px deep; play 17 px tall (rows 11 to 28) with its edges at the notch slope, flat side on column 18.'));
}
// 32 px (1 px = 2.25 dp). Ribbon 18 px (7..25), notch 6 deep over 9 (slope 2/3). Play 12 px (rows 6 to 18), a little
// larger than the master's 10.7 so it holds on a 2x toolbar; 9 px deep, flat side on column 12, which is the master's
// 0.33 between box and centroid centring. Walls 5 left, 4 right, 4.7 under. (A 10 px play on 12 sat left of centre.)
{
  const x0 = 7, x1 = 25, yT = 27, N = 6, cx = 16, s = N / 9;
  const pH = 12, pW = (pH / 2) / s, pX = 12, pCy = 12;
  const lip = 2, rib = poly([[x0, lip], [x1, lip], [x1, yT], [cx, yT - N], [x0, yT]]);
  const pl = poly([[pX, pCy - pH / 2], [pX + pW, pCy], [pX, pCy + pH / 2]]);
  write('cut-32.svg', cut(32, rib + pl, 'r1 at 32 px: ribbon 18 px from under a 2 px lip, tips on row 27, notch 6 px deep; play 12 px tall (rows 6 to 18) at the notch slope, flat side on column 12.'));
}
// 16 px (1 px = 4.5 dp). Ribbon 8 px (4..12), tips on row 14 (the master's 79 dp is 13.6), notch 4 deep at 45 degrees
// as in shared/brand/src/small.svg, so it survives. The play is a 3 x 5 staircase (rows of 1, 2, 3, 2, 1 px), whose
// steps are also 45 degrees, so the 16 px cut keeps the rhyme. Its flat side is on column 7: the staircase's centroid
// then sits on the ribbon's centre line (column 6 looked a pixel left). Rows 4 to 8 put its centre at 47 dp, as on
// the master, with 2 px of paper down to the notch.
{
  const rib = poly([[4, 1], [12, 1], [12, 14], [8, 10], [4, 14]]); // 1 px lip
  const px = 7, py = 4; // top-left pixel of the play
  const pl = poly([[px, py], [px + 1, py], [px + 1, py + 1], [px + 2, py + 1], [px + 2, py + 2], [px + 3, py + 2], [px + 3, py + 3],
    [px + 2, py + 3], [px + 2, py + 4], [px + 1, py + 4], [px + 1, py + 5], [px, py + 5]]);
  write('cut-16.svg', cut(16, rib + pl, 'r1 at 16 px: ribbon 8 px from under a 1 px lip, tips on row 14, notch 4 px at 45 degrees; play a 3 x 5 pixel staircase, flat side on column 7.'));
}
// glyph, 24 px, white on transparent: no tile to hang from, so the whole bookmark with its shoulders (r 2), 16 px wide
// so the play can be 10 px and still read at 18 px; play at the notch slope, flat side on column 8 (on column 9 it
// looked a pixel right: walls 4 and 4.3 here against 5 and 3.3).
{
  const bm = g.bookmark({ cx: 12, top: 2, w: 16, h: 20, rTop: 2 });
  const s = TAN, pH = 10, pW = (pH / 2) / s, pX = 8, pCy = 10;
  const pl = poly([[pX, pCy - pH / 2], [pX + pW, pCy], [pX, pCy + pH / 2]]);
  write('glyph-24.svg', g.svg(24, `<path fill="${WHITE}" fill-rule="evenodd" d="${bm + pl}"/>`, 'r1 glyph: the whole bookmark, 16 px wide (no tile to hang from), with the play cut out.'));
}
console.log(JSON.stringify({ M, walls }, null, 1));
