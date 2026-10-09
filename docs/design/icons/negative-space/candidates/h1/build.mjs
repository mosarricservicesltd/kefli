// h1 · The tail plays. Writes mark.svg, cut-48.svg, cut-32.svg, cut-16.svg and glyph-24.svg.
// Run from anywhere: node build.mjs
//
// The idea in one line: Shelf's notch flanks run at atan(11/17) = 32.9 degrees, and the app's own play icon (Lucide's
// 6 3 20 12 6 21 triangle, 14 deep and 18 tall) has flanks at 32.7. So the notch already holds a play: carry the
// notch's right flank straight on, through the apex, to the bookmark's left edge, and the paper under that line on
// the left, the bookmark's own left tail, is a play triangle pointing at the apex. One straight cut and no hole.
//
// Every drawing below is the same construction:
//   body  = shoulders, right side, right tip, then the line L (the right flank carried on) up to the left edge;
//   play  = the left edge, L lowered by the cut, the left flank down to the left tip.
// The play's top edge is L moved down by `cutV` (measured vertically); its bottom edge is the notch's own left flank,
// so the two edges are mirror images and the play is always isosceles, with its axis level with its tip.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAPER = '#F3F2EE', WHITE = '#FFFFFF';
const out = (f, s) => fs.writeFileSync(path.join(HERE, f), s);
const f3 = g.fmt;

// The shape on any grid. x0, x1: the sides; top: the top edge; y1: the sharp tip line; notch: apex above the tips;
// cutV: how far L is lowered for the play's top edge (vertical); radii as named.
function tailPlay({ x0, x1, top, y1, notch, cutV, rTop, rTip, rCut = rTip, rPlay = rTip }) {
  const half = (x1 - x0) / 2, s = notch / half;           // the flanks' slope
  const yL = y1 - 2 * notch;                              // L meets the left edge
  const body = g.roundedPolygon([[x0, top], [x1, top], [x1, y1], [x0, yL]], [rTop, rTop, rTip, rCut]);
  const d = (2 * notch - cutV) / (2 * s);                 // play depth, back to tip
  const tip = [x0 + d, y1 - s * d];
  const play = g.roundedPolygon([[x0, yL + cutV], tip, [x0, y1]], [rPlay, rPlay, rTip]);
  return { d: g.join(body, play), yL, tip, depth: d, height: 2 * notch - cutV, s };
}

// ---------------------------------------------------------------------------------------------------------------
// Master, 108 dp canvas. Today's proportions at 42 dp wide (the solid reference is 40): as big as the safe circle
// allows with about a dp to spare, since the tail tips are the farthest ink.
const W = 42, k = W / 34;
const M = {
  w: W, notch: 11 * k, h: 42 * k, rTop: 4 * k, rTip: 1.5 * k,
  cut: 3.2,          // the cut, measured square to the line (dp): 2 px on the 1x home screen, 12 px at 288
};
// Box-centred like the reference: the rounded tips end 0.84 rTip above the sharp tip line.
M.top = 54 - (M.h - 0.84 * M.rTip) / 2;
{
  const s = 2 * M.notch / M.w, c = Math.cos(Math.atan(s));
  const r = tailPlay({ x0: 54 - W / 2, x1: 54 + W / 2, top: M.top, y1: M.top + M.h, notch: M.notch, cutV: M.cut / c, rTop: M.rTop, rTip: M.rTip });
  M.info = r;
  out('mark.svg', g.svg(108, `<path fill="${PAPER}" fill-rule="evenodd" d="${r.d}"/>`,
    `h1 · The tail plays. Shelf's bookmark, ${W} dp wide in today's proportions (notch ${f3(M.notch)}, shoulders r ${f3(M.rTop)}, tips r ${f3(M.rTip)}), drawn box centred. ` +
    `One cut, ${M.cut} dp wide, carries the notch's right flank straight on through the apex to the left edge; under it the left tail is a play ` +
    `${f3(r.height)} tall and ${f3(r.depth)} deep (0.77, Lucide's play is 0.78), corners r ${f3(M.rTip)} like the tips. Built by build.mjs.`));
}

// ---------------------------------------------------------------------------------------------------------------
// The tuned cuts: one unit = one pixel. Straight edges on whole pixels; the notch, L and the play's flanks are the
// only diagonals. The cut is set by its vertical drop so its ends land on whole pixels.
const CUTS = {
  48: { x0: 10, x1: 38, top: 7, y1: 41, notch: 9, cutV: 4, rTop: 3, rTip: 1,
        note: '28 x 34 px, as the master at 2/3. Notch 9 px (slope 9/14, 32.7 degrees). L runs from the right tip (38, 41) through the apex (24, 32) to the left edge at y 23. The cut drops 4 px (3.4 px square to the line): the play is 14 px tall (27 to 41) and 10.9 deep, its tip at (20.9, 34).' },
  32: { x0: 7, x1: 25, top: 5, y1: 27, notch: 6, cutV: 3, rTop: 2, rTip: 0.75,
        note: '18 x 22 px. Notch 6 px (slope 2/3, 33.7 degrees). L from (25, 27) through the apex (16, 21) to the left edge at y 15. The cut drops 3 px (2.5 px square): the play is 9 px tall (18 to 27) and 6.75 deep.' },
};
for (const [n, p] of Object.entries(CUTS)) {
  const r = tailPlay(p);
  out(`cut-${n}.svg`, g.svg(+n, `${g.tileRect(+n)}<path fill="${PAPER}" fill-rule="evenodd" d="${r.d}"/>`, `h1 at ${n} px. ${p.note}`));
}

// 16 px: drawn in whole pixels. At this size a 33 degree diagonal is a blur and a 1 px cut along it vanishes, so the
// line and the notch become 45 degree stairs (as the brand's own 16 px cut moved its notch to 45 degrees) and the cut a
// 2 px step. The bookmark is 10 x 12 px (3..13, 2..14), shoulders r 1. Body bottom per column, left to right:
// 6 7 8 9 10 | 10 11 12 13 14, so L falls one pixel a column from the left edge at y 6 to the right tip at y 14,
// and the apex sits between columns 7 and 8. Two pixels under it, the play is 6, 4 and 2 px tall in columns 3, 4 and
// 5, centred on y 11, its bottom the notch's left flank in the same stairs.
{
  const shoulders = 'M3 3A1 1 0 0 1 4 2H12A1 1 0 0 1 13 3';
  const bodyStairs = 'V14H12V13H11V12H10V11H9V10H7V9H6V8H5V7H4V6H3Z';
  const play = 'M3 8H4V9H5V10H6V12H5V13H4V14H3Z';
  out('cut-16.svg', g.svg(16, `${g.tileRect(16)}<path fill="${PAPER}" fill-rule="evenodd" d="${shoulders + bodyStairs + play}"/>`,
    'h1 at 16 px, in whole pixels: 10 x 12 px bookmark, L and the notch as 45 degree stairs, a 2 px stepped cut, and a 6/4/2 px play in the corner, centred on y 11.'));
}

// Status-bar and media-notification glyph: white on transparent, inside the central 20 x 20.
{
  const p = { x0: 4, x1: 20, top: 2, y1: 22, notch: 5, cutV: 3, rTop: 2, rTip: 0.5 };
  const r = tailPlay(p);
  out('glyph-24.svg', g.svg(24, `<path fill="${WHITE}" fill-rule="evenodd" d="${r.d}"/>`,
    `h1 glyph. 16 x 20 px inside the 2 px padding. Notch 5 (slope 5/8); L from (20, 22) to the left edge at y 12; the cut drops 3 px (2.5 square), so the play's back starts on a whole pixel at y 15: the play is 7 tall, ${f3(r.depth)} deep.`));
}

console.log(JSON.stringify({ master: { top: f3(M.top), play: { height: f3(M.info.height), depth: f3(M.info.depth), tip: M.info.tip.map(f3) } } }));
