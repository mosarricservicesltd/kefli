// s3 · Notch-echo pause. Writes mark.svg, cut-48.svg, cut-32.svg, cut-16.svg and glyph-24.svg next to this file.
//   node build.mjs
// A solid bookmark with two holes. Each hole is a pause bar whose bottom runs parallel to its half of the notch, so
// the paper under the pause is a chevron of even width, the tail's own shape repeated inside the body.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAPER = '#F3F2EE';

// ---- the master, 108 dp canvas -------------------------------------------------------------------------------
export const P = {
  W: 42,          // bookmark width, dp
  CY: 54,         // the drawn box (top edge to the rounded tips) is centred on this line
  side: 11,       // paper from the bookmark's side edges to the holes (thinner walls turn the bookmark into a frame)
  top: 10.5,      // paper above the holes
  band: 9,        // paper between the holes and the notch, measured square to the notch edge
  spine: 4,       // paper between the two holes: the pause's gap, half a hole wide, as tight as the app's own pause
  rHole: null,    // hole corner radius (null = the tip radius, 1.5/34 of W)
};

export function drawnHeight(W) {
  const k = W / 34, h = 42 * k, notch = 11 * k, r = 1.5 * k;
  const corner = Math.PI / 2 - Math.atan2(notch, W / 2);
  return h - r / Math.tan(corner / 2) + r;
}

export function master(p = P) {
  const k = p.W / 34, rTip = 1.5 * k, h = 42 * k, notch = 11 * k;
  const top = p.CY - drawnHeight(p.W) / 2;
  const x0 = 54 - p.W / 2, y1 = top + h, slope = notch / (p.W / 2);
  const cos = Math.cos(Math.atan(slope));
  const notchY = x => y1 - (x - x0) * slope;              // the left half of the notch edge
  const xo = x0 + p.side, xi = 54 - p.spine / 2;          // left hole's outer and inner edges
  const yt = top + p.top;
  const yb = x => notchY(x) - p.band / cos;               // the hole's bottom, parallel to the notch edge
  const r = p.rHole ?? rTip;
  const m = x => 108 - x;
  const L = g.roundedPolygon([[xo, yt], [xi, yt], [xi, yb(xi)], [xo, yb(xo)]], r);
  const R = g.roundedPolygon([[m(xi), yt], [m(xo), yt], [m(xo), yb(xo)], [m(xi), yb(xi)]], r);
  const book = g.bookmark({ cx: 54, top, w: p.W });
  return { d: g.join(book, L, R), top, y1, apex: y1 - notch, hole: { xo, xi, yt, ybi: yb(xi), ybo: yb(xo) } };
}

// ---- the tuned cuts: one unit = one pixel -------------------------------------------------------------------
// bookmark box x0..x1, top..tip, notch apex; each hole: outer and inner x, top, bottom at the inner and outer edge.
export const CUTS = {
  48: { x0: 10, x1: 38, top: 7, tip: 41, apex: 32, rTop: 3, xo: 17, xi: 22, ht: 14, hbi: 26, hbo: 29 },
  32: { x0: 6, x1: 26, top: 4, tip: 28, apex: 22, rTop: 2, xo: 11, xi: 15, ht: 9, hbi: 18, hbo: 20 },
  16: { x0: 3, x1: 13, top: 2, tip: 14, apex: 11, rTop: 1, xo: 5, xi: 7, ht: 4, hbi: 9, hbo: 9 },   // flat: a 1 px slant only blurs
};
export const GLYPH = { x0: 4, x1: 20, top: 2, tip: 22, apex: 17, rTop: 2, xo: 7, xi: 11, ht: 6, hbi: 15, hbo: 17 };

export function cutPath(c) {
  const cx = (c.x0 + c.x1) / 2, m = x => 2 * cx - x;
  const book = g.roundedPolygon([[c.x0, c.top], [c.x1, c.top], [c.x1, c.tip], [cx, c.apex], [c.x0, c.tip]], [c.rTop, c.rTop, 0, 0, 0]);
  const L = g.roundedPolygon([[c.xo, c.ht], [c.xi, c.ht], [c.xi, c.hbi], [c.xo, c.hbo]], 0);
  const R = g.roundedPolygon([[m(c.xi), c.ht], [m(c.xo), c.ht], [m(c.xo), c.hbo], [m(c.xi), c.hbi]], 0);
  return g.join(book, L, R);
}

export function files(p = P, cuts = CUTS, glyph = GLYPH) {
  const mm = master(p), out = {};
  out['mark.svg'] = g.svg(108, `<path fill="${PAPER}" fill-rule="evenodd" d="${mm.d}"/>`,
    `s3 Notch-echo pause. Shelf's bookmark, ${p.W} dp wide, with two pause holes: walls ${p.side} at the sides and ${p.top} on top, a ${p.spine} dp spine between them, and their bottoms parallel to the notch ${p.band} dp above it. Built by build.mjs.`);
  for (const n of [48, 32, 16]) {
    const c = cuts[n];
    out[`cut-${n}.svg`] = g.svg(n, `${g.tileRect(n)}\n  <path fill="${PAPER}" fill-rule="evenodd" d="${cutPath(c)}"/>`,
      `s3 at ${n} px: bookmark ${c.x1 - c.x0} x ${c.tip - c.top} px; holes ${c.xi - c.xo} px wide, side walls ${c.xo - c.x0}, spine ${2 * ((c.x0 + c.x1) / 2 - c.xi)}, top wall ${c.ht - c.top}. Built by build.mjs.`);
  }
  out['glyph-24.svg'] = g.svg(24, `<path fill="#FFFFFF" fill-rule="evenodd" d="${cutPath(glyph)}"/>`,
    `s3 glyph: bookmark ${glyph.x1 - glyph.x0} x ${glyph.tip - glyph.top} px; holes ${glyph.xi - glyph.xo} px wide. Built by build.mjs.`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [f, s] of Object.entries(files())) fs.writeFileSync(path.join(HERE, f), s);
  const m = master();
  console.log('s3 written; master top', g.fmt(m.top), 'apex', g.fmt(m.apex), 'hole', JSON.stringify(Object.fromEntries(Object.entries(m.hole).map(([k, v]) => [k, g.fmt(v)]))));
}
