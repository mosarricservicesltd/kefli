// s2 · Forked tail. Writes mark.svg, cut-48.svg, cut-32.svg, cut-16.svg and glyph-24.svg next to this file.
//   node build.mjs
// Shelf's bookmark with its notch carried up the centre line as a slot, so the tail forks into two legs under a
// whole head. The slot has s1's width; HEAD sets how much of the bookmark stays joined.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAPER = '#F3F2EE';

export const P = {
  W: 42,          // bookmark width, dp
  GAP: 0.15,      // the slot's width as a share of W, the same as s1's cut
  HEAD: 0.4,      // the joined head, as a share of the bookmark's height (top edge to the sharp tips). Below about
                  // 0.33 the shape reads as a Π, a gate or trousers; 0.4 is the deepest that still reads as the bookmark
  CY: 54,
  rEnd: null,     // radius of the slot's two top corners (null = the tip radius)
};

export function drawnHeight(W) {
  const k = W / 34, h = 42 * k, notch = 11 * k, r = 1.5 * k;
  const corner = Math.PI / 2 - Math.atan2(notch, W / 2);
  return h - r / Math.tan(corner / 2) + r;
}

export function master(p = P) {
  const k = p.W / 34, rTop = 4 * k, rTip = 1.5 * k, h = 42 * k, notch = 11 * k;
  const top = p.CY - drawnHeight(p.W) / 2;
  const x0 = 54 - p.W / 2, x1 = 54 + p.W / 2, y1 = top + h, apex = y1 - notch, slope = notch / (p.W / 2);
  const gp = p.GAP * p.W, xl = 54 - gp / 2, xr = 54 + gp / 2;
  const yCut = apex + (gp / 2) * slope, ySlot = top + p.HEAD * h;
  const re = p.rEnd ?? rTip;
  const d = g.roundedPolygon(
    [[x0, top], [x1, top], [x1, y1], [xr, yCut], [xr, ySlot], [xl, ySlot], [xl, yCut], [x0, y1]],
    [rTop, rTop, rTip, rTip, re, re, rTip, rTip]);
  return { d, top, y1, apex, ySlot, gp };
}

// tuned cuts: bookmark box, the slot's edges (gl, gr), where it meets the notch (yCut) and its top (ySlot)
export const CUTS = {
  48: { x0: 10, x1: 38, top: 7, tip: 41, gl: 22, gr: 26, yCut: 33, ySlot: 21, rTop: 3 },
  32: { x0: 6, x1: 26, top: 4, tip: 28, gl: 14, gr: 18, yCut: 23, ySlot: 14, rTop: 2 },
  16: { x0: 3, x1: 13, top: 2, tip: 14, gl: 7, gr: 9, yCut: 11, ySlot: 7, rTop: 1 },
};
export const GLYPH = { x0: 4, x1: 20, top: 2, tip: 22, gl: 11, gr: 13, yCut: 17, ySlot: 10, rTop: 2 };

export function cutPath(c) {
  return g.roundedPolygon(
    [[c.x0, c.top], [c.x1, c.top], [c.x1, c.tip], [c.gr, c.yCut], [c.gr, c.ySlot], [c.gl, c.ySlot], [c.gl, c.yCut], [c.x0, c.tip]],
    [c.rTop, c.rTop, 0, 0, 0, 0, 0, 0]);
}

export function files(p = P, cuts = CUTS, glyph = GLYPH) {
  const m = master(p), out = {};
  out['mark.svg'] = g.svg(108, `<path fill="${PAPER}" d="${m.d}"/>`,
    `s2 Forked tail. Shelf's bookmark, ${p.W} dp wide, its notch carried up the centre line as a ${g.fmt(m.gp)} dp slot (s1's cut) that stops ${p.HEAD} of the height below the top edge. Built by build.mjs.`);
  for (const n of [48, 32, 16]) {
    const c = cuts[n];
    out[`cut-${n}.svg`] = g.svg(n, `${g.tileRect(n)}\n  <path fill="${PAPER}" d="${cutPath(c)}"/>`,
      `s2 at ${n} px: bookmark ${c.x1 - c.x0} x ${c.tip - c.top} px, slot ${c.gr - c.gl} px wide from the notch up to y = ${c.ySlot}. Built by build.mjs.`);
  }
  out['glyph-24.svg'] = g.svg(24, `<path fill="#FFFFFF" d="${cutPath(glyph)}"/>`,
    `s2 glyph: bookmark ${glyph.x1 - glyph.x0} x ${glyph.tip - glyph.top} px, slot ${glyph.gr - glyph.gl} px wide up to y = ${glyph.ySlot}. Built by build.mjs.`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [f, s] of Object.entries(files())) fs.writeFileSync(path.join(HERE, f), s);
  const m = master();
  console.log('s2 written; master top', g.fmt(m.top), 'slot top', g.fmt(m.ySlot), 'apex', g.fmt(m.apex), 'gap', g.fmt(m.gp));
}
