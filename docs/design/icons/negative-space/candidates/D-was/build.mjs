// D · Split and play. C's split bookmark (candidates/C) with h1's tail cut (candidates/h1): two straight cuts of the
// same width. C's slot down the centre line makes the halves a pause; a second cut carries the notch's right flank
// straight on through the apex, across the left half to the left edge, and the left tail under it is a play.
// Writes mark.svg, cut-48.svg, cut-32.svg, cut-16.svg, glyph-24.svg and meta.json next to this file:
//   node candidates/D/build.mjs
// meta.json quotes the sheet's softness, so after `node tools/sheet.mjs candidates/D` run the build again.
// draw(opt) returns the files for any option set, so studies can render variants without touching this folder.
//
// D takes everything C draws from C's build: the master's numbers (masterGeom), the pixel cuts' bookmarks and slots
// (draw's info), the right half at the master and at 48 px (C's paths exactly) and the whole 16 px cut. D only cuts
// the left half. At 32 px D's notch slope is 2/3 where C's is 0.65, so there the right half is redrawn on 2/3.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';
import { MASTER, CUTS } from '../base/build.mjs';
import * as C from '../C/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAPER = '#F3F2EE';

export const OPT = {
  cut: 1,                          // the diagonal cut's width, square to it, in slots (1: as wide as the slot)
  c48: { cutV: 6 },                // the diagonal's vertical drop in px, so both its ends land on whole pixels
  c32: { cutV: 4, slope: 2 / 3 },  // slope: the notch line for this cut ('C' keeps C's 0.65)
  c16: { mode: 'split', cutV: 2 }, // 'split': C's 16 px cut; 'play': whole-pixel stairs and a 6/4/2 play (studies)
  glyph: { mode: 'plain' },        // 'plain': the shared bookmark, as C; 'play' and 'split' for the media-card study
};
// The glyph cut as D, for media-card.mjs and the numbers meta.json quotes about it (a study: D ships the plain glyph)
export const GLYPH_STUDY = { mode: 'play', slot: 2, cutV: 3 };

const f = g.fmt, r2 = v => Math.round(v * 100) / 100, n2 = v => f(r2(v));
const frac = v => [[9, 14], [2, 3], [5, 8], [11, 17]].map(([p, q]) => (Math.abs(v - p / q) < 1e-9 ? p + '/' + q : null)).find(Boolean) ?? n2(v);
const subpaths = d => d.split('Z').filter(Boolean).map(s => s + 'Z');
// a polygon on whole pixels (no rounding), with repeated and collinear points dropped
function poly(pts) {
  const p = [];
  for (const q of pts) { const l = p[p.length - 1]; if (!l || l[0] !== q[0] || l[1] !== q[1]) p.push(q); }
  const keep = p.filter((q, i) => {
    const a = p[(i - 1 + p.length) % p.length], b = p[(i + 1) % p.length];
    return (q[0] - a[0]) * (b[1] - q[1]) - (q[1] - a[1]) * (b[0] - q[0]) !== 0;
  });
  return 'M' + keep.map(q => f(q[0]) + ' ' + f(q[1])).join('L') + 'Z';
}

// ---- the master -----------------------------------------------------------------------------------------------
// C's numbers: the bookmark (x0, x1, top, y1 the sharp tip line, apex, slope 11/17), the slot (xl, xr: 1/7 of the
// width), radii rTop (4/34) and rTip (1.5/34). L is the notch's right flank carried on: y = apex + (x - cx) * slope.
// The left half's upper piece ends on L; the cut lies under it, `cut` wide square to L (cv measured vertically); the
// play's top edge is L lowered by cv and its bottom edge is the notch's left flank, so it is isosceles with
// depth = height / (2 * slope) = height x 17/22, the folded notch's shape (A and B), whatever the cut's width.
export function masterGeom(o = OPT) {
  const m = C.masterGeom(C.OPT);
  const s = m.slope, sec = Math.hypot(1, s);
  const yL = x => m.apex + (x - m.cx) * s;
  const cut = o.cut * m.gap, cv = cut * sec;
  const H = 2 * m.notch - cv, depth = H / (2 * s);
  const tip = [m.x0 + depth, m.y1 - s * depth];
  const inset = m.rTip / Math.sin(Math.atan(s)) - m.rTip;  // the rounded tip ends this far inside the sharp one
  return { ...m, s, sec, yL, cut, cv, H, depth, tip, inset, yLl: yL(m.x0), yLs: yL(m.xl),
    gapSharp: m.xl - tip[0], gapDrawn: m.xl - tip[0] + inset };
}
export function master(o = OPT) {
  const m = masterGeom(o);
  const [leftC, rightC] = subpaths(C.master(C.OPT).d);   // C's two halves; D keeps the right one exactly
  const upper = g.roundedPolygon([[m.x0, m.top], [m.xl, m.top], [m.xl, m.yLs], [m.x0, m.yLl]], [m.rTop, m.rTip, m.rTip, m.rTip]);
  const play = g.roundedPolygon([[m.x0, m.yLl + m.cv], m.tip, [m.x0, m.y1]], m.rTip);
  return { ...m, leftC, rightC, upper, play, d: upper + play + rightC };
}

// ---- the pixel cuts -------------------------------------------------------------------------------------------
// C's cut at size n (bookmark, slot, and its two halves as drawn), with D's left half: the upper piece ending on the
// right foot's line carried on, the cut under it (cutV px, vertical), and the play. Cut corners are sharp.
// n = 24 is the glyph drawn split and played (only for studies: D's glyph is the plain bookmark), on C's split glyph.
export function cutGeom(n, o = OPT) {
  const { info } = C.draw(n === 24 ? { ...C.OPT, glyph: { mode: 'split', slot: o.glyph.slot ?? 2, feet: 'base' } } : C.OPT);
  const cc = info.cuts[n], co = n === 24 ? o.glyph : o['c' + n];
  const [leftC, rightC] = subpaths(cc.d);
  const { x0, x1, top, tip: ty, r, xl, xr, slot } = cc;
  const slope = co.slope && co.slope !== 'C' ? co.slope : cc.slope, sec = Math.hypot(1, slope);
  const yL = x => ty - (x1 - x) * slope;                   // the right foot's line, carried on
  const H = ty - yL(x0) - co.cutV, depth = H / (2 * slope);
  const tip = [x0 + depth, ty - slope * depth];
  return { n, x0, x1, top, ty, r, xl, xr, slot, slope, sec, yL, cutV: co.cutV, cut: co.cutV / sec, H, depth, tip,
    gap: xl - tip[0], yLl: yL(x0), yLs: yL(xl), yCut: yL(xr), leftC, rightC, cSlope: cc.slope,
    playPts: [[x0, yL(x0) + co.cutV], tip, [x0, ty]] };
}
function cutPath(c) {
  // the right half: C's, unless this cut changes the notch's slope (then the same polygon on the new slope)
  const right = c.slope === c.cSlope ? c.rightC
    : g.roundedPolygon([[c.xr, c.top], [c.x1, c.top], [c.x1, c.ty], [c.xr, c.yCut]], [0, c.r, 0, 0]);
  const upper = g.roundedPolygon([[c.x0, c.top], [c.xl, c.top], [c.xl, c.yLs], [c.x0, c.yLl]], [c.r, 0, 0, 0]);
  const play = g.roundedPolygon(c.playPts, 0);
  return upper + play + right;
}

// 16 px in whole pixels. C's 16 px cut is 9 x 12 (x 3 to 12) with a 1 px slot and 45 degree stairs for feet, so
// column x of the right half ends at y = x + 3 and column x of the left half at y = 17 - x. The 'play' study carries
// the right foot's stairs on across the left half (its upper piece ends at y = x + 3), lowers them by cutV for the
// play's top, and keeps C's left foot as the play's bottom. D uses 'split': C's cut as it is.
export function cut16(o = OPT) {
  const { info } = C.draw(C.OPT);
  const cc = info.cuts[16], co = o.c16;
  const [, rightC] = subpaths(cc.d);
  if (co.mode === 'split') return { ...cc, mode: 'split', d: cc.d };
  const { x0, x1, top, tip: ty, r, xl } = cc;
  const foot = x => ty - (x1 - 1 - x);          // the right foot's stair carried on: bottom of column x
  const flank = x => ty - (x - x0);             // C's left foot: bottom of column x
  const upperPts = [[x0, top], [xl, top]];
  for (let x = xl - 1; x >= x0; x--) upperPts.push([x + 1, foot(x)], [x, foot(x)]);
  const cols = [];
  for (let x = x0; x < xl; x++) { const t = foot(x) + co.cutV, b = flank(x); if (t < b) cols.push([x, t, b]); }
  const playPts = [];
  for (const [x, t] of cols) playPts.push([x, t], [x + 1, t]);
  for (const [x, , b] of [...cols].reverse()) playPts.push([x + 1, b], [x, b]);
  const upper = g.roundedPolygon(upperPts, upperPts.map((p, i) => (i === 0 ? r : 0)));
  const tipX = cols[cols.length - 1][0] + 1;
  return { ...cc, mode: 'play', cutV: co.cutV, cols: cols.map(([, t, b]) => b - t), tipX, gap: xl - tipX,
    d: upper + poly(playPts) + rightC };
}

// ---- measuring: outlines sampled from path data, pixel coverage by 32 x 32 supersampling ---------------------------
// (16 x 16 put the 1x home screen's faint pixel at 5%; exact polygon clipping gives 4.2%, and 32 x 32 agrees)
function sample(d, step = 0.05) {   // path data with M, L, A (circular) and Z, as geom writes it
  const t = d.match(/[MLAZ]|-?\d*\.?\d+(?:e-?\d+)?/g), pts = [];
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0;
  const num = () => +t[i++];
  const line = (x2, y2) => { const k = Math.max(1, Math.ceil(Math.hypot(x2 - x, y2 - y) / step)); for (let j = 1; j <= k; j++) pts.push([x + (x2 - x) * j / k, y + (y2 - y) * j / k]); x = x2; y = y2; };
  while (i < t.length) {
    if (/[MLAZ]/.test(t[i])) cmd = t[i++];
    if (cmd === 'M') { x = sx = num(); y = sy = num(); pts.push([x, y]); cmd = 'L'; }
    else if (cmd === 'L') line(num(), num());
    else if (cmd === 'A') {
      const r = num(); i += 3; const sw = num(), x2 = num(), y2 = num();
      const dx = x2 - x, dy = y2 - y, q = Math.hypot(dx, dy), h = Math.sqrt(Math.max(0, r * r - q * q / 4)), s = sw ? 1 : -1;
      const cx = (x + x2) / 2 - s * h * dy / q, cy = (y + y2) / 2 + s * h * dx / q, a0 = Math.atan2(y - cy, x - cx);
      let da = Math.atan2(y2 - cy, x2 - cx) - a0;
      if (sw && da < 0) da += 2 * Math.PI; if (!sw && da > 0) da -= 2 * Math.PI;
      const k = Math.max(2, Math.ceil(Math.abs(da) * r / step));
      for (let j = 1; j <= k; j++) pts.push([cx + r * Math.cos(a0 + da * j / k), cy + r * Math.sin(a0 + da * j / k)]);
      x = x2; y = y2;
    } else if (cmd === 'Z') line(sx, sy);
  }
  return pts;
}
const inside = (P, x, y) => { let c = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
// share of pixel (px, py) that is paper, on a grid where pixel = (unit - off) * k
const cover = (P, px, py, k = 1, off = 0, S = 32) => { let n = 0; for (let a = 0; a < S; a++) for (let b = 0; b < S; b++) if (inside(P, (px + (a + .5) / S) / k + off, (py + (b + .5) / S) / k + off)) n++; return n / (S * S); };
const least = (A, B) => { let m = Infinity; for (const p of A) for (const q of B) m = Math.min(m, (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2); return Math.sqrt(m); };
// The gap between the play's tip and the slot as the pixels show it: the last column the play touches (12% paper or
// more, the sheet's own threshold) in the rows through its tip, and how much clear width is left before the slot.
function clearBefore(P, xl, tipY, k = 1, off = 0) {
  const slotPx = (xl - off) * k, row = Math.floor((tipY - off) * k), cols = [];
  for (let c = Math.floor(slotPx) - 6; c < Math.ceil(slotPx); c++) cols.push([c, Math.max(...[row - 1, row, row + 1].map(rw => cover(P, c, rw, k, off)))]);
  const last = Math.max(...cols.filter(([, v]) => v >= 0.12).map(([c]) => c));
  const faint = Math.max(0, ...cols.filter(([c]) => c > last).map(([, v]) => v));
  return { slotPx, last, clear: slotPx - last - 1, faintPct: Math.round(faint * 100) };
}
export function measure(info, o = OPT) {
  const m = info.master, k1 = 48 / 72, P = sample(m.play, 0.02);
  const thin = master({ ...o, cut: o.cut * 0.95 }), thinP = sample(thin.play, 0.02);
  const tb = clearBefore(thinP, thin.xl, thin.tip[1], k1, 18), tRow = Math.floor((thin.tip[1] - 18) * k1);
  const out = {
    at1x: clearBefore(P, m.xl, m.tip[1], k1, 18),             // a 1x home screen shows the 72 dp viewport at 48 px
    thinner: { cut: 0.95, ...tb, lastPct: Math.round(100 * Math.max(...[-1, 0, 1].map(d => cover(thinP, tb.last, tRow + d, k1, 18)))) },
    upperPlay: least(sample(m.upper), sample(m.play)), playRight: least(sample(m.play), sample(m.rightC)),
    H075: masterGeom({ ...o, cut: 0.75 }).H, cuts: {},
  };
  for (const n of [48, 32]) { const c = info.cuts[n]; out.cuts[n] = clearBefore(c.playPts, c.xl, c.tip[1]); }
  return out;
}

// ---- files ----------------------------------------------------------------------------------------------------
export function draw(o = OPT) {
  const m = master(o), out = {}, info = { master: m, cuts: {} };
  out['mark.svg'] = g.svg(108, `<path fill="${PAPER}" fill-rule="evenodd" d="${m.d}"/>`,
    `D Split and play: C's split bookmark (candidates/C: the shared bookmark, ${MASTER.w} dp wide, top ${MASTER.top}, slot ${n2(m.gap)} dp, 1/7 of the width) ` +
    `with a second cut ${n2(m.cut)} dp wide square to the notch's right flank carried on; the play under it is ${n2(m.H)} x ${n2(m.depth)} dp, ` +
    `its drawn tip ${n2(m.gapDrawn)} dp short of the slot. Built by build.mjs.`);
  for (const n of [48, 32]) {
    const c = cutGeom(n, o);
    info.cuts[n] = c;
    out[`cut-${n}.svg`] = g.svg(n, `${g.tileRect(n)}<path fill="${PAPER}" fill-rule="evenodd" d="${cutPath(c)}"/>`,
      `D at ${n} px: C's ${c.x1 - c.x0} x ${c.ty - c.top} px bookmark and ${c.slot} px slot, ${c.slope === c.cSlope ? `C's notch line (slope ${frac(c.slope)})` : `the notch at slope ${frac(c.slope)} where C keeps ${n2(c.cSlope)}`}; the diagonal drops ${f(c.cutV)} px (${n2(c.cut)} square to it); ` +
      `play ${n2(c.H)} x ${n2(c.depth)} px, its sharp tip ${n2(c.gap)} px short of the slot. Built by build.mjs.`);
  }
  const c16 = cut16(o);
  info.cuts[16] = c16;
  out['cut-16.svg'] = c16.mode === 'split'
    // C's file with D's comment: the drawing is C's, byte for byte
    ? C.draw(C.OPT).out['cut-16.svg'].replace(/<!--[\s\S]*?-->/, '<!-- D at 16 px: C\'s 16 px cut, the split alone (9 x 12 px, 1 px slot, 45 degree stairs); the second cut and the play drop at this size. Built by build.mjs. -->')
    : g.svg(16, `${g.tileRect(16)}<path fill="${PAPER}" fill-rule="evenodd" d="${c16.d}"/>`,
      `D at 16 px, whole pixels (study): C's 9 x 12 bookmark and 1 px slot; 45 degree stairs, the diagonal ${c16.cutV} px tall; play columns ${c16.cols.join(', ')}, its tip ${c16.gap} px short of the slot.`);
  if (o.glyph.mode === 'play') {   // the media-card study only: the glyph cut as D
    const c = cutGeom(24, o);
    info.cuts[24] = c;
    out['glyph-24.svg'] = g.svg(24, `<path fill="#FFFFFF" fill-rule="evenodd" d="${cutPath(c)}"/>`, `D glyph drawn split and played (study): slot ${c.slot} px, the diagonal drops ${c.cutV} px.`);
  } else if (o.glyph.mode === 'split') {
    out['glyph-24.svg'] = C.draw({ ...C.OPT, glyph: { mode: 'split', slot: 2, feet: 'base' } }).out['glyph-24.svg'];
  } else {
    out['glyph-24.svg'] = g.svg(24, `<path fill="#FFFFFF" d="${CUTS.glyph}"/>`, 'D glyph: the plain shared bookmark (candidates/base), as C. Built by build.mjs.');
  }
  return { out, info };
}

// ---- meta.json: numbers from the drawing; softness, reach and centroid from the last sheet (build again after it) --
export function meta(info, z, metrics, cm, bm) {
  const m = info.master, c48 = info.cuts[48], c32 = info.cuts[32], f1 = v => g.fmt(Math.round(v * 10) / 10);
  const px1 = v => f1(v * 48 / 72);                                    // dp to pixels on a 1x home screen
  const sp = (mm, k) => mm?.cuts?.[k]?.soft_pct, word = n => ['no', 'one', 'two', 'three', 'four', 'five'][n] ?? String(n);
  const soft = k => (sp(metrics, k) == null ? 'softness not yet measured' : sp(metrics, k) === sp(cm, k) ? `${sp(metrics, k)}% soft, as C` : `${sp(metrics, k)}% soft against C's ${sp(cm, k)}`);
  const dims = c => `${c.x1 - c.x0} × ${c.ty - c.top}`;
  const aH = 2 * m.notch, aD = aH / (2 * m.s);                         // A's play: the folded notch
  const reach = metrics?.master?.reach_dp ?? 32.56, ctr = metrics?.master?.centroid, ink = metrics?.master?.ink_of_viewport_pct;
  const z48 = z.cuts[48], z32 = z.cuts[32], gs = cutGeom(24, { ...OPT, glyph: GLYPH_STUDY });   // gs: the glyph study
  const corners = `A corner's radius follows what made it, as in C. The outline makes the two square shoulders, which keep 4/34 of the width (${n2(m.rTop)} dp). The cuts make every other corner, and all of them take the tips' 1.5/34 (${n2(m.rTip)} dp): the two tail tips; the slot's four corners (right angles at the top, 57 degrees where the slot meets the diagonal and 123 where it meets the right half's foot); the diagonal's other corner on the upper piece, 123 degrees at the left edge; and the play's three corners, 57 degrees at the back and 66 at the point, its lower back corner being the bookmark's own left tip. That is nine corners at ${n2(m.rTip)} dp and two at ${n2(m.rTop)}. In the pixel cuts every cut corner is sharp, as the base draws its tips.`;
  return {
    title: 'Split and play',
    one: 'Shelf\'s bookmark cut twice: the halves make a pause, and the left tail a play.',
    tags: ['Two cuts', 'Play from 32 px up', 'Same as C at 16 px'],
    idea: 'Shelf\'s bookmark cut twice, both cuts the same width, with nothing stamped on: C\'s slot down the middle makes the two halves a pause, and the second cut carries the notch\'s right edge straight on to the left side, so the left tail under it becomes a play pointing into the gap. The play\'s edges keep the notch\'s angle, so it has the shape of A\'s and B\'s play, and the outline is still the bookmark\'s.',
    built: `The shared bookmark (candidates/base: ${MASTER.w} dp wide, top at ${MASTER.top}, reach ${reach} of 33) with C's slot, ${n2(m.gap)} dp (1/7 of the width), and C's right half path for path: the build takes both from C's build, so a change to C's master carries into D. The second cut follows the notch's right edge carried on, from the right tip through the apex (which now falls inside the slot) to the left edge at y ${n2(m.yLl)}, two notches above the tips. The left half's upper piece ends on that line, so its lower edge and the right half's foot are one straight line, broken only by the slot. The cut lies under the line, ${n2(m.cut)} dp wide measured square to it (${n2(m.cv)} dp down the left edge): exactly the slot's width. The play is the tail under the cut. Its top edge runs parallel to the right flank and its bottom edge is the notch's own left flank, so the two edges mirror each other about a level axis and its depth is its height × 17/22, the shape of A's and B's play: ${n2(m.H)} × ${n2(m.depth)} dp, ${n2(m.H / aH)} of A's ${n2(aH)} × ${n2(aD)}, with its axis at y ${n2(m.tip[1])}. Its rounded tip stops ${n2(m.gapDrawn)} dp short of the slot's line, ${px1(m.gapDrawn)} px on a 1× home screen, where the ${word(Math.round(z.at1x.clear))} pixel columns before the slot are clear (the nearest holds ${z.at1x.faintPct}% paper). Between the pieces there is ${n2(z.upperPlay)} dp of dark from the upper piece to the play and ${f1(z.playRight)} dp from the play to the right half. I chose the cut's width by eye from 0.75, 1, 1.15 and 1.3 times the slot. At 0.75 the diagonal read as a crack beside the slot and the play's tip crowded the slot's line; at 1.15 and 1.3 the diagonal looked heavier than the slot and the play shrank away from the gap; at one slot the two read as cuts made with the same blade. A thinner cut gives a bigger play (${n2(z.H075)} dp tall at 0.75), but one slot is also the narrowest cut that keeps three clear pixel columns before the slot at 1×: at ${z.thinner.cut} of the slot the nearest column is ${z.thinner.lastPct}% paper. The ink is ${ink ?? '?'}% of the visible tile (C ${cm?.master?.ink_of_viewport_pct}, base ${bm?.master?.ink_of_viewport_pct}), and its centroid (${ctr ? ctr.x + ', ' + ctr.y : '?'}) sits ${ctr ? f1(ctr.x - 54) : '?'} dp right of the centre line, because the slot takes paper from both halves alike and the second cut from the left half only; the outline stays where every option's does. ${corners}`,
    corners,
    small: `The 48 and 32 px cuts keep both cuts and the play; the 16 px cut is C's split alone, and the glyph is the plain bookmark, as C's is. 48 px: C's ${dims(c48)} px bookmark, ${c48.slot} px slot (1/7) and right half. The diagonal meets the left edge on whole pixels, at y ${f(c48.yLl)} and, ${f(c48.cutV)} px lower, at y ${f(c48.yLl + c48.cutV)}, which makes it ${f1(c48.cut)} px wide square to itself, a pixel wider than the slot. At the slot's own width (a 5 px drop) only two pixel columns stayed clear between the play's tip and the slot; the ${f(c48.cutV)} px drop clears ${word(Math.round(z48.clear))} (the nearest holds ${z48.faintPct}% paper; the sharp tip is ${n2(c48.gap)} px short of the slot). Play ${f(c48.H)} × ${n2(c48.depth)} px, its axis on y ${f(c48.tip[1])}, a pixel boundary, so its two edges rasterise as mirror images; ${soft('cut-48')}. 32 px: C's ${dims(c32)} px bookmark (one pixel added on the left, so it sits half a pixel left of the tile's centre, as C's does) and ${c32.slot} px slot. The notch's slope changes from C's ${n2(c32.cSlope)} to 2/3, h1's at this size: on ${n2(c32.cSlope)} the diagonal would meet the left edge at y ${n2(c32.ty - (c32.x1 - c32.x0) * c32.cSlope)} and its stairs start unevenly, while on 2/3 every end lands on a whole pixel, (${c32.x0}, ${f(c32.yLl)}), (${c32.xl}, ${f(c32.yLs)}), (${c32.xr}, ${f(c32.yCut)}) and (${c32.x1}, ${c32.ty}), and the stairs step evenly, three across and two down. The right half's foot ends ${n2(Math.abs(c32.yL(c32.xr) - (c32.ty - (c32.x1 - c32.xr) * c32.cSlope)))} px higher at the slot than C's. A ${f(c32.cutV)} px drop makes the diagonal ${n2(c32.cut)} px wide, the slot's width to a third of a pixel. Play ${f(c32.H)} × ${n2(c32.depth)} px, axis on y ${f(c32.tip[1])}; ${word(Math.round(z32.clear))} clear pixel columns before the slot (the nearest holds ${z32.faintPct}% paper, under the sheet's 12% threshold; the sharp tip is ${n2(c32.gap)} px short); ${soft('cut-32')}. 16 px: C's cut, byte for byte apart from its comment, a 9 × 12 px bookmark half a pixel left of centre, with a 1 px slot and 45 degree stairs (${soft('cut-16')}). A whole-pixel play fits (columns of 6, 4 and 2 px under a 2 px stair, its tip a pixel short of the slot), and magnified it is a play; at real size the stair and the slot join into one bent dark line, the left half breaks into two small pieces and the play reads as a nick in the left bar. The split alone keeps the outline whole but for the slot, and it is plainly the same icon. Glyph: the plain shared bookmark (${soft('glyph-24')}). Drawn as D it is a play-and-pause sign beside the clock, and on the media card it repeats the real button in both states, pause while playing and play while paused; at 24 px its play is also small, ${f(gs.H)} × ${n2(gs.depth)} px. media-card.png in this folder shows both (rebuild it with media-card.mjs).`,
    risks: `A play with a pause is the media toggle. A play and a pause cut from one shape can read as a player's play/pause button, or as a music or podcast app, before a reading app, and this is strongest in the light colourway, where three ink pieces stand on paper. The play sits in the bookmark's tail, under the left bar, and the outline keeps Shelf's square shoulders; both set it apart from the toggle sign. t2, a play beside a pause on a bookmark lying on its side, was dropped for reading as a remote. The old slash: the left half's lower edge and the right half's foot are one straight line from the left edge down to the right tip, top left to bottom right, the direction of the 'off' slash (bookmark-off, bell-off) that sank h1. Here the slot breaks it in the middle and the dark band crosses only the left half, so it reads as two bars cut at the notch's angle, but someone who knows the convention could still see a bookmark struck through. Lookalikes: Google Play Books pairs a bookmark and a play; the light colourway's two ink bars are still near ElevenLabs' II, though the left one is broken; any stock play/pause button. Like C, the notch's apex is gone, and the V survives as the play's lower edge and the right half's foot. The play is small: ${n2(m.H)} dp tall against A's ${n2(aH)}, about ${px1(m.H)} × ${px1(m.depth)} px on a 1× home screen. The mark is three pieces of paper, so any one-colour use (print, emboss, a cut sticker) has to keep both cuts open. At 48 px the diagonal is a pixel wider than the slot (${f1(c48.cut)} px against ${c48.slot}); at 32 px D's notch is 2/3 where C's is ${n2(c32.cSlope)}, so D's right half there is not C's file exactly; at 16 px and in the glyph D is C, so the play appears only from 32 px up. As the extension's toolbar button, which only saves, a play and a pause promise controls the extension doesn't have; the base's plain bookmark is the safer button there.`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, info } = draw();
  for (const [k, s] of Object.entries(out)) fs.writeFileSync(path.join(HERE, k), s);
  const read = p => { try { return JSON.parse(fs.readFileSync(path.join(HERE, p), 'utf8')); } catch { return null; } };
  const z = measure(info);
  fs.writeFileSync(path.join(HERE, 'meta.json'), JSON.stringify(meta(info, z, read('metrics.json'), read('../C/metrics.json'), read('../base/metrics.json')), null, 2) + '\n');
  const m = info.master;
  console.log('D master: slot', n2(m.gap), 'cut', n2(m.cut), 'cv', n2(m.cv), 'play', n2(m.H), 'x', n2(m.depth), 'tip', m.tip.map(n2).join(', '),
    'gap sharp', n2(m.gapSharp), 'drawn', n2(m.gapDrawn), '| 1x: last touched col', z.at1x.last, 'clear', n2(z.at1x.clear), 'faint', z.at1x.faintPct + '%',
    '| upper-play', n2(z.upperPlay), 'play-right', n2(z.playRight), '| at 0.95 slot: clear', n2(z.thinner.clear), 'nearest', z.thinner.lastPct + '%');
  for (const n of [48, 32]) { const c = info.cuts[n], q = z.cuts[n]; console.log(n, 'px: cutV', c.cutV, 'cut', n2(c.cut), 'play', n2(c.H), 'x', n2(c.depth), 'tip', c.tip.map(n2).join(', '), 'sharp gap', n2(c.gap), '| last touched col', q.last, 'clear', n2(q.clear), 'faint', q.faintPct + '%'); }
  console.log('16 px:', info.cuts[16].mode);
}
