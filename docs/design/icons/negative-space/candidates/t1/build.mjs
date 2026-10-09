// t1 · The notch plays. Run from this folder or anywhere: node build.mjs
// Shelf's bookmark turned a quarter turn clockwise, tail to the left, so the notch's empty triangle points right and
// is a play. Nothing else is cut. The notch is drawn to the proportions of Shelf's own in-app play icon (Lucide play,
// polygon 6 3 20 12 6 21: 18 tall, 14 deep), so the play the notch makes is the play the player shows.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : HERE;
const OVR = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const PAPER = '#F3F2EE';

// ---- the drawing ---------------------------------------------------------------------------------------------
// Shelf's bookmark, sideways. W is the bookmark's width (its height on the page), D the notch depth from the tips to
// the apex, B the solid body from the apex to the shoulders. Corner radii follow the bookmark: shoulders 4/34 of W,
// tips 1.5/34 of W; the notch's apex (the play's point) takes the shoulder radius, so the play has the corner
// language of the shoulders.
const PLAY = 14 / 18;                           // Lucide play: depth over height
export function sidewaysPts({ xl, cy, W, D, B, rTop = W * 4 / 34, rTip = W * 1.5 / 34, rApex = rTop }) {
  const xr = xl + D + B, yt = cy - W / 2, yb = cy + W / 2;
  return { pts: [[xr, yt], [xr, yb], [xl, yb], [xl + D, cy], [xl, yt]], radii: [rTop, rTop, rTip, rApex, rTip] };
}
const draw = p => { const { pts, radii } = sidewaysPts(p); return g.roundedPolygon(pts, radii); };

// ---- master: 108 dp canvas -------------------------------------------------------------------------------------
const M = { W: 37, B: 26, shift: 0.65, play: PLAY, ...OVR.master };
M.D = M.W * M.play;
{
  // horizontal placement: the notch takes weight from the left, so the mark's mass sits right of its box centre.
  // The box is moved left by `shift` of that difference (0 = box centred, 1 = centroid centred).
  const probe = sidewaysPts({ xl: 0, cy: 0, ...M });
  const c = centroid(probe.pts), L = M.D + M.B;
  M.xl = 54 - L / 2 - (c.x - L / 2) * M.shift;
  M.cy = 54;
}
const master = draw(M);

// ---- tuned cuts: one unit = one pixel ---------------------------------------------------------------------------
// Each cut is drawn on its own grid: straight edges on whole pixels, the notch's diagonals at a 2 : 3 slope (two
// down for three across, D/W = 0.75, the nearest clean staircase to the play's 0.78), the apex on the tile's centre
// line between two pixel rows so the notch rasterises symmetrically. The tips are left sharp: at these sizes the
// master's 1.5/34 rounding would only shorten the prongs by two or three soft pixels. The body behind the apex is
// the master's at each scale, so the mark keeps the master's placement: the box sits a pixel or two left of centre,
// because the notch takes weight from the left.
//   48: 24 x 34 px, notch 18, shoulders r 3, the apex r 3 (the master's 4.35 dp is 2.9 px here).
//   32: 16 x 23 px, notch 12, shoulders r 2, apex r 1.
//   16: 8 x 11 px, notch 6, shoulders r 1, apex sharp; 2 px left of it, 3 px right.
const CUTS = {
  48: { xl: 6, cy: 24, W: 24, D: 18, B: 16, rTop: 3, rTip: 0, rApex: 3, ...OVR[48] },
  32: { xl: 4, cy: 16, W: 16, D: 12, B: 11, rTop: 2, rTip: 0, rApex: 1, ...OVR[32] },
  16: { xl: 2, cy: 8, W: 8, D: 6, B: 5, rTop: 1, rTip: 0, rApex: 0, ...OVR[16] },
};
// The status-bar glyph: 14 x 20 px in the 20 px content box, the notch 11 deep (11/14 = 0.79, the play's ratio), its
// apex on a whole pixel column so it stays crisp.
const GLYPH = { xl: 2, cy: 12, W: 14, D: 11, B: 9, rTop: 1.5, rTip: 0, rApex: 1.5, ...OVR.glyph };

// ---- write --------------------------------------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const f = n => g.fmt(n);
fs.writeFileSync(path.join(OUT, 'mark.svg'), g.svg(108, `<path fill="${PAPER}" d="${master}"/>`,
  `t1 · The notch plays. Shelf's bookmark on its side, tail to the left: W ${f(M.W)}, notch ${f(M.D)} deep (14/18 of W, ` +
  `Lucide's play), body ${f(M.B)} behind the apex; shoulders r ${f(M.W * 4 / 34)}, tips r ${f(M.W * 1.5 / 34)}, apex r ` +
  `${f(M.W * 4 / 34)}. Tips at x ${f(M.xl)}, centred on y 54. Built by build.mjs`));
for (const [n, p] of Object.entries(CUTS)) {
  fs.writeFileSync(path.join(OUT, `cut-${n}.svg`), g.svg(+n, `${g.tileRect(+n)}<path fill="${PAPER}" d="${draw(p)}"/>`));
}
fs.writeFileSync(path.join(OUT, 'glyph-24.svg'), g.svg(24, `<path fill="#FFFFFF" d="${draw(GLYPH)}"/>`));

// report
const { pts, radii } = sidewaysPts(M);
console.log(JSON.stringify({ W: +M.W.toFixed(2), D: +M.D.toFixed(2), B: M.B, L: +(M.D + M.B).toFixed(2), xl: +M.xl.toFixed(2),
  reach: +polyReach(pts, radii).toFixed(2), centroidX: +centroid(pts).x.toFixed(2) }));

// ---- helpers ------------------------------------------------------------------------------------------------------
function centroid(P) {
  let A = 0, X = 0, Y = 0;
  for (let i = 0; i < P.length; i++) {
    const [x0, y0] = P[i], [x1, y1] = P[(i + 1) % P.length], c = x0 * y1 - x1 * y0;
    A += c; X += (x0 + x1) * c; Y += (y0 + y1) * c;
  }
  return { x: X / (3 * A), y: Y / (3 * A) };
}
// the drawn outline's farthest point from the canvas centre (samples each rounded corner's arc)
function polyReach(P, R, cx = 54, cy = 54) {
  const n = P.length; let far = 0;
  for (let i = 0; i < n; i++) {
    const p = P[i], a = P[(i - 1 + n) % n], b = P[(i + 1) % n], r = R[i] || 0;
    if (!r) { far = Math.max(far, Math.hypot(p[0] - cx, p[1] - cy)); continue; }
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const u1 = [(a[0] - p[0]) / la, (a[1] - p[1]) / la], u2 = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb];
    const th = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    let t = r / Math.tan(th / 2), rr = r; const maxT = Math.min(la, lb) / 2;
    if (t > maxT) { t = maxT; rr = t * Math.tan(th / 2); }
    const bis = [u1[0] + u2[0], u1[1] + u2[1]], bl = Math.hypot(...bis), dc = rr / Math.sin(th / 2);
    const c = [p[0] + bis[0] / bl * dc, p[1] + bis[1] / bl * dc];
    const t1 = [p[0] + u1[0] * t, p[1] + u1[1] * t], t2 = [p[0] + u2[0] * t, p[1] + u2[1] * t];
    const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]), a2 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    for (let s = 0; s <= 64; s++) { const ang = a1 + da * s / 64; far = Math.max(far, Math.hypot(c[0] + rr * Math.cos(ang) - cx, c[1] + rr * Math.sin(ang) - cy)); }
  }
  return far;
}
