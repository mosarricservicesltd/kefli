// t2 · Play, then pause. Run from this folder or anywhere: node build.mjs
// t1's sideways bookmark (the notch is the play) with a pause cut through the body after it, so both of Richard's
// symbols are negative space and read in order, left to right: the play the notch makes, then the pause.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] ? path.resolve(process.argv[2]) : HERE;
const OVR = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const PAPER = '#F3F2EE';
const PLAY = 14 / 18;                            // Lucide play: depth over height, as t1

// The bookmark sideways: W wide (its height on the page), the notch D deep, then the body: the apex wall a, two bars
// bw wide with gap gp between them, and the end wall e. Bars stand wall t from the top and bottom edges.
export function parts({ xl, cy, W, D, a, bw, gp, e, t, B, pause = true, rTop = W * 4 / 34, rTip = W * 1.5 / 34, rApex = rTop, rBar = 0 }) {
  const xa = xl + D, x1 = xa + a, x2 = x1 + bw + gp, yt = cy - W / 2, yb = cy + W / 2;
  const xr = pause ? x2 + bw + e : xa + B;      // without the pause (the 16 px cut) the body is t1's
  const outline = { pts: [[xr, yt], [xr, yb], [xl, yb], [xa, cy], [xl, yt]], radii: [rTop, rTop, rTip, rApex, rTip] };
  const bars = pause ? [g.rect(x1, yt + t, bw, W - 2 * t, rBar), g.rect(x2, yt + t, bw, W - 2 * t, rBar)] : [];
  return { outline, bars, L: xr - xl };
}
const draw = p => { const q = parts(p); return g.join(g.roundedPolygon(q.outline.pts, q.outline.radii), ...q.bars); };

// ---- master: 108 dp canvas ----------------------------------------------------------------------------------------
// t1's bookmark exactly (W 37, the notch 14/18 of W, the same corner radii), its body lengthened from 26 to 29.5 to
// hold the pause. The pause is drawn like Shelf's own (Lucide's pause: bars wider than the gap between them): bars
// 7 wide and 25 tall with a 4.5 gap. The walls round it are nearly even, 6 above and below the bars, 5.5 from the
// apex to the first bar and from the last bar to the shoulders; the gap is the narrowest paper on purpose, as in
// any pause glyph. The bars' corners are r 1, the small radius of a pause.
const M = { W: 37, t: 6, a: 5.5, bw: 7, gp: 4.5, e: 5.5, rBar: 1, shift: 0.5, play: PLAY, ...OVR.master };
M.D = M.W * M.play;
{
  const probe = parts({ xl: 0, cy: 0, ...M });
  const c = centroidWithHoles(probe, M), L = probe.L;
  M.xl = 54 - L / 2 - (c - L / 2) * M.shift;
  M.cy = 54;
}

// ---- tuned cuts: one unit = one pixel ---------------------------------------------------------------------------
// As t1: straight edges on whole pixels, the notch at a 2 : 3 staircase, the apex on the centre line between two rows,
// sharp tips. The pause is redrawn for each grid, never shrunk.
//   48: 24 x 39 px; bars 5 x 16, gap 3 (the 3 px minimum), walls 4 above and below, 4 from the apex and to the end.
//   32: 16 x 25 px; bars 3 x 10, gap 2, walls 3 above and below, 2 from the apex, 3 to the end.
//   16: the pause would be 1 px slits that read as stripes, so the 16 px cut drops it and is t1's 16 px drawing.
const CUTS = {
  48: { xl: 4, cy: 24, W: 24, D: 18, a: 4, bw: 5, gp: 3, e: 4, t: 4, rTop: 3, rTip: 0, rApex: 3, ...OVR[48] },
  32: { xl: 3, cy: 16, W: 16, D: 12, a: 2, bw: 3, gp: 2, e: 3, t: 3, rTop: 2, rTip: 0, rApex: 1, ...OVR[32] },
  16: { xl: 2, cy: 8, W: 8, D: 6, B: 5, pause: false, rTop: 1, rTip: 0, rApex: 0, ...OVR[16] },
};
const GLYPH = { xl: 2, cy: 12, W: 14, D: 10, a: 2, bw: 2, gp: 2, e: 2, t: 3, rTop: 1.5, rTip: 0, rApex: 1, ...OVR.glyph };

// ---- write --------------------------------------------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const f = n => g.fmt(n);
fs.writeFileSync(path.join(OUT, 'mark.svg'), g.svg(108, `<path fill="${PAPER}" fill-rule="evenodd" d="${draw(M)}"/>`,
  `t2 · Play, then pause. t1's sideways bookmark (W ${f(M.W)}, notch ${f(M.D)} deep, Lucide's play proportion) with two bars ` +
  `(${f(M.bw)} x ${f(M.W - 2 * M.t)}, gap ${f(M.gp)}) cut through a body ${f(M.a + 2 * M.bw + M.gp + M.e)} long. Built by build.mjs`));
for (const [n, p] of Object.entries(CUTS)) {
  fs.writeFileSync(path.join(OUT, `cut-${n}.svg`), g.svg(+n, `${g.tileRect(+n)}<path fill="${PAPER}" fill-rule="evenodd" d="${draw(p)}"/>`));
}
fs.writeFileSync(path.join(OUT, 'glyph-24.svg'), g.svg(24, `<path fill="#FFFFFF" fill-rule="evenodd" d="${draw(GLYPH)}"/>`));

const q = parts(M);
console.log(JSON.stringify({ W: M.W, D: +M.D.toFixed(2), L: +q.L.toFixed(2), xl: +M.xl.toFixed(2), reach: +polyReach(q.outline.pts, q.outline.radii).toFixed(2) }));

// ---- helpers ------------------------------------------------------------------------------------------------------
function polyArea(P) { let A = 0, X = 0; for (let i = 0; i < P.length; i++) { const [x0, y0] = P[i], [x1, y1] = P[(i + 1) % P.length], c = x0 * y1 - x1 * y0; A += c; X += (x0 + x1) * c; } return { A: A / 2, X: X / 6 }; }
// centroid x (relative to xl = 0) of the outline minus the bars
function centroidWithHoles(p, m) {
  const o = polyArea(p.outline.pts), barA = m.bw * (m.W - 2 * m.t);
  const x1 = m.D + m.a + m.bw / 2, x2 = x1 + m.bw + m.gp;
  const A = Math.abs(o.A) - 2 * barA, X = Math.sign(o.A) * o.X - barA * (x1 + x2);
  return X / A;
}
function polyReach(P, R, cx = 54, cy = 54) {
  const n = P.length; let far = 0;
  for (let i = 0; i < n; i++) {
    const p = P[i], a = P[(i - 1 + n) % n], b = P[(i + 1) % n], r = R[i] || 0;
    if (!r) { far = Math.max(far, Math.hypot(p[0] - cx, p[1] - cy)); continue; }
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const u1 = [(a[0] - p[0]) / la, (a[1] - p[1]) / la], u2 = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb];
    const th = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    let tt = r / Math.tan(th / 2), rr = r; const maxT = Math.min(la, lb) / 2;
    if (tt > maxT) { tt = maxT; rr = tt * Math.tan(th / 2); }
    const bis = [u1[0] + u2[0], u1[1] + u2[1]], bl = Math.hypot(...bis), dc = rr / Math.sin(th / 2);
    const c = [p[0] + bis[0] / bl * dc, p[1] + bis[1] / bl * dc];
    const t1 = [p[0] + u1[0] * tt, p[1] + u1[1] * tt], t2 = [p[0] + u2[0] * tt, p[1] + u2[1] * tt];
    const a1 = Math.atan2(t1[1] - c[1], t1[0] - c[0]), a2 = Math.atan2(t2[1] - c[1], t2[0] - c[0]);
    let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
    for (let s = 0; s <= 64; s++) { const ang = a1 + da * s / 64; far = Math.max(far, Math.hypot(c[0] + rr * Math.cos(ang) - cx, c[1] + rr * Math.sin(ang) - cy)); }
  }
  return far;
}
