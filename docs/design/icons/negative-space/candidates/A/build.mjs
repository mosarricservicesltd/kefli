// A · Play. Shelf's bookmark with one hole: the play, cut from the notch. Run: node build.mjs (from any folder).
//
// The shared construction for the matched pair A and B lives here, and B's build imports it, so the two can only
// differ where B adds its pause. Both are cut from the shared bookmark (../base: MASTER and CUTS), never redrawn.
//
// The play is the notch turned to point forward. Split the notch down its axis into two right triangles (17 across,
// 11 up, in the bookmark's 34 units) and join them along their long legs: the flat side is twice the notch's depth,
// the depth is half the bookmark's width, and both slanted edges run parallel to the notch and are as long. Its depth
// is height x 17/22, which is the app's own play (Lucide, 14 over 18) to within half a degree.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as g from '../../tools/geom.mjs';
import { MASTER, CUTS, atScale } from '../base/build.mjs';

export const PAPER = '#F3F2EE', WHITE = '#FFFFFF';
export const f2 = v => Math.round(v * 100) / 100;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------------------------
// The shared bookmark in numbers (geom.bookmark at MASTER), and the cuts' bookmarks read back from CUTS.
const K = MASTER.w / 34;
export const BOOK = {
  x0: MASTER.cx - MASTER.w / 2, x1: MASTER.cx + MASTER.w / 2, cx: MASTER.cx, top: MASTER.top,
  tips: MASTER.top + 42 * K, apex: MASTER.top + 31 * K, rTop: 4 * K, rTip: 1.5 * K, slope: 11 / 17,
};
// CUTS[n] is 'M{x0+r} {top}H{x1-r}A{r} {r} 0 0 1 {x1} {top+r}V{tips}L{cx} {apex}L{x0} {tips}V...Z'
export function cutBook(key) {
  const m = CUTS[key].match(/^M([\d.]+) ([\d.]+)H([\d.]+)A([\d.]+) [\d.]+ 0 0 1 ([\d.]+) [\d.]+V([\d.]+)L([\d.]+) ([\d.]+)L([\d.]+) [\d.]+V/);
  if (!m) throw new Error('unexpected CUTS[' + key + ']');
  const [, , top, , r, x1, tips, cx, apex, x0] = m.map(Number);
  return { d: CUTS[key], x0, x1, cx, top, tips, apex, r, slope: (tips - apex) / (cx - x0) };
}

// ---------------------------------------------------------------------------------------------------------------
// The corner rule, one for every corner in A and B: corners are matched by angle. The play's corners are as acute as
// the tail tips (57 degrees at the back, the tips' own angle, and 66 at the point), so they take the tips' radius, 1.5/34
// of the bookmark's width (1.92 dp). Right angles take the shoulders' 4/34: of the bookmark's width at the shoulders,
// of a bar's width on the pause. On the cuts the same radii are scaled to the cut's bookmark.
export const R_PLAY = BOOK.rTip;
export const rBar = b => b * 4 / 34;

// A play pointing right whose slanted edges run parallel to a notch of the given slope: depth = (height / 2) / slope.
// xl: flat side; ym: axis; h: flat side's length.
export function notchPlay(xl, ym, h, slope = BOOK.slope) {
  const w = h / 2 / slope;
  return { xl, ym, h, w, yt: ym - h / 2, yb: ym + h / 2, pts: [[xl, ym - h / 2], [xl + w, ym], [xl, ym + h / 2]] };
}
// How far the drawn (rounded) play sits inside its sharp corners
export function playInset(slope, r) {
  const half = Math.atan(slope), back = Math.PI / 2 - half;
  return { tip: r / Math.sin(half) - r, top: r / Math.tan(back / 2) - r };
}
// Walls of a play in a bookmark b ({x0, x1, top, tips, apex, slope}): flat side, drawn tip, drawn top, and the strap,
// the paper between the play's lower edge and the notch's left edge, measured square to them (they are parallel)
export function walls(b, p, r) {
  const ins = playInset(b.slope, r), n = Math.hypot(1, b.slope);
  const notchAt = x => b.tips - b.slope * (x - b.x0);                      // y of the notch's left edge at x
  return { flat: p.xl - b.x0, tip: b.x1 - (p.xl + p.w - ins.tip), top: p.yt + ins.top - b.top, strap: (notchAt(p.xl) - p.yb) / n };
}

// ---------------------------------------------------------------------------------------------------------------
// Measuring on the drawn shapes: rounded polygons sampled densely, then the least distance between outlines.
export function outline(pts, radii, step = 0.05) {
  const n = pts.length, R = Array.isArray(radii) ? radii : pts.map(() => radii), out = [];
  const cs = pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n], r = R[i] || 0;
    if (!r) return { t1: p, t2: p, r: 0 };
    const la = Math.hypot(a[0] - p[0], a[1] - p[1]), lb = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const u1 = [(a[0] - p[0]) / la, (a[1] - p[1]) / la], u2 = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb];
    const th = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])));
    let t = r / Math.tan(th / 2), rr = r; const mx = Math.min(la, lb) / 2; if (t > mx) { t = mx; rr = t * Math.tan(th / 2); }
    const bx = u1[0] + u2[0], by = u1[1] + u2[1], bl = Math.hypot(bx, by), dc = rr / Math.sin(th / 2);
    return { t1: [p[0] + u1[0] * t, p[1] + u1[1] * t], t2: [p[0] + u2[0] * t, p[1] + u2[1] * t], r: rr, c: [p[0] + bx / bl * dc, p[1] + by / bl * dc] };
  });
  const seg = (a, b) => { const k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step)); for (let i = 0; i < k; i++) out.push([a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k]); };
  for (let i = 0; i < n; i++) {
    const c = cs[i];
    if (c.r) {
      const a0 = Math.atan2(c.t1[1] - c.c[1], c.t1[0] - c.c[0]); let da = Math.atan2(c.t2[1] - c.c[1], c.t2[0] - c.c[0]) - a0;
      while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
      const k = Math.max(2, Math.ceil(Math.abs(da) * c.r / step));
      for (let j = 0; j < k; j++) out.push([c.c[0] + c.r * Math.cos(a0 + da * j / k), c.c[1] + c.r * Math.sin(a0 + da * j / k)]);
    }
    seg(c.t2, cs[(i + 1) % n].t1);
  }
  return out;
}
export function gap(A, B) {   // least distance between two sampled outlines (point to point, both dense)
  let m = Infinity;
  for (const p of A) for (const q of B) { const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2; if (d < m) m = d; }
  return Math.sqrt(m);
}
export const bookPts = b => [[b.x0, b.top], [b.x1, b.top], [b.x1, b.tips], [b.cx, b.apex], [b.x0, b.tips]];
export const polyArea = P => Math.abs(P.reduce((s, p, i) => { const q = P[(i + 1) % P.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

// a play in whole pixels: x of the flat side, top row, column heights from the flat side to the tip
export function pixelPlay(x, top, cols) {
  const mid = top + cols[0] / 2; let d = 'M' + x + ' ' + top, last = top;
  cols.forEach((hh, i) => { const t = mid - hh / 2; if (i && t !== last) d += 'V' + t; last = t; d += 'H' + (x + i + 1); });
  for (let i = cols.length - 1; i >= 0; i--) { const b = mid + cols[i] / 2; if (b !== last) d += 'V' + b; last = b; d += 'H' + (x + i); }
  return d + 'Z';
}
export const pathEl = (d, fill = PAPER) => `<path fill="${fill}" fill-rule="evenodd" d="${d}"/>`;

// ---------------------------------------------------------------------------------------------------------------
// A's master. The play is exactly the notch's size: flat side 2 x 11 units (28.15 dp), depth 17 units (21.75 dp).
export const A = {
  h: 2 * 11 * K,
  ym: 49.8,      // axis: 2.9 dp below the middle of the body (top to apex), the same axis as B's play
  flat: 12.2,    // paper at the flat side; the drawn tip then sits 11.2 from the right edge, which reads as equal
};
export const playA = () => notchPlay(BOOK.x0 + A.flat, A.ym, A.h);

// ---------------------------------------------------------------------------------------------------------------
// The cuts, shared by A and B wherever B has no pause. One unit = one pixel; each play is parallel to its own cut's notch.
export const CUT = {
  // 48: the notch is 9 over 14, so the folded notch is 18 x 14 px; flat side on x 18 (8 px of paper, 7 at the tip).
  // Axis on y 21, a pixel boundary: the corners land on y 12 and 30 and the two slanted edges rasterise as mirror
  // images (on y 21.1 they stepped differently). That leaves 6 px above and a 4.9 px strap, the master's 7.6 dp at this scale
  48: { xl: 18, ym: 21, h: 18 },
  // 32: notch 6.5 over 10. The folded notch (13 x 10) on x 11 leaves 5 px at the flat side and 5.7 past the tip and
  // looks pushed left; on x 12 it looks pushed right. Half a pixel taller (13.5 x 10.4) evens it on x 11. This
  // bookmark's body is 0.7 px shorter than the master's at this scale, so the axis (y 14) gives 4 px above and a 3.35 px strap
  32: { xl: 11, ym: 14, h: 13.5 },
  // glyph: notch 5 over 8. The folded notch (10 x 8) on x 8 sits left (4 px at the flat side, 4.6 past the tip);
  // a pixel taller (11 x 8.8) evens it. Axis on y 10.5, the middle of a pixel row: the corners land on y 5 and 16 and
  // the rows either side of the tip are mirror images (on y 10.7 the tip hooked down). 3.6 px above, a 3 px strap
  glyph: { xl: 8, ym: 10.5, h: 11 },
};
// 16: whole pixels, p1's play: columns of 5, 3, 3 and 1 from x 6 on rows 4 to 8, 2 px of paper above and over the apex
export const PLAY16 = pixelPlay(6, 4, [5, 3, 3, 1]);

export function cutPlay(key) {
  const b = cutBook(key), c = CUT[key], s = (key === 'glyph' ? 16 : b.x1 - b.x0) / MASTER.w;
  const p = notchPlay(c.xl, c.ym, c.h, b.slope), r = R_PLAY * (b.x1 - b.x0) / MASTER.w;
  return { b, p, r, d: g.roundedPolygon(p.pts, r), walls: walls(b, p, r), scale: s };
}

export function writeShared(dir, label = 'A, and B without its pause,') {
  const out = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  const notes = {};
  for (const n of [48, 32]) {
    const c = cutPlay(n);
    out(`cut-${n}.svg`, g.svg(n, g.tileRect(n) + pathEl(g.join(c.b.d, c.d)),
      `${label} at ${n} px: the shared bookmark (base) with the play cut parallel to this cut's notch, ${c.p.h} x ${f2(c.p.w)} px, corners r ${f2(c.r)}; ` +
      `walls ${f2(c.walls.flat)} px at the flat side, ${f2(c.walls.tip)} at the tip, ${f2(c.walls.top)} above, strap ${f2(c.walls.strap)} along the notch`));
    notes[n] = c.walls;
  }
  out('cut-16.svg', g.svg(16, g.tileRect(16) + pathEl(g.join(CUTS[16], PLAY16)),
    `${label} at 16 px: the shared bookmark with the play in whole pixels, columns of 5, 3, 3 and 1 from x 6 on rows 4 to 8; ` +
    `3 px of paper at the flat side and past the tip, 2 above and 2 over the notch's apex`));
  const c = cutPlay('glyph');
  out('glyph-24.svg', g.svg(24, pathEl(g.join(CUTS.glyph, c.d), WHITE),
    `${label} status-bar glyph, white on transparent: the shared bookmark (16 x 20) with the play, ${c.p.h} x ${f2(c.p.w)} px, corners r ${f2(c.r)}; ` +
    `walls ${f2(c.walls.flat)} at the flat side, ${f2(c.walls.tip)} at the tip, ${f2(c.walls.top)} above, strap ${f2(c.walls.strap)}`));
  notes.glyph = c.walls;
  return notes;
}

// ---------------------------------------------------------------------------------------------------------------
function buildA() {
  const out = (f, s) => fs.writeFileSync(path.join(HERE, f), s);
  const p = playA(), w = walls(BOOK, p, R_PLAY);
  const BK = outline(bookPts(BOOK), [BOOK.rTop, BOOK.rTop, BOOK.rTip, 0, BOOK.rTip], 0.05), PL = outline(p.pts, R_PLAY, 0.05);
  const least = gap(BK, PL);
  const d = g.join(g.bookmark(MASTER), g.roundedPolygon(p.pts, R_PLAY));
  out('mark.svg', g.svg(108, atScale(pathEl(d)),
    `A Play, built by build.mjs. The shared bookmark (base: 43.5 dp wide, top at 27.1), shown at 90%. Play hole: the notch turned forward, ` +
    `${f2(p.h)} x ${f2(p.w)} dp, slanted edges parallel to the notch and as long; corners r ${f2(R_PLAY)}, the tail tips' radius. ` +
    `Axis at y ${p.ym}. Walls: ${f2(w.flat)} at the flat side, ${f2(w.tip)} at the drawn tip, ${f2(w.top)} above, strap ${f2(w.strap)} along the notch (least ${f2(least)}).`));
  const cuts = writeShared(HERE);
  const info = { master: { h: f2(p.h), w: f2(p.w), xl: f2(p.xl), ym: p.ym, r: f2(R_PLAY), walls: Object.fromEntries(Object.entries(w).map(([k, v]) => [k, f2(v)])), least: f2(least),
    holeOfBookmarkPct: f2(100 * polyArea(p.pts) / polyArea(bookPts(BOOK))) },
    cuts: Object.fromEntries(Object.entries(cuts).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([a, b]) => [a, f2(b)]))])) };
  console.log(JSON.stringify(info));
  return info;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) buildA();
