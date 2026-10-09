// r3 · Ribbon, play, pause: Richard's three levels on the ribbon. node build.mjs: writes the five SVGs next to it.
// Graphite tile, Shelf's bookmark hanging from its top edge in paper, a play cut out of the ribbon, and a paper pause
// left standing inside the play. The ribbon bleeds off the top, so it needs no shoulders and can be wider than a
// free-standing bookmark, which gives the third level the most room the safe circle allows.
// The play's edges are parallel to the notch's (tan 11/17), as in r1.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const write = (f, s) => fs.writeFileSync(path.join(HERE, f), s);
const PAPER = '#F3F2EE', WHITE = '#FFFFFF';
const f = g.fmt;
const TAN = 11 / 17, COS = Math.cos(Math.atan(TAN)), SIN = Math.sin(Math.atan(TAN));

// ---------------------------------------------------------------- master, 108 dp canvas
const M = {
  cx: 54,
  W: 46,          // wider than r1's 40: the tips at (31, 78) and (77, 78) still sit 32.5 from the centre
  yT: 78,
  playH: 31,
  k: 0.3,         // 0 = box centred, 1 = centroid centred
  band: 8,        // paper between the play's lower edge and the notch's left edge, square to both
  ring: 2.4,      // dark between the pause and the play's edges, everywhere it is closest
  barR: 0.8,      // pause bars' corner radius
};
M.N = M.W * 11 / 34; M.rTip = M.W * 1.5 / 34;
M.playW = (M.playH / 2) / TAN;
M.playX = M.cx + M.k * M.playW / 6 - M.playW / 2;
{ const x0 = M.cx - M.W / 2, yEdge = M.yT - (M.playX - x0) * TAN; M.playCy = yEdge - M.band / COS - M.playH / 2; }
// the pause: bars 0.32 of its height wide, gap 0.26, as large as fits with `ring` of dark to the play's flat side and
// slanted edges (the rounded tip is far away). Searched, so changing the play re-fits it.
{
  const xL = M.playX, w = M.playW, h = M.playH, cy = M.playCy;
  const toEdge = (x, y) => ((h / 2) * (w - (x - xL)) / w - Math.abs(y - cy)) * COS; // to the nearer slanted edge
  let best = null;
  for (let ph = 4; ph < h; ph += 0.02) {
    const bw = ph * 0.32, gp = ph * 0.26, pw = 2 * bw + gp, x = xL + M.ring;
    if (toEdge(x + pw, cy - ph / 2) >= M.ring) best = { ph, bw, gp, pw, x };
  }
  M.pause = best;
}
const ribbon = g.bookmark({ cx: M.cx, top: 0, w: M.W, h: M.yT, rTop: 0 });
const play = g.play({ cx: M.playX + M.playW / 2, cy: M.playCy, h: M.playH, w: M.playW, r: M.rTip, at: 'box' });
const P = M.pause;
const pause = g.pause({ cx: P.x + P.pw / 2, cy: M.playCy, barW: P.bw, barH: P.ph, gap: P.gp, r: M.barR });
const walls = { left: M.playX - (M.cx - M.W / 2), right: (M.cx + M.W / 2) - (M.playX + M.playW - (M.rTip / SIN - M.rTip)), band: M.band };
write('mark.svg', g.svg(108, `<path fill="${PAPER}" fill-rule="evenodd" d="${g.join(ribbon, play, pause)}"/>`,
  `r3, ribbon, play, pause. Ribbon ${M.W} wide from y 0 (off the top of every mask) to tips at ${M.yT}, Shelf's notch ` +
  `${f(M.N)} deep, tips r ${f(M.rTip)}. Play hole ${M.playH} tall, ${f(M.playW)} deep, edges parallel to the notch, corners ` +
  `r ${f(M.rTip)}, centred at y ${f(M.playCy)}; walls left ${f(walls.left)}, right ${f(walls.right)}, under ${M.band}. Pause ` +
  `island ${f(P.ph)} tall (bars ${f(P.bw)}, gap ${f(P.gp)}, r ${M.barR}), ${M.ring} of dark to the play's flat side and edges.`));

// ---------------------------------------------------------------- tuned cuts: the pause drops out (under 3 px at 48)
// As in r1, the cuts keep a lip of tile above the ribbon (3 px at 48, 2 at 32, 1 at 16) so the tile stays closed on
// light toolbars, where a bled paper ribbon merges with the toolbar and the tile reads as a dark U.
const poly = pts => 'M' + pts.map(([x, y]) => f(x) + ' ' + f(y)).join('L') + 'Z';
const cut = (n, d, note) => g.svg(n, `${g.tileRect(n)}\n  <path fill="${PAPER}" fill-rule="evenodd" d="${d}"/>`, note);
const tri = (pX, pCy, pH, s) => poly([[pX, pCy - pH / 2], [pX + (pH / 2) / s, pCy], [pX, pCy + pH / 2]]);
const stair = (px, py, rows) => { // a pixel play, top-left pixel (px, py): rows of 1, 2, ..., m, ..., 2, 1 px
  const m = (rows + 1) / 2, pts = [[px, py]];
  for (let i = 0; i < m; i++) pts.push([px + i + 1, py + i], [px + i + 1, py + i + 1]);              // down to the tip row
  for (let i = m - 2; i >= 0; i--) pts.push([px + i + 1, py + rows - i - 1], [px + i + 1, py + rows - i]); // back to the flat side
  pts.push([px, py + rows]);
  return poly(pts);
};
{ // 48: ribbon 30 px (9..39), tips row 40, notch 10 over 15; play 20 px at the notch slope, flat side column 17
  const s = 10 / 15;
  write('cut-48.svg', cut(48, poly([[9, 3], [39, 3], [39, 40], [24, 30], [9, 40]]) + tri(17, 18, 20, s),
    'r3 at 48 px: ribbon 30 px from under a 3 px lip of tile, tips on row 40, notch 10 px; play 20 px tall at the notch slope. The pause would be bars under 3 px, so it drops out.'));
}
{ // 32: ribbon 20 px (6..26), tips row 27, notch 7 over 10; play 14 px (rows 5 to 19), flat side column 12: on 11 it
  // was box centred and looked a pixel left, on 12 it is optically centred (walls 6 and 4)
  const s = 7 / 10;
  write('cut-32.svg', cut(32, poly([[6, 2], [26, 2], [26, 27], [16, 20], [6, 27]]) + tri(12, 12, 14, s),
    'r3 at 32 px: ribbon 20 px from under a 2 px lip, tips on row 27, notch 7 px; play 14 px tall at the notch slope, flat side on column 12; no pause.'));
}
{ // 16: ribbon 10 px (3..13), tips row 14, notch 4 (closer to Shelf's angle than 45 degrees); play a 4 x 7 staircase
  // (rows of 1, 2, 3, 4, 3, 2, 1 px) on columns 6 to 9 and rows 3 to 9: 3 px walls each side, 2 px of paper to the notch
  write('cut-16.svg', cut(16, poly([[3, 1], [13, 1], [13, 14], [8, 10], [3, 14]]) + stair(6, 3, 7),
    'r3 at 16 px: ribbon 10 px from under a 1 px lip, tips on row 14, notch 4 px; play a 4 x 7 pixel staircase; no pause.'));
}
{ // glyph: the whole bookmark (no tile to hang from) with r3's larger play, 11 px, flat side on column 8; the pause
  // would be 1 px mush
  const bm = g.bookmark({ cx: 12, top: 2, w: 16, h: 20, rTop: 2 });
  write('glyph-24.svg', g.svg(24, `<path fill="${WHITE}" fill-rule="evenodd" d="${bm + tri(8, 10.5, 11, TAN)}"/>`,
    'r3 glyph: the whole bookmark, 16 px wide, with an 11 px play cut out; no pause.'));
}
console.log(JSON.stringify({ M, walls }, null, 1));
