// node docs/design/icons/negative-space/tools/d-height.mjs
// D's height, after a designer's note: "a tad shorter", "the height exactly three play buttons: bottom facing right,
// middle facing left, top facing right", and more room round the mark.
//
// D's cuts lie on the notch's two angles, so those angles make a grid of plays up the left half: the bottom one is
// the play plus the cut above it (the left edge, the notch's left flank and the right flank carried on), the middle
// one faces left with its flat side on the centre line, and the top one faces right again. Each right-facing play's
// flat side is two notch depths, so three of them, interlocked, are four notch depths tall.
//
// Writes overlay.svg (that grid, for the construction view) into candidates/D, and mark.svg, overlay.svg and
// numbers.json into one folder per variant. Masters only: pixel cuts follow once a variant is chosen.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from './geom.mjs';

const STUDY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAPER = '#F3F2EE', LINE = '#E08200';
const f = g.fmt, r2 = v => Math.round(v * 100) / 100;

// D's construction for any width, height and notch angle, its box centred on (54, 54) as D's is (D: top 27.1,
// sharp tips 80.835). Corner rule as C and D: shoulders 4/34 of the width, every cut corner the tips' 1.5/34.
// Slot and diagonal are both 1/7 of the width, the diagonal measured square to itself.
function dMark({ W, H, s }) {
  const k = W / 34, cx = 54, x0 = cx - W / 2, x1 = cx + W / 2, top = 54 - H / 2 + 0.0325, y1 = top + H;
  const n = (W / 2) * s, apex = y1 - n, rTop = 4 * k, rTip = 1.5 * k;
  const slot = W / 7, xl = cx - slot / 2, xr = cx + slot / 2;
  const yAt = x => apex + (x - cx) * s;                   // the notch's right flank, carried on
  const cv = slot * Math.hypot(1, s);                     // the diagonal cut, measured down the left edge
  const depth = (2 * n - cv) / (2 * s), tip = [x0 + depth, y1 - s * depth];
  const right = g.roundedPolygon([[xr, top], [x1, top], [x1, y1], [xr, yAt(xr)]], [rTip, rTop, rTip, rTip]);
  const upper = g.roundedPolygon([[x0, top], [xl, top], [xl, yAt(xl)], [x0, yAt(x0)]], [rTop, rTip, rTip, rTip]);
  const play = g.roundedPolygon([[x0, yAt(x0) + cv], tip, [x0, y1]], [rTip, rTip, rTip]);
  const playH = y1 - yAt(x0) - cv;
  // reach from the canvas centre, sampled along the outline (the rounded corners pull it in)
  const reach = Math.max(...[[x0 + rTop, top], [x1 - rTop, top]].map(([x, y]) => Math.hypot(x - 54, y - 54) + 0),
    ...[[x0, top + rTop], [x1, top + rTop], [x0, y1 - rTip], [x1, y1 - rTip]].map(([x, y]) => Math.hypot(x - 54, y - 54)));
  return { d: upper + play + right, W, H, s, x0, x1, top, y1, n, apex, cx, playH, depth, tipGap: xl - tip[0],
    angle: Math.atan(s) * 180 / Math.PI, threePlays: 4 * n, overshoot: 4 * n - H, reach };
}

// the grid: three interlocked plays up the left half, right, left and right again
function overlay(m) {
  const { x0, cx, y1, n } = m;
  const T1 = [[x0, y1 - 2 * n], [x0, y1], [cx, y1 - n]];
  const T2 = [[x0, y1 - 2 * n], [cx, y1 - n], [cx, y1 - 3 * n]];
  const T3 = [[x0, y1 - 2 * n], [cx, y1 - 3 * n], [x0, y1 - 4 * n]];
  const poly = (P, fill) => `<path d="M${P.map(p => f(p[0]) + ' ' + f(p[1])).join('L')}Z" fill="${fill ? LINE : 'none'}" fill-opacity="${fill ? 0.16 : 0}" stroke="${LINE}" stroke-width="0.6" stroke-linejoin="round"/>`;
  const topLine = `<path d="M${f(x0 - 4)} ${f(y1 - 4 * n)}H${f(cx + 4)}" stroke="${LINE}" stroke-width="0.6" stroke-dasharray="1.6 1.2"/>`;
  return g.svg(108, poly(T1, true) + poly(T2, false) + poly(T3, true) + topLine,
    'Construction only: three plays on the notch\'s angles, right, left and right, interlocked up the left half. Not part of the mark.');
}

const D_NOW = { W: 43.5, H: 42 / 34 * 43.5, s: 11 / 17 };        // D as drawn: today's bookmark proportions
const THREE = 2 / Math.sqrt(3);                                  // height / width when three equilateral plays fill it
const VARIANTS = [
  { id: 'D', label: 'D now', p: D_NOW, keep: true },
  { id: 'D-short', label: 'A tad shorter', p: { W: 43.5, H: THREE * 43.5, s: 11 / 17 } },
  { id: 'D-three', label: 'Three plays', p: { W: 43.5, H: THREE * 43.5, s: Math.tan(Math.PI / 6) } },
  { id: 'D-three-90', label: 'Three plays, smaller', p: { W: 43.5 * 0.9, H: THREE * 43.5 * 0.9, s: Math.tan(Math.PI / 6) } },
];

const out = [];
for (const v of VARIANTS) {
  const m = dMark(v.p), dir = path.join(STUDY, 'candidates', v.id);
  fs.mkdirSync(dir, { recursive: true });
  if (!v.keep) fs.writeFileSync(path.join(dir, 'mark.svg'), g.svg(108, `<path fill="${PAPER}" d="${m.d}"/>`,
    `${v.label}: D's construction, ${f(r2(m.W))} dp wide and ${f(r2(m.H))} tall to the sharp tips, notch at ${f(r2(m.angle))} degrees. Written by tools/d-height.mjs.`));
  fs.writeFileSync(path.join(dir, 'overlay.svg'), overlay(m));
  const nums = { id: v.id, label: v.label, width: r2(m.W), height: r2(m.H), heightToWidth: r2(m.H / m.W), notchAngle: r2(m.angle),
    play: { height: r2(m.playH), depth: r2(m.depth), shareOfHeight: r2(m.playH / m.H), tipToSlot: r2(m.tipGap) },
    threePlaysTall: r2(m.threePlays), overshoot: r2(m.overshoot), reachApprox: r2(m.reach) };
  if (!v.keep) fs.writeFileSync(path.join(dir, 'numbers.json'), JSON.stringify(nums, null, 2) + '\n');
  out.push(nums);
}
console.log(JSON.stringify(out, null, 1));
