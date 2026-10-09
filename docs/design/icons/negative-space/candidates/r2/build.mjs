// r2 · Split ribbon (pause). node build.mjs: writes the five SVGs next to it.
// Shelf's bookmark hangs from the tile's top edge, and one straight slot runs down its middle from the top edge into
// the notch. The slot is the only negative space: it turns one bookmark into two ribbons, and two bars side by side
// read as pause. The outline is still Shelf's: straight sides, one shared notch.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const write = (f, s) => fs.writeFileSync(path.join(HERE, f), s);
const PAPER = '#F3F2EE', WHITE = '#FFFFFF';
const f = g.fmt;
const TAN = 11 / 17;

// ---------------------------------------------------------------- master, 108 dp canvas
const M = { cx: 54, W: 40, yT: 79, gap: 8 };
M.N = M.W * 11 / 34;
M.rTip = M.W * 1.5 / 34;
M.bar = (M.W - M.gap) / 2;
M.yIn = M.yT - M.N * (1 - M.gap / M.W);   // where the slot's walls meet the notch's edges

function split({ cx, W, yT, gap, N, rTip, top = 0, rTop = 0 }) {
  const x0 = cx - W / 2, x1 = cx + W / 2, yIn = yT - N * (1 - gap / W);
  return g.roundedPolygon([[x0, top], [cx - gap / 2, top], [cx - gap / 2, yIn], [x0, yT]], [rTop, 0, 0, rTip]) +
         g.roundedPolygon([[cx + gap / 2, top], [x1, top], [x1, yT], [cx + gap / 2, yIn]], [0, rTop, rTip, 0]);
}
write('mark.svg', g.svg(108, `<path fill="${PAPER}" d="${split(M)}"/>`,
  `r2, split ribbon. Shelf's bookmark ${M.W} wide from y 0 (off the top of every mask) to tips at ${M.yT}, notch ${f(M.N)} deep, ` +
  `tips r ${f(M.rTip)}; a ${M.gap} slot down the middle from the top edge into the notch leaves two ${M.bar} bars, ` +
  `whose inner bottom corners sit on the notch line at y ${f(M.yIn)}.`));

// ---------------------------------------------------------------- tuned cuts
const poly = pts => 'M' + pts.map(([x, y]) => f(x) + ' ' + f(y)).join('L') + 'Z';
const cut = (n, d, note) => g.svg(n, `${g.tileRect(n)}\n  <path fill="${PAPER}" d="${d}"/>`, note);
// The cuts keep a lip of tile above the bars (3 px at 48, 2 at 32, 1 at 16: the smallest detail each size allows).
// Bled to the edge, the paper bars merged with Chrome's and Firefox's light toolbars, and what was left (the tile's
// sides and the dark slot) read as a bold W. With the lip the tile stays closed and shows two ribbons on any toolbar.
const splitPx = ({ x0, x1, yT, N, gap, lip }) => {
  const cx = (x0 + x1) / 2, s = N / ((x1 - x0) / 2), yIn = yT - N + (gap / 2) * s;
  return poly([[x0, lip], [cx - gap / 2, lip], [cx - gap / 2, yIn], [x0, yT]]) + poly([[cx + gap / 2, lip], [x1, lip], [x1, yT], [cx + gap / 2, yIn]]);
};
write('cut-48.svg', cut(48, splitPx({ x0: 10, x1: 38, yT: 41, N: 9, gap: 6, lip: 3 }), 'r2 at 48 px: ribbon 28 px from under a 3 px lip of tile, tips on row 41, notch 9 px; slot 6 px, bars 11 px.'));
write('cut-32.svg', cut(32, splitPx({ x0: 7, x1: 25, yT: 27, N: 6, gap: 4, lip: 2 }), 'r2 at 32 px: ribbon 18 px from under a 2 px lip, tips on row 27, notch 6 px; slot 4 px, bars 7 px.'));
write('cut-16.svg', cut(16, splitPx({ x0: 4, x1: 12, yT: 13, N: 4, gap: 2, lip: 1 }), 'r2 at 16 px: ribbon 8 px from under a 1 px lip, notch 4 px at 45 degrees; slot 2 px, bars 3 px.'));
{
  // glyph: no tile to hang from, so the whole bookmark with its outer shoulders, split by the slot
  const W = 16, cx = 12, top = 2, yT = 22, N = W * 11 / 34, gap = 4;
  write('glyph-24.svg', g.svg(24, `<path fill="${WHITE}" d="${split({ cx, W, yT, gap, N, rTip: 0, top, rTop: 2 })}"/>`,
    'r2 glyph: the whole bookmark, 16 px wide, with its outer shoulders (no tile to hang from), split by a 4 px slot into two 6 px bars.'));
}
console.log(JSON.stringify(M));
