// Geometry helpers for the negative-space study. Every function returns SVG path data (a string), so shapes can be
// joined into one compound path and given fill-rule="evenodd" to cut holes. Coordinates are in the file's own units
// (dp on the 108 canvas, pixels on a cut). y grows downwards, as in SVG.
//
//   import * as g from '../../tools/geom.mjs'
//   const d = g.join(g.bookmark({ cx: 54, top: 30, w: 40, h: 48 }), g.play({ cx: 55, cy: 47, h: 20, r: 2 }))
//   fs.writeFileSync('mark.svg', g.svg(108, `<path fill="#F3F2EE" fill-rule="evenodd" d="${d}"/>`))

export const fmt = n => { const v = Math.round(n * 1000) / 1000; return Object.is(v, -0) ? '0' : String(v); };
const P = (x, y) => fmt(x) + ' ' + fmt(y);

// A polygon with each corner rounded by its own radius (0 = sharp). Corners turning the other way from the rest
// (such as the bookmark's notch) get the opposite arc direction automatically. Radii too big for an edge are
// clamped so neighbouring arcs never overlap.
export function roundedPolygon(pts, radii = 0) {
  const n = pts.length, R = Array.isArray(radii) ? radii : pts.map(() => radii);
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const corners = pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n], r = R[i] || 0;
    if (!r) return { t1: p, t2: p, r: 0 };
    const la = len(p, a), lb = len(p, b);
    const u1 = [(a[0] - p[0]) / la, (a[1] - p[1]) / la], u2 = [(b[0] - p[0]) / lb, (b[1] - p[1]) / lb];
    const cos = Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1])), th = Math.acos(cos);
    let t = r / Math.tan(th / 2), rr = r;
    const maxT = Math.min(la, lb) / 2;
    if (t > maxT) { t = maxT; rr = t * Math.tan(th / 2); }
    const cross = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
    return { t1: [p[0] + u1[0] * t, p[1] + u1[1] * t], t2: [p[0] + u2[0] * t, p[1] + u2[1] * t], r: rr, sweep: cross > 0 ? 1 : 0 };
  });
  let d = 'M' + P(...corners[0].t2);
  for (let k = 1; k <= n; k++) {
    const c = corners[k % n];
    d += 'L' + P(...c.t1);
    if (c.r) d += 'A' + fmt(c.r) + ' ' + fmt(c.r) + ' 0 0 ' + c.sweep + ' ' + P(...c.t2);
  }
  return d + 'Z';
}

// Shelf's bookmark (shared/brand/src/foreground.svg): square shoulders, a notched tail. Defaults are today's
// proportions: 34 wide, 42 from the top to the (sharp) tail tips, the notch 11 deep, shoulders r 4, tips r 1.5
// (drawn, the rounded tips end about 40.6 below the top).
// cx: centre line; top: top edge; w, h: width and height to the tail tips; notch: depth of the notch (apex above
// the tips); rTop, rTip, rApex: corner radii. All scale with w unless given.
export const BOOKMARK = { w: 34, h: 42, notch: 11, rTop: 4, rTip: 1.5 };
export function bookmark({ cx = 54, top = 25, w = BOOKMARK.w, h, notch, rTop, rTip, rApex = 0 } = {}) {
  const k = w / BOOKMARK.w;
  h = h == null ? BOOKMARK.h * k : h;
  notch = notch == null ? BOOKMARK.notch * k : notch;
  rTop = rTop == null ? BOOKMARK.rTop * k : rTop;
  rTip = rTip == null ? BOOKMARK.rTip * k : rTip;
  const x0 = cx - w / 2, x1 = cx + w / 2, y1 = top + h;
  return roundedPolygon([[x0, top], [x1, top], [x1, y1], [cx, y1 - notch], [x0, y1]], [rTop, rTop, rTip, rApex, rTip]);
}

// A play triangle pointing right (or 'left', 'up', 'down'). h: length of the flat side; w: depth (default
// equilateral, h * 0.866). Placed by its centroid at (cx, cy) unless at: 'box' (box centre) is given.
export function play({ cx, cy, h, w, r = 0, dir = 'right', at = 'centroid' }) {
  w = w == null ? h * Math.sqrt(3) / 2 : w;
  // right-pointing, flat side at x = 0, tip at x = w; centroid at w / 3, box centre at w / 2
  const ox = at === 'box' ? w / 2 : w / 3;
  let pts = [[0, -h / 2], [w, 0], [0, h / 2]].map(([x, y]) => [x - ox, y]);
  const rot = { right: p => p, left: ([x, y]) => [-x, y], down: ([x, y]) => [-y, x], up: ([x, y]) => [y, -x] }[dir];
  pts = pts.map(rot).map(([x, y]) => [x + cx, y + cy]);
  return roundedPolygon(pts, r);
}

export function rect(x, y, w, h, r = 0) {
  return roundedPolygon([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], r);
}

// two bars centred on (cx, cy)
export function pause({ cx, cy, barW, barH, gap, r = 0 }) {
  const x0 = cx - gap / 2 - barW, x1 = cx + gap / 2;
  return rect(x0, cy - barH / 2, barW, barH, r) + rect(x1, cy - barH / 2, barW, barH, r);
}

export function circle(cx, cy, r) {
  return 'M' + P(cx - r, cy) + 'A' + fmt(r) + ' ' + fmt(r) + ' 0 1 0 ' + P(cx + r, cy) + 'A' + fmt(r) + ' ' + fmt(r) + ' 0 1 0 ' + P(cx - r, cy) + 'Z';
}

// Largest circle inside a triangle (for placing something inside a play shape): returns { cx, cy, r }
export function incircle([A, B, C]) {
  const a = Math.hypot(B[0] - C[0], B[1] - C[1]), b = Math.hypot(A[0] - C[0], A[1] - C[1]), c = Math.hypot(A[0] - B[0], A[1] - B[1]);
  const p = a + b + c, cx = (a * A[0] + b * B[0] + c * C[0]) / p, cy = (a * A[1] + b * B[1] + c * C[1]) / p;
  const s = p / 2, area = Math.sqrt(Math.max(0, s * (s - a) * (s - b) * (s - c)));
  return { cx, cy, r: area / s };
}

export const join = (...ds) => ds.join('');

// An SVG file: size is the viewBox edge (108 for the master, 16/32/48/24 for cuts)
export const svg = (size, body, comment = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">${comment ? `\n  <!-- ${comment} -->` : ''}\n  ${body}\n</svg>\n`;

// The tuned cuts' tile: the full rounded square, corner radius 7/32 of the edge as in shared/brand/src/small*.svg
export const tileRect = n => `<rect width="${n}" height="${n}" rx="${fmt(n * 7 / 32)}" fill="#111112"/>`;
