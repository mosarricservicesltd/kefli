// n3 · One hand. Shelf's bookmark with the largest play hole it can hold, cut at the notch's own angle: the play's two sides
// run parallel to the notch's two diagonals, so every diagonal in the mark shares one angle (32.9 degrees from level).
// Band, top wall, pause bars, the gap between them and the dark ring around them all share one module, 4.1 dp, which is
// 3 px at 48 and 2 px at 32 (on those cuts' bookmarks), so the small cuts are the same drawing on their own grids.
// Run: node build.mjs. Writes mark.svg, cut-48.svg, cut-32.svg, cut-16.svg, glyph-24.svg.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const write = (f, s) => fs.writeFileSync(path.join(HERE, f), s);
const PAPER = '#F3F2EE', WHITE = '#FFFFFF';
const f2 = v => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------------------------------------------
// Measuring helpers (rounded outlines sampled densely, so walls are measured on what is drawn)
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
const rectPts = ([x, y, w, h]) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];

// ---------------------------------------------------------------------------------------------------------------
// The play cut at the notch's angle. Given a bookmark {x0, x1, top, y1, notch} and a slope s (the notch's
// rise over half the width), the play's flat side sits tL from the left edge, its lower side runs parallel to the notch's
// left diagonal at tB, and its rounded top-left corner (radius r) sits tT below the top edge.
function onePlay(bk, s, tL, tB, tT, r) {
  const a = Math.atan(s), xf = bk.x0 + tL, yb = bk.y1 - s * tL - tB / Math.cos(a);
  const beta = Math.PI / 2 - a, bis = (Math.PI / 2 + a) / 2;          // top-left corner angle and its bisector
  const ya = bk.top + tT - (r / Math.sin(beta / 2) * Math.sin(bis) - r);
  const H = yb - ya, W = H / (2 * s);
  return [[xf, ya], [xf + W, ya + H / 2], [xf, yb]];
}

// ---------------------------------------------------------------------------------------------------------------
// Master, 108 dp canvas
const M = {
  w: 43.5, top: 27.1,   // bookmark at Shelf's proportions, as large as the safe circle allows (reach 32.5 dp)
  m: 4.1,               // the module: band over the notch, top wall, bar width, bar gap, ring around the bars. 4.1 dp is
                        // 9.4% of the bookmark's width, which is 3 px on the 48 px cut's 32 px bookmark and 2 px on the
                        // 32 px cut's 22 px one, so master and cuts share one set of proportions
  tL: 6.8,              // left wall: the one wall off the module, set so the play's drawn tip sits as far from the right
                        // edge (6.5) as its flat side does from the left (6.8), which centres the play optically
  rBar: 1,
};
const k = M.w / 34, rTop = 4 * k, rTip = 1.5 * k, slope = 11 / 17;
const bk = { x0: 54 - M.w / 2, x1: 54 + M.w / 2, top: M.top, y1: M.top + 42 * k, notch: 11 * k };
const BK = sample([[bk.x0, bk.top], [bk.x1, bk.top], [bk.x1, bk.y1], [54, bk.y1 - bk.notch], [bk.x0, bk.y1]], [rTop, rTop, rTip, 0, rTip], 0.1);
const rPlay = rTop;
const T = onePlay(bk, slope, M.tL, M.m, M.m, rPlay);
const TS = sample(T, rPlay, 0.08);
const wallMin = minDist(TS, BK), tipWall = bk.x1 - (T[1][0] - (rPlay / Math.sin(Math.atan(slope)) - rPlay));
// bars: module wide, module apart, the left one a module from the flat side; as tall as a module of ring allows
const yc = T[1][1], bx0 = T[0][0] + M.m;
const barRects = hb => [[bx0, yc - hb / 2, M.m, hb], [bx0 + 2 * M.m, yc - hb / 2, M.m, hb]];
const hb = bisect(h => barRects(h).every(r => { const S = sample(rectPts(r), M.rBar, 0.08); return S.every(p => inside(p, TS)) && minDist(S, TS) >= M.m; }), 2, 30);
const ic = g.incircle(T);
const dMaster = g.join(g.bookmark({ cx: 54, top: M.top, w: M.w }), g.roundedPolygon(T, rPlay), ...barRects(hb).map(r => g.rect(...r, M.rBar)));
write('mark.svg', g.svg(108, `<path fill="${PAPER}" fill-rule="evenodd" d="${dMaster}"/>`,
  `n3 One hand, built by build.mjs. Bookmark ${M.w} dp wide at Shelf's proportions (${f2(42 * k)} dp from the top to the tips' points, about 52 drawn; shoulders r ${f2(rTop)}, tips r ${f2(rTip)}, notch ${f2(bk.notch)}), top at ${M.top}: as large as the 66 dp safe circle allows (reach 32.6 dp).
    Play hole cut at the notch's angle: its sides run parallel to the notch's diagonals (11 in 17, 32.9 degrees), so it is
    ${f2(T[2][1] - T[0][1])} dp tall and ${f2(T[1][0] - T[0][0])} deep; corners at the shoulder radius (${f2(rPlay)}).
    Module ${M.m} dp: the paper band over the notch, the top wall, both pause bars, the gap between them and the dark ring round
    them. Left wall ${M.tL} dp and drawn tip ${f2(tipWall)} dp from the right edge, so the play sits optically centred.
    Pause island: bars ${M.m} x ${f2(hb)} dp, r ${M.rBar}, the left bar a module from the flat side (centre ${f2(bx0 + 1.5 * M.m)}, incircle centre ${f2(ic.cx)}).`));

// ---------------------------------------------------------------------------------------------------------------
// Tuned cuts. One unit = one pixel. The module becomes 3, 2 and 1 px. The notch and the play's sides run at 2:3 in every
// cut (33.7 degrees, the master's 32.9 to within a degree), so all four diagonals stay parallel on the pixel grid.
const cutSvg = (n, d, comment) => g.svg(n, `${g.tileRect(n)}<path fill="${PAPER}" fill-rule="evenodd" d="${d}"/>`, comment);
const bkCut = ({ x0, x1, top, y1, notch, r }) => g.roundedPolygon([[x0, top], [x1, top], [x1, y1], [(x0 + x1) / 2, y1 - notch], [x0, y1]], [r, r, 0, 0, 0]);
function cutNest(c) {
  const b = { ...c.bk, notch: (c.bk.x1 - c.bk.x0) / 2 * c.slope };
  const Tc = onePlay(b, c.slope, c.tL, c.band, c.topWall, c.r);
  const parts = [bkCut(b), g.roundedPolygon(Tc, c.r)];
  let bars = null;
  if (c.bars) { const { x, y, w, h, gap } = c.bars; bars = [[x, y, w, h], [x + w + gap, y, w, h]]; parts.push(...bars.map(r => g.rect(...r, c.bars.r || 0))); }
  // report walls and ring for the comment
  const BKc = sample([[b.x0, b.top], [b.x1, b.top], [b.x1, b.y1], [(b.x0 + b.x1) / 2, b.y1 - b.notch], [b.x0, b.y1]], [b.r, b.r, 0, 0, 0], 0.05);
  const TSc = sample(Tc, c.r, 0.05);
  const wall = minDist(TSc, BKc), ring = bars ? Math.min(...bars.map(r => minDist(sample(rectPts(r), 0, 0.05), TSc))) : null;
  const tip = b.x1 - (Tc[1][0] - (c.r / Math.sin(Math.atan(c.slope)) - c.r));
  return { d: g.join(...parts), T: Tc, wall: f2(wall), ring: ring == null ? null : f2(ring), tip: f2(tip), H: f2(Tc[2][1] - Tc[0][1]) };
}

const C48 = { bk: { x0: 8, x1: 40, top: 4, y1: 44, r: 3.5 }, slope: 2 / 3, tL: 5, band: 3, topWall: 3, r: 3.5,
  bars: { x: 16, y: 16, w: 3, h: 9, gap: 3, r: 0 } };
const n48 = cutNest(C48);
write('cut-48.svg', cutSvg(48, n48.d,
  `n3 at 48 px: the master on a 3 px module. Bookmark 32 x 40 px (shoulders r 3.5, sharp tips), notch 10.7 px at 2:3, top at 4
    and tips at 44, so its notched bottom sits a pixel low and it looks centred. Play ${n48.H} px tall with its sides at 2:3, parallel
    to the notch; flat side on x 13 (5 px wall), 3 px band over the notch and under the top edge, drawn tip ${n48.tip} px from the
    right edge; corners r 3.5. Thinnest wall measured ${n48.wall} px. Pause kept: bars 3 x 9 px a 3 px gap apart, on whole pixels
    (x 16 to 25, y 16 to 25), centred on the play's axis, with at least ${n48.ring} px of dark round them.`));

const C32 = { bk: { x0: 5, x1: 27, top: 3, y1: 30, r: 2.5 }, slope: 2 / 3, tL: 3, band: 2, topWall: 2, r: 2.5,
  bars: { x: 10, y: 11, w: 2, h: 6, gap: 2, r: 0 } };
const n32 = cutNest(C32);
write('cut-32.svg', cutSvg(32, n32.d,
  `n3 at 32 px: the master on a 2 px module. Bookmark 22 x 27 px (shoulders r 2.5), notch 7.3 px at 2:3; it fills more of the
    tile than the master does, because at 2 px a pause only fits in a play this big. Play ${n32.H} px tall, flat side on x 8 (3 px
    wall), 2 px band over the notch and under the top, drawn tip ${n32.tip} px from the right edge, corners r 2.5. Thinnest wall
    ${n32.wall} px. Pause kept: bars 2 x 6 px, 2 px apart (x 10 to 16, y 11 to 17), at least ${n32.ring} px of dark round them.`));

// 16 px: the pause goes (1 px bars in a 1 px ring would be a grey smudge); the play is drawn in whole pixels.
const play16 = 'M6 4H7V5H8V6H9V7H10V8H9V9H8V10H7V11H6Z';
const b16 = { x0: 3, x1: 13, top: 2, y1: 14, r: 1, notch: 3 };
write('cut-16.svg', cutSvg(16, g.join(bkCut(b16), play16),
  `n3 at 16 px. Bookmark 10 x 12 px, notch 3 px. The play in whole pixels, columns of 7, 5, 3 and 1 from x 6, so it stays crisp
    at 1x. Here the stepped play's sides are at 45 degrees whatever the master does, so the notch goes back to 3 px, which leaves a
    full pixel of paper between the play and the notch's apex (the 2:3 notch left 0.7). The pause is dropped: at a 1 px module the
    bars, gap and ring would blur into one grey patch. At this size the three nested candidates meet in one drawing.`));

const G24 = { bk: { x0: 4, x1: 20, top: 2, y1: 22, r: 2 }, slope: 2 / 3, tL: 3, band: 2, topWall: 2, r: 1.5 };
const n24 = cutNest(G24);
write('glyph-24.svg', g.svg(24, `<path fill="${WHITE}" fill-rule="evenodd" d="${n24.d}"/>`,
  `n3 status-bar glyph, white on transparent (Android reads alpha only, so the play is a real hole). Bookmark 16 x 20 px in the
    central 20, notch 5.3 px at 2:3. Play ${n24.H} px tall at 2:3, flat side on x 7, 2 px band and top wall, corners r 1.5;
    thinnest wall ${n24.wall} px. No pause: the glyph sits beside the media notification, which already shows play and pause.`));

console.log(JSON.stringify({ master: { H: f2(T[2][1] - T[0][1]), W: f2(T[1][0] - T[0][0]), wallMin: f2(wallMin), tipWall: f2(tipWall), bars: [M.m, f2(hb)], ic: f2(ic.cx), barsCentre: f2(bx0 + 1.5 * M.m) },
  c48: { H: n48.H, wall: n48.wall, ring: n48.ring, tip: n48.tip, T: n48.T.map(p => p.map(f2)) }, c32: { H: n32.H, wall: n32.wall, ring: n32.ring, tip: n32.tip, T: n32.T.map(p => p.map(f2)) }, g24: { H: n24.H, wall: n24.wall, tip: n24.tip } }));
