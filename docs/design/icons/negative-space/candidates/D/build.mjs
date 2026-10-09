// D · Split and play, three plays tall (chosen by Richard on 9 October 2026, after his designer friend's notes: a tad
// shorter, the height set by three play buttons facing right, left and right, and more room round the mark).
// The earlier D, on the shared bookmark's proportions, is kept in candidates/D-was; tools/d-height.mjs drew the study.
//
// Two straight cuts: a slot down the centre line, 1/7 of the bookmark's width, makes the halves a pause, and the notch's
// right flank carried on across the left half, in a cut 0.8 of the slot's width, makes the left tail a play (the bigger
// play Richard chose on 9 October 2026; with both cuts one width, the earlier version, kept as candidates/D-even). The notch is at 30 degrees, so the
// plays its two angles make up the left half are equilateral, and the bookmark's height is exactly three of them,
// interlocked: four notch depths, 2/sqrt(3) of the width. The play itself is the bottom one less the cut above it.
// Corner rule as C: the outline's shoulders take 4/34 of the width, every corner a cut makes the tips' 1.5/34; in the
// pixel cuts, cut corners are sharp. The master is drawn 43.5 dp wide and shown at 90%, as every option is.
//   node candidates/D/build.mjs        writes mark.svg, cut-48.svg, cut-32.svg, cut-16.svg, glyph-24.svg, meta.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';
import { MASTER, SCALE, atScale } from '../base/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAPER = '#F3F2EE';
const out = (f, s) => fs.writeFileSync(path.join(HERE, f), s);
const f = g.fmt, r2 = v => Math.round(v * 100) / 100;
const S30 = Math.tan(Math.PI / 6);

// diag: the diagonal cut's width as a share of the slot's. D as chosen is 0.8, for a bigger play (1 makes the two cuts
// one width: candidates/D-even). A narrower diagonal makes the play bigger without changing the height, since the
// notch sets the height, not the cut. cv: the diagonal's drop in the 48 and 32 px cuts, in whole pixels.
export const OPT = { diag: 0.8, cv: { 48: 4, 32: 3, 28: 3 } };

// ---- the master -------------------------------------------------------------------------------------------------
export function master(o = OPT) {
  const W = MASTER.w, k = W / 34, cx = 54, H = W * 2 / Math.sqrt(3);
  const x0 = cx - W / 2, x1 = cx + W / 2, top = 54 - H / 2, y1 = top + H;
  const s = S30, n = (W / 2) * s, apex = y1 - n, rTop = 4 * k, rTip = 1.5 * k;
  const slot = W / 7, xl = cx - slot / 2, xr = cx + slot / 2;
  const yAt = x => apex + (x - cx) * s;                   // the right flank, carried on through the apex
  const cv = o.diag * slot * Math.hypot(1, s);            // the diagonal cut, o.diag of the slot's width square to itself
  const depth = (2 * n - cv) / (2 * s), tip = [x0 + depth, y1 - s * depth];
  const right = g.roundedPolygon([[xr, top], [x1, top], [x1, y1], [xr, yAt(xr)]], [rTip, rTop, rTip, rTip]);
  const upper = g.roundedPolygon([[x0, top], [xl, top], [xl, yAt(xl)], [x0, yAt(x0)]], [rTop, rTip, rTip, rTip]);
  const play = g.roundedPolygon([[x0, yAt(x0) + cv], tip, [x0, y1]], [rTip, rTip, rTip]);
  return { d: upper + play + right, W, H, n, s, slot, cv, cut: o.diag * slot, playH: 2 * n - cv, depth, tipGap: xl - tip[0], top, y1, x0 };
}

// ---- the pixel cuts: one unit is one pixel; straight edges on whole pixels, cut corners sharp ---------------------
// A polygon from points, with the outline's two outer shoulders rounded (r) and everything else sharp.
const piece = (pts, r = 0, round = []) => g.roundedPolygon(pts, pts.map((_, i) => (round.includes(i) ? r : 0)));
// 48 and 32 px: the bookmark x0..x1 by top..y1 with its notch n deep, a slot s px wide, and the diagonal's drop cv px.
function cutPx({ x0, x1, top, y1, n, s, cv, r }) {
  const cx = (x0 + x1) / 2, xl = cx - s / 2, xr = cx + s / 2, sl = n / ((x1 - x0) / 2), apex = y1 - n;
  const yAt = x => apex + (x - cx) * sl;
  const depth = (2 * n - cv) / (2 * sl), tip = [x0 + depth, y1 - sl * depth];
  const right = piece([[xr, top], [x1, top], [x1, y1], [xr, yAt(xr)]], r, [1]);
  const upper = piece([[x0, top], [xl, top], [xl, yAt(xl)], [x0, yAt(x0)]], r, [0]);
  const play = piece([[x0, yAt(x0) + cv], tip, [x0, y1]]);
  return { d: upper + play + right, playH: 2 * n - cv, depth, tip, tipGap: xl - tip[0], band: cv / Math.hypot(1, sl), slope: sl, yL: yAt(x0) };
}
export const CUTS = {
  // 28 x 32 px: four notch depths of 8 are the height, so three plays fill it on whole pixels (the notch at 29.7
  // degrees, 8 over 14). The slot is 4 px (1/7). A 4 px drop makes the diagonal 3.47 px square to itself, 0.87 of the
  // slot (the master's 0.8, to the nearest whole-pixel drop); the play is 12 px tall with its axis on the boundary at
  // row 34, so its two edges rasterise alike, and its tip stops 1.5 px short of the slot. (D-even drops 5 px: 11 px.)
  48: { x0: 10, x1: 38, top: 8, y1: 40, n: 8, s: 4, cv: 4, r: 3 },
  // 21 x 24 px: C's 32 px width (a pixel added on the left so a 3 px slot sits between whole-pixel halves) and four
  // notch depths of 6. A 3 px drop makes the diagonal 2.6 px wide, 0.87 of the slot; the play is 9 px tall, centred
  // on pixel row 23 so its edges rasterise alike, with its tip 1.1 px short of the slot. (D-even drops 4 px: 8 px.)
  32: { x0: 5, x1: 26, top: 4, y1: 28, n: 6, s: 3, cv: 3, r: 2 },
  // 19 x 22 px for the extension options page's logo (shared/brand's small-28, shown at 1x and 2x): four notch depths of
  // 5.5, so the diagonal meets the left edge at y 14, a whole pixel; a 3 px slot between 8 px halves, half a pixel left
  // of the tile's centre as the 32 px cut is; a 3 px drop (2.6 px square, the master's 0.8 of the slot to the nearest
  // pixel) leaves an 8 px play on the boundary at row 21, its tip 1.1 px short of the slot.
  28: { x0: 4, x1: 23, top: 3, y1: 25, n: 5.5, s: 3, cv: 3, r: 2 },
};
// 16 px: the split alone, as the earlier D and C (a 3 px play turned into a nick in the bar at real size), on D's
// proportions: 9 x 10 px (C's is 9 x 12), a 1 px slot, and C's whole-pixel 45 degree stairs for feet, meeting the slot
// 3 px above the tips.
function cut16() {
  const L = 'M3 4A1 1 0 0 1 4 3H7V10H6V11H5V12H4V13H3Z';
  const R = 'M8 3H11A1 1 0 0 1 12 4V13H11V12H10V11H9V10H8Z';
  return L + R;
}
// The glyph: the plain bookmark on D's proportions, 16 x 18 px with the notch 4.5 deep (a quarter of the height), as
// the earlier D and C (split, it sat beside the media card's real pause button and read as a second one).
const GLYPH = 'M6 3H18A2 2 0 0 1 20 5V21L12 16.5L4 21V5A2 2 0 0 1 6 3Z';

// The extension's toolbar button at 16 and 32 px: the plain bookmark, since the extension only saves and D's split
// reads as a pause control at those sizes. Both keep D's rule, the height four notch depths: 10 x 12 px with a 3 px
// notch, and 20 x 24 px with a 6 px notch, centred on whole pixels.
export const EXT = {
  16: 'M4 2H12A1 1 0 0 1 13 3V14L8 11L3 14V3A1 1 0 0 1 4 2Z',
  32: 'M8 4H24A2 2 0 0 1 26 6V28L16 22L6 28V6A2 2 0 0 1 8 4Z',
};

// ---- files ------------------------------------------------------------------------------------------------------
export function build(o = OPT, dir = HERE) {
  const out = (f, x) => fs.writeFileSync(path.join(dir, f), x);
  const m = master(o), info = { master: m, cuts: {} };
  out('mark.svg', g.svg(108, atScale(`<path fill="${PAPER}" fill-rule="evenodd" d="${m.d}"/>`),
    `D Split and play, three plays tall. Drawn ${f(m.W)} x ${f(r2(m.H))} dp (the height four notch depths, three equilateral plays), ` +
    `notch at 30 degrees, slot ${f(r2(m.slot))} dp, diagonal ${f(r2(m.cut))} dp; play ${f(r2(m.playH))} x ${f(r2(m.depth))} dp, its tip ${f(r2(m.tipGap))} dp short of the slot. ` +
    `Shown at ${SCALE * 100}% about the canvas centre. Built by build.mjs.`));
  for (const [n, c0] of Object.entries(CUTS)) {
    const c = { ...c0, cv: o.cv[n] }, r = cutPx(c); info.cuts[n] = r;
    out(`cut-${n}.svg`, g.svg(+n, `${g.tileRect(+n)}<path fill="${PAPER}" d="${r.d}"/>`,
      `D at ${n} px: bookmark ${c.x1 - c.x0} x ${c.y1 - c.top} px, notch ${c.n} (four notch depths tall), slot ${c.s} px, diagonal dropped ${c.cv} px; ` +
      `play ${f(r2(r.playH))} x ${f(r2(r.depth))} px, tip ${f(r2(r.tipGap))} px short of the slot. Built by build.mjs.`));
  }
  out('cut-16.svg', g.svg(16, `${g.tileRect(16)}<path fill="${PAPER}" d="${cut16()}"/>`,
    'D at 16 px: the split alone on D\'s proportions, 9 x 10 px, 1 px slot, 45 degree stairs. Built by build.mjs.'));
  out('glyph-24.svg', g.svg(24, `<path fill="#FFFFFF" d="${GLYPH}"/>`, 'D glyph: the plain bookmark on D\'s proportions, 16 x 18 px. Built by build.mjs.'));
  for (const n of [16, 32]) out(`ext-${n}.svg`, g.svg(n, `${g.tileRect(n)}<path fill="${PAPER}" d="${EXT[n]}"/>`,
    `The extension's toolbar button at ${n} px: the plain bookmark on D's proportions (it only saves). Built by build.mjs.`));
  return info;
}

export function meta(info) {
  const m = info.master, c48 = info.cuts[48], c32 = info.cuts[32], sh = v => f(r2(v * SCALE));
  return {
    title: 'Split and play',
    one: 'Shelf\'s bookmark cut twice: the halves make a pause, and the left tail a play.',
    tags: ['Two cuts', 'Three plays tall', 'Play from 32 px up'],
    idea: 'Shelf\'s bookmark cut twice, with nothing stamped on: a slot down the middle makes the two halves a pause, and the notch\'s right edge, carried on across the left half, turns the left tail into a play pointing into the gap. Its height is exactly three plays, facing right, left and right, as your designer friend suggested.',
    built: `The notch is at 30 degrees, so the plays the two cuts' angles make up the left half are equilateral, and the bookmark is exactly three of them tall, interlocked: four notch depths, ${f(r2(m.H / m.W))} times its width (today's bookmark is 1.24). Drawn ${f(m.W)} × ${f(r2(m.H))} dp and shown at 90% about the canvas centre, ${sh(m.W)} × ${sh(m.H)} dp of the 72 the launcher shows, as every option is. The slot is 1/7 of the width, ${f(r2(m.slot))} dp; the diagonal is 0.8 of that, ${f(r2(m.cut))} dp measured square to itself, which makes the play 8% taller than two equal cuts would without changing the height. The play is ${f(r2(m.playH))} × ${f(r2(m.depth))} dp before scaling, ${f(r2(m.playH / m.H))} of the height, and its tip stops ${f(r2(m.tipGap))} dp short of the slot. Corners follow what made them: the outline's square shoulders take 4/34 of the width, every corner a cut makes takes the tips' 1.5/34.`,
    corners: 'A corner\'s radius follows what made it. The outline\'s square shoulders take 4/34 of the width; every corner a cut makes (the tips, the slot\'s corners, the diagonal\'s and the play\'s) takes the tips\' 1.5/34. In the pixel cuts every cut corner is sharp.',
    small: `48 px: a 28 × 32 px bookmark with an 8 px notch, so four notch depths are the height and the three plays land on whole pixels; a 4 px slot (1/7) and a diagonal dropped 4 px, ${f(r2(c48.band))} px square to itself. The play is ${f(r2(c48.playH))} px tall, its axis on a pixel boundary so its edges rasterise alike, and its tip stops ${f(r2(c48.tipGap))} px short of the slot. 32 px: 21 × 24 px with a 6 px notch (four depths again) and a 3 px slot; the play is ${f(r2(c32.playH))} × ${f(r2(c32.depth))} px with its tip ${f(r2(c32.tipGap))} px short of the slot; like C's, this cut sits half a pixel left of the tile's centre, because a 3 px slot needs an odd-width bookmark. 16 px: the split alone, 9 × 10 px with a 1 px slot and 45 degree stairs for feet: a 3 px play here turned into a nick in the bar at real size. Glyph: the plain bookmark on D's proportions, 16 × 18 px, since a play and pause glyph would sit beside the media card's real play and pause button. The pixel cuts keep their size; only the launcher drawing is shown at 90%. The extension's toolbar button is the plain bookmark at 16 and 32 px (10 × 12 and 20 × 24 px, each four notch depths tall), because the extension only saves and the split reads as a pause control there; the browser tab, the launcher and everything from 48 px up show D.`,
    risks: 'A play with a pause is the media toggle, so it can read as a player\'s control or a music app before a reading app, most of all in the light colourway. The reviewer with no context saw the earlier D as play and pause controls with the left bar snapped off. The left half\'s lower edge and the right half\'s foot run as one line from top left to bottom right, the direction of the "off" slash, though the slot breaks it. The notch is 3 degrees shallower than today\'s bookmark, and D\'s bookmark is 6.5% shorter than the one A, B and C share. The play shows only from 32 px up, and with the bigger play its tip comes within about a pixel of the slot at 32 px. The mark is three pieces, so any one-colour use has to keep both cuts open.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = build();
  out('meta.json', JSON.stringify(meta(info), null, 2) + '\n');
  const m = info.master;
  console.log(JSON.stringify({ master: { W: m.W, H: r2(m.H), playH: r2(m.playH), depth: r2(m.depth), tipGap: r2(m.tipGap), shown: r2(SCALE * m.W) + ' x ' + r2(SCALE * m.H) },
    48: { playH: info.cuts[48].playH, tipGap: r2(info.cuts[48].tipGap), band: r2(info.cuts[48].band) }, 32: { playH: info.cuts[32].playH, tipGap: r2(info.cuts[32].tipGap), band: r2(info.cuts[32].band) } }));
}
