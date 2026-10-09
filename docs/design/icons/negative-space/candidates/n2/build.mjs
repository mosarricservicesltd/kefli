// n2 · Bookmark window. The bookmark first: Shelf's bookmark in paper with a smaller play hole set in it like a window, an even,
// generous margin of paper all round, and the paper pause island on the play's incircle, held in a tight dark ring so it
// keeps its size. Run: node build.mjs. Writes mark.svg, the three tuned cuts and the status-bar glyph.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const write = (f, s) => fs.writeFileSync(path.join(HERE, f), s);
const PAPER = '#F3F2EE', WHITE = '#FFFFFF';
const f2 = v => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------
// Measuring: rounded polygons sampled as dense outlines, so walls are measured on the drawn (rounded) shapes.
function sample(pts, radii, step = 0.08) {
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
function dseg(p, a, b) { const vx = b[0] - a[0], vy = b[1] - a[1], wx = p[0] - a[0], wy = p[1] - a[1], L = vx * vx + vy * vy; const t = L ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / L)) : 0; return Math.hypot(wx - t * vx, wy - t * vy); }
function minDist(A, B) { let m = Infinity; for (const p of A) for (let i = 0; i < B.length; i++) { const d = dseg(p, B[i], B[(i + 1) % B.length]); if (d < m) m = d; } return m; }
function inside(p, P) { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c; } return c; }
const bisect = (ok, lo, hi, n = 26) => { for (let i = 0; i < n; i++) { const m = (lo + hi) / 2; if (ok(m)) lo = m; else hi = m; } return lo; };

// ---------------------------------------------------------------------------------------------------------------
// Master, 108 dp canvas
const M = {
  w: 43.5, top: 27.1,         // the bookmark at Shelf's proportions, as large as the safe circle allows (reach 32.5)
  wall: 7.5,                  // paper margin: at least this much paper all round the play (it comes out 7.5 over the notch,
                              // 9 at the top, 10.4 and 10.2 at the sides: the tails add paper either side of the notch)
  gx: 52, gy: 48.5,           // play centroid: 2 dp left of the centre line so the drawn play's box sits on it, and on the
                              // bookmark's visual centre rather than the middle of the body above the notch, which looked high
  ring: 3,                    // dark ring round the pause: tighter than n1's, so the island keeps its size in a smaller play
  barAspect: 0.33, gapRatio: 0.85, rBar: 1,
};
const k = M.w / 34, rTop = 4 * k, rTip = 1.5 * k;
const bk = { x0: 54 - M.w / 2, x1: 54 + M.w / 2, top: M.top, y1: M.top + 42 * k, notch: 11 * k };
const bkPts = [[bk.x0, bk.top], [bk.x1, bk.top], [bk.x1, bk.y1], [54, bk.y1 - bk.notch], [bk.x0, bk.y1]];
const bkR = [rTop, rTop, rTip, 0, rTip];
const BK = sample(bkPts, bkR, 0.1);
const tri = H => { const W = H * Math.sqrt(3) / 2; return [[M.gx - W / 3, M.gy - H / 2], [M.gx + 2 * W / 3, M.gy], [M.gx - W / 3, M.gy + H / 2]]; };
const rPlay = rTop;
const H = bisect(h => { const S = sample(tri(h), rPlay, 0.1); return S.every(p => inside(p, BK)) && minDist(S, BK) >= M.wall; }, 15, 46);
const T = tri(H), TS = sample(T, rPlay, 0.08), ic = g.incircle(T);
const bars = hb => { const b = hb * M.barAspect, s = b * M.gapRatio, x0 = ic.cx - s / 2 - b, x1 = ic.cx + s / 2, y = ic.cy - hb / 2; return { b, s, hb, rects: [[x0, y, b, hb], [x1, y, b, hb]] }; };
const rectPts = ([x, y, w, h]) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const hb = bisect(h => bars(h).rects.every(r => { const S = sample(rectPts(r), M.rBar, 0.08); return S.every(p => inside(p, TS)) && minDist(S, TS) >= M.ring; }), 2, 30);
const P = bars(hb);
const flatGap = P.rects[0][0] - T[0][0];
const leftWall = T[0][0] - bk.x0, tipWall = bk.x1 - (T[1][0] - rPlay);
const dMaster = g.join(g.bookmark({ cx: 54, top: M.top, w: M.w }), g.roundedPolygon(T, rPlay), ...P.rects.map(r => g.rect(...r, M.rBar)));
write('mark.svg', g.svg(108, `<path fill="${PAPER}" fill-rule="evenodd" d="${dMaster}"/>`,
  `n2 Bookmark window, built by build.mjs. Bookmark ${M.w} dp wide at Shelf's proportions (${f2(42 * k)} dp from the top to the tips' points, about 52 drawn; shoulders r ${f2(rTop)}, tips r ${f2(rTip)}, notch ${f2(bk.notch)}), top at ${M.top}: as large as the 66 dp safe circle allows (reach 32.6 dp).
    Play hole: equilateral, ${f2(H)} dp tall, corners at the shoulder radius, sized so at least ${M.wall} dp of paper stays round it
    (${f2(leftWall)} on the left, ${f2(tipWall)} past the drawn tip); centroid (${M.gx}, ${M.gy}).
    Pause island: on the play's incircle (r ${f2(ic.r)}), bars ${f2(P.b)} x ${f2(P.hb)} dp with a ${f2(P.s)} dp gap, r ${M.rBar}; a ${M.ring} dp ring of dark
    to the slanted sides and ${f2(flatGap)} dp to the flat side.`));

// ---------------------------------------------------------------------------------------------------------------
// Tuned cuts: one unit = one pixel. Straight edges on whole pixels; the play's sides at 4:7 (within a degree of equilateral).
const cutSvg = (n, d, comment) => g.svg(n, `${g.tileRect(n)}<path fill="${PAPER}" fill-rule="evenodd" d="${d}"/>`, comment);
const bkCut = ({ x0, x1, top, y1, apexY, r }) => g.roundedPolygon([[x0, top], [x1, top], [x1, y1], [(x0 + x1) / 2, apexY], [x0, y1]], [r, r, 0, 0, 0]);
const playCut = ({ x, y0, y1, tip, r }) => g.roundedPolygon([[x, y0], [tip, (y0 + y1) / 2], [x, y1]], r);

const C48 = { bk: { x0: 10, x1: 38, top: 7, y1: 41, apexY: 32, r: 3 }, play: { x: 17, y0: 10.5, y1: 30.5, tip: 34.5, r: 3 } };
write('cut-48.svg', cutSvg(48, g.join(bkCut(C48.bk), playCut(C48.play)),
  `n2 at 48 px. Bookmark 28 x 34 px (shoulders r 3, notch 9 px, sharp tips). Play 20 x 17.5 px, flat side on x 17, sides at 4:7,
    corners r 3: 7 px of paper on the left, 6.5 px past the tip, 5.7 px over the top corner and 4.8 px over the notch, the
    master's ratio; the play's ends sit on half pixels, which blurs nothing because the play has no level edge. No pause: this
    play's incircle is under 6 px in radius and a 3 px pause with a 3 px ring needs about 9.`));

const C32 = { bk: { x0: 6, x1: 26, top: 4, y1: 28, apexY: 21.5, r: 2 }, play: { x: 11, y0: 6.5, y1: 20.5, tip: 23.25, r: 2 } };
write('cut-32.svg', cutSvg(32, g.join(bkCut(C32.bk), playCut(C32.play)),
  `n2 at 32 px. Bookmark 20 x 24 px (shoulders r 2, notch 6.5 px). Play 14 x 12.25 px, flat side on x 11, sides at 4:7, corners r 2:
    5 px of paper on the left and past the tip, 4 px over the top corner and 3.4 px over the notch. No pause.`));

const C16 = { bk: { x0: 3, x1: 13, top: 2, y1: 14, apexY: 11, r: 1 } };
const play16 = 'M6 4H7V5H8V6H9V7H10V8H9V9H8V10H7V11H6Z';
write('cut-16.svg', cutSvg(16, g.join(bkCut(C16.bk), play16),
  `n2 at 16 px. Bookmark 10 x 12 px (shoulders r 1, notch 3 px). Play in whole pixels, columns of 7, 5, 3 and 1 from x 6, so it
    stays crisp at 1x. No pause.`));

const G24 = { bk: { x0: 4, x1: 20, top: 2, y1: 22, apexY: 17, r: 2 }, play: { x: 8, y0: 4.5, y1: 15.5, tip: 17.6, r: 1.5 } };
write('glyph-24.svg', g.svg(24, `<path fill="${WHITE}" fill-rule="evenodd" d="${g.join(bkCut(G24.bk), playCut(G24.play))}"/>`,
  `n2 status-bar glyph, white on transparent; the play is a real hole. Bookmark 16 x 20 px inside the central 20 (shoulders r 2,
    notch 5 px). Play 11 px tall, flat side on x 8, corners r 1.5, at least 3 px of white round it. No pause.`));

console.log(JSON.stringify({ H: f2(H), W: f2(H * Math.sqrt(3) / 2), leftWall: f2(leftWall), tipWall: f2(tipWall), ic: { cx: f2(ic.cx), cy: f2(ic.cy), r: f2(ic.r) }, bars: { b: f2(P.b), hb: f2(P.hb), s: f2(P.s) }, flatGap: f2(flatGap) }));
