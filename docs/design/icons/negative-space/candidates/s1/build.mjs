// s1 · Split bookmark. Writes mark.svg, cut-48.svg, cut-32.svg, cut-16.svg and glyph-24.svg next to this file.
//   node build.mjs            (from this folder or any other: paths are relative to this file)
// Every number that shapes the drawing is in P (the master) or in the cut tables below.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAPER = '#F3F2EE';

// ---- the master, 108 dp canvas -------------------------------------------------------------------------------
// Shelf's bookmark at width W (all proportions from geom.BOOKMARK: h 42/34, notch 11/34, shoulders 4/34, tips 1.5/34),
// cut down the centre line by a gap of GAP x W.
export const P = {
  W: 42,          // bookmark width, dp (today's is 34; ref-solid 40.1). 42 keeps the reach at 32.0 of the 33 dp safe radius
  GAP: 0.15,      // the cut, as a share of W. The app's own pause button (Lucide pause filled at 1.75 stroke: bars 5.75, gap 2.25)
                  // has 0.164; 0.15 is a hair narrower so the bookmark leads and the pause follows
  CY: 54,         // the drawn box (top edge to the rounded tips) is centred on this line
  rCut: null,     // radius of the four corners the cut makes (null = the tip radius, 1.5/34 of W: a cut edge, nearly sharp)
};

export function master(p = P) {
  const k = p.W / 34, rTop = 4 * k, rTip = 1.5 * k, h = 42 * k, notch = 11 * k;
  const rCut = p.rCut ?? rTip;
  // the drawn box: the tips' arcs end a little above the sharp tip line; measure once at top = 0
  const top = p.CY - drawnHeight(p.W) / 2;
  const x0 = 54 - p.W / 2, x1 = 54 + p.W / 2, y1 = top + h, apex = y1 - notch, slope = notch / (p.W / 2);
  const gp = p.GAP * p.W, xl = 54 - gp / 2, xr = 54 + gp / 2;
  const yCut = apex + (gp / 2) * slope; // where the cut meets the notch: each half keeps its half of the slope
  const left = g.roundedPolygon([[x0, top], [xl, top], [xl, yCut], [x0, y1]], [rTop, rCut, rCut, rTip]);
  const right = g.roundedPolygon([[xr, top], [x1, top], [x1, y1], [xr, yCut]], [rCut, rTop, rTip, rCut]);
  return { d: g.join(left, right), top, y1, apex, gp, x0, x1 };
}
export function drawnHeight(W) {
  // From the top edge to the lowest point of the rounded tips. The tip's arc meets the side edge t above the sharp
  // tip, its centre is r in from the side at that height, and the arc passes through its own lowest point (the notch
  // edge rises away from the tip), so the drawn bottom is r below the centre: h - t + r.
  const k = W / 34, h = 42 * k, notch = 11 * k, r = 1.5 * k;
  const corner = Math.PI / 2 - Math.atan2(notch, W / 2); // the tip's interior angle
  const t = r / Math.tan(corner / 2);
  return h - t + r;
}

// ---- the tuned cuts: one unit = one pixel -------------------------------------------------------------------
// Each cut: the bookmark's box (x0..x1, top..tip), the gap's edges, the y where the cut meets the notch, the
// shoulder radius. Edges on whole pixels; the only diagonals are the two halves of the notch.
export const CUTS = {
  48: { x0: 10, x1: 38, top: 7, tip: 41, gl: 22, gr: 26, yCut: 33, rTop: 3, rCut: 0 },
  32: { x0: 6, x1: 26, top: 4, tip: 28, gl: 14, gr: 18, yCut: 23, rTop: 2, rCut: 0 },
  16: { x0: 3, x1: 13, top: 2, tip: 14, gl: 7, gr: 9, yCut: 11, rTop: 1, rCut: 0 },
};
export const GLYPH = { x0: 4, x1: 20, top: 2, tip: 22, gl: 11, gr: 13, yCut: 17, rTop: 2, rCut: 0 };

export function halves(c) {
  const L = g.roundedPolygon([[c.x0, c.top], [c.gl, c.top], [c.gl, c.yCut], [c.x0, c.tip]], [c.rTop, c.rCut, c.rCut, 0]);
  const R = g.roundedPolygon([[c.gr, c.top], [c.x1, c.top], [c.x1, c.tip], [c.gr, c.yCut]], [c.rCut, c.rTop, 0, c.rCut]);
  return g.join(L, R);
}

export function files(p = P, cuts = CUTS, glyph = GLYPH) {
  const m = master(p);
  const out = {};
  out['mark.svg'] = g.svg(108, `<path fill="${PAPER}" fill-rule="evenodd" d="${m.d}"/>`,
    `s1 Split bookmark. Shelf's bookmark, ${p.W} dp wide, cut down its centre line by a ${g.fmt(m.gp)} dp gap (${p.GAP} of the width, the proportion of the app's own pause button). Each half keeps its half of the notch. Built by build.mjs.`);
  for (const n of [48, 32, 16]) {
    const c = cuts[n];
    out[`cut-${n}.svg`] = g.svg(n, `${g.tileRect(n)}\n  <path fill="${PAPER}" d="${halves(c)}"/>`,
      `s1 at ${n} px: bookmark ${c.x1 - c.x0} x ${c.tip - c.top} px, gap ${c.gr - c.gl} px, each half's notch edge from (${c.x0}, ${c.tip}) to (${c.gl}, ${c.yCut}). Built by build.mjs.`);
  }
  const c = glyph;
  out['glyph-24.svg'] = g.svg(24, `<path fill="#FFFFFF" d="${halves(c)}"/>`,
    `s1 glyph: bookmark ${c.x1 - c.x0} x ${c.tip - c.top} px inside the 20 px live area, gap ${c.gr - c.gl} px. Built by build.mjs.`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = files();
  for (const [f, s] of Object.entries(out)) fs.writeFileSync(path.join(HERE, f), s);
  const m = master();
  console.log('s1 written; master top', g.fmt(m.top), 'tips', g.fmt(m.y1), 'apex', g.fmt(m.apex), 'gap', g.fmt(m.gp));
}
