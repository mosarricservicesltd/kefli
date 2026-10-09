// n1 · Classic nest. Shelf's bookmark in paper, the largest equilateral play hole its walls allow, and a paper pause
// island on the play's incircle. Run: node build.mjs (from this folder or with a path to it). Writes mark.svg, the three
// tuned cuts and the status-bar glyph. Every number that shapes the drawing is in M (the master) or in the cut tables.
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
  w: 43.5, top: 27.1,         // the bookmark at Shelf's proportions, as large as the 66 dp safe circle allows (reach 32.5)
  wall: 6,                    // thinnest paper between the play hole and the bookmark's edge
  gx: 51.5, gy: 48.5,         // the play's centroid. 2.5 dp left of the centre line, so the drawn (rounded) play's box
                              // sits 0.5 dp right of it: halfway between centroid and box centring, which is what reads as
                              // centred inside a rectangle (centroid centring alone looks pushed towards the tip)
  ring: 4,                    // dark ring between the pause island and the play's slanted sides
  barAspect: 0.3, gapRatio: 0.9, rBar: 1,   // pause bars: width / height, gap / bar width, corner radius
};
const k = M.w / 34, rTop = 4 * k, rTip = 1.5 * k;
const bk = { x0: 54 - M.w / 2, x1: 54 + M.w / 2, top: M.top, y1: M.top + 42 * k, notch: 11 * k };
const bkPts = [[bk.x0, bk.top], [bk.x1, bk.top], [bk.x1, bk.y1], [54, bk.y1 - bk.notch], [bk.x0, bk.y1]];
const bkR = [rTop, rTop, rTip, 0, rTip];
const BK = sample(bkPts, bkR, 0.1);
const tri = H => { const W = H * Math.sqrt(3) / 2; return [[M.gx - W / 3, M.gy - H / 2], [M.gx + 2 * W / 3, M.gy], [M.gx - W / 3, M.gy + H / 2]]; };
const rPlay = rTop;          // the play's corners take the bookmark's shoulder radius
const H = bisect(h => { const S = sample(tri(h), rPlay, 0.1); return S.every(p => inside(p, BK)) && minDist(S, BK) >= M.wall; }, 20, 46);
const T = tri(H), TS = sample(T, rPlay, 0.08), ic = g.incircle(T);
const bars = hb => { const b = hb * M.barAspect, s = b * M.gapRatio, x0 = ic.cx - s / 2 - b, x1 = ic.cx + s / 2, y = ic.cy - hb / 2; return { b, s, hb, rects: [[x0, y, b, hb], [x1, y, b, hb]] }; };
const rectPts = ([x, y, w, h]) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const hb = bisect(h => bars(h).rects.every(r => { const S = sample(rectPts(r), M.rBar, 0.08); return S.every(p => inside(p, TS)) && minDist(S, TS) >= M.ring; }), 2, 30);
const P = bars(hb);
const flatGap = P.rects[0][0] - T[0][0];
const dMaster = g.join(g.bookmark({ cx: 54, top: M.top, w: M.w }), g.roundedPolygon(T, rPlay), ...P.rects.map(r => g.rect(...r, M.rBar)));
write('mark.svg', g.svg(108, `<path fill="${PAPER}" fill-rule="evenodd" d="${dMaster}"/>`,
  `n1 Classic nest, built by build.mjs. Bookmark ${M.w} dp wide at Shelf's proportions (${f2(42 * k)} dp from the top to the tips' points, about 52 drawn; shoulders r ${f2(rTop)}, tips r ${f2(rTip)}, notch ${f2(bk.notch)}), top at ${M.top}: as large as the 66 dp safe circle allows (reach 32.6 dp).
    Play hole: equilateral, ${f2(H)} dp tall, corners at the shoulder radius, the largest that keeps ${M.wall} dp of paper all round; centroid (${M.gx}, ${M.gy}).
    Pause island: on the play's incircle (r ${f2(ic.r)}), bars ${f2(P.b)} x ${f2(P.hb)} dp with a ${f2(P.s)} dp gap and r ${M.rBar} corners; ${M.ring} dp of dark to the slanted sides, ${f2(flatGap)} dp to the flat side.
    One even-odd path: the bookmark, the play (a hole), the bars (paper again).`));

// ---------------------------------------------------------------------------------------------------------------
// Tuned cuts: one unit = one pixel. Straight edges on whole pixels; the play's sides run at 4:7 (59.5 degrees at the tip,
// within a degree of equilateral), so they cross pixel corners every 7 px.
const tile = n => g.tileRect(n);
const cutSvg = (n, d, comment) => g.svg(n, `${tile(n)}<path fill="${PAPER}" fill-rule="evenodd" d="${d}"/>`, comment);
// bookmark with sharp tips, as the reference cuts draw it
const bkCut = ({ x0, x1, top, y1, apexY, r }) => g.roundedPolygon([[x0, top], [x1, top], [x1, y1], [(x0 + x1) / 2, apexY], [x0, y1]], [r, r, 0, 0, 0]);
// play by its flat side (x), top and bottom (y), tip x; corner radius r
const playCut = ({ x, y0, y1, tip, r }) => g.roundedPolygon([[x, y0], [tip, (y0 + y1) / 2], [x, y1]], r);

const C48 = { bk: { x0: 10, x1: 38, top: 7, y1: 41, apexY: 32, r: 3 }, play: { x: 15, y0: 8.75, y1: 32.75, tip: 36, r: 3 } };
write('cut-48.svg', cutSvg(48, g.join(bkCut(C48.bk), playCut(C48.play)),
  `n1 at 48 px. Bookmark 28 x 34 px (shoulders r 3, notch 9 px, sharp tips), top at 7 so it sits centred. Play 24 x 21 px, its
    flat side on x 15, sides at 4:7, corners r 3: 3.9 px of paper over the top corner and 3.8 px over the notch (even, as on
    the master), 5 px on the left and at the tip. The play's ends sit off the pixel grid, which blurs nothing: it has no level edge.
    The pause is dropped here. This play's incircle has a 7 px radius; take out a 3 px ring and a 3 px gap and the 3 px bars could be
    only about 4 px tall, two squares that would read as a smudge. The bookmark with its play hole is still plainly the same icon.`));

const C32 = { bk: { x0: 6, x1: 26, top: 4, y1: 28, apexY: 21.5, r: 2 }, play: { x: 10, y0: 5.5, y1: 21.5, tip: 24, r: 2 } };
write('cut-32.svg', cutSvg(32, g.join(bkCut(C32.bk), playCut(C32.play)),
  `n1 at 32 px. Bookmark 20 x 24 px (shoulders r 2, notch 6.5 px, sharp tips). Play 16 x 14 px, flat side on x 10, sides at 4:7,
    corners r 2: 4 px walls on the left and at the tip, 3 px over the top corner and over the notch. No pause: 2 px bars 6 px
    tall with a 2 px gap and ring need a play about 21 px tall, more than this bookmark holds with walls like the master's.`));

const C16 = { bk: { x0: 3, x1: 13, top: 2, y1: 14, apexY: 11, r: 1 } };
// the play as whole pixels: columns 7, 5, 3, 1 px tall from x 6, a stepped triangle that stays crisp at 1x
const play16 = 'M6 4H7V5H8V6H9V7H10V8H9V9H8V10H7V11H6Z';
write('cut-16.svg', cutSvg(16, g.join(bkCut(C16.bk), play16),
  `n1 at 16 px. Bookmark 10 x 12 px (shoulders r 1, notch 3 px, sharp tips). Play drawn in whole pixels, columns of 7, 5, 3 and 1
    from x 6 (4 x 7 px), so no edge is a blur; walls of 3 px left, 2 px top, 3 px at the tip and 1 px over the notch's apex.
    No pause.`));

const G24 = { bk: { x0: 4, x1: 20, top: 2, y1: 22, apexY: 17, r: 2 }, play: { x: 8, y0: 4, y1: 16, tip: 18.5, r: 1.5 } };
write('glyph-24.svg', g.svg(24, `<path fill="${WHITE}" fill-rule="evenodd" d="${g.join(bkCut(G24.bk), playCut(G24.play))}"/>`,
  `n1 status-bar glyph, white on transparent; Android reads alpha only, so the play is a real hole. Bookmark 16 x 20 px inside the
    central 20 px (shoulders r 2, notch 5 px). Play 12 px tall, flat side on x 8, corners r 1.5: 3 px of white over the top
    corner and over the notch, 4 px on the left, 3 px past the tip. The pause is left out: the media notification beside it
    already carries play and pause, and a 1 px island would not survive the 18 px the status bar can draw it at.`));

console.log(JSON.stringify({ H: f2(H), W: f2(H * Math.sqrt(3) / 2), ic: { cx: f2(ic.cx), cy: f2(ic.cy), r: f2(ic.r) }, bars: { b: f2(P.b), hb: f2(P.hb), s: f2(P.s) }, flatGap: f2(flatGap) }));
