// C · Split. The shared bookmark (candidates/base) cut once down its centre line, so the two halves are a pause.
// Writes mark.svg, cut-48.svg, cut-32.svg, cut-16.svg, glyph-24.svg and meta.json next to this file:
//   node candidates/C/build.mjs
// draw(opt) returns the files for any option set, so studies can render variants without touching this folder.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';
import { MASTER, CUTS, atScale } from '../base/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAPER = '#F3F2EE';
const B = g.BOOKMARK; // today's proportions in bookmark units (34 wide)

export const OPT = {
  slot: 1 / 7,          // the master's slot as a share of the bookmark's width
  cutR: 'tip',          // the four corners the cut makes: 'tip' (1.5/34, chosen), 'shoulder' on the top two, or 'sharp'
  c48: { slot: 4, feet: 'base' },                       // feet on the base's notch line
  c32: { slot: 3, widen: 'left', feet: 'base' },        // 21 px wide: one pixel added on the left
  c16: { slot: 1, width: 9, shift: 'left', feet: 'stair' },
  glyph: { mode: 'plain', slot: 2, feet: 'base' }, // plain: the split read as a second pause button beside the real one
};

// ---- the master ---------------------------------------------------------------------------------------------
export function masterGeom(o = OPT) {
  const { cx, top, w } = MASTER, k = w / B.w;
  const h = B.h * k, notch = B.notch * k, rTop = B.rTop * k, rTip = B.rTip * k;
  const x0 = cx - w / 2, x1 = cx + w / 2, y1 = top + h, apex = y1 - notch, slope = notch / (w / 2);
  const gap = o.slot * w, xl = cx - gap / 2, xr = cx + gap / 2;
  const yCut = apex + (gap / 2) * slope; // where the cut meets the notch line: the slope runs on unbroken
  return { cx, top, w, h, k, notch, rTop, rTip, x0, x1, y1, apex, slope, gap, xl, xr, yCut };
}
export function master(o = OPT) {
  const m = masterGeom(o);
  const rC = o.cutR === 'sharp' ? 0 : m.rTip, rCtop = o.cutR === 'shoulder' ? m.rTop : rC;
  const left = g.roundedPolygon([[m.x0, m.top], [m.xl, m.top], [m.xl, m.yCut], [m.x0, m.y1]], [m.rTop, rCtop, rC, m.rTip]);
  const right = g.roundedPolygon([[m.xr, m.top], [m.x1, m.top], [m.x1, m.y1], [m.xr, m.yCut]], [rCtop, m.rTop, m.rTip, rC]);
  return { ...m, d: left + right };
}

// ---- the base's pixel cuts, read from its path strings ---------------------------------------------------------
// Each is 'M x0+r top H x1-r A r r 0 0 1 x1 top+r V tip L cx apex L x0 tip V top+r A r r 0 0 1 x0+r top Z'.
export function parseCut(d) {
  const t = d.match(/[MLHVAZ]|-?\d*\.?\d+/g), pts = [];
  let i = 0, cmd = '', x = 0, y = 0, r = 0;
  const num = () => +t[i++];
  while (i < t.length) {
    if (/[A-Z]/.test(t[i])) cmd = t[i++];
    if (cmd === 'Z') continue;
    if (cmd === 'M' || cmd === 'L') { x = num(); y = num(); }
    else if (cmd === 'H') x = num();
    else if (cmd === 'V') y = num();
    else if (cmd === 'A') { r = num(); i += 4; x = num(); y = num(); }
    pts.push([x, y]);
  }
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), top = Math.min(...ys), tip = Math.max(...ys);
  const [cx, apex] = pts.find(([px, py]) => px > x0 && px < x1 && py > top + r && py < tip);
  const c = { x0, x1, top, tip, cx, apex, r };
  const f = g.fmt, back = `M${f(x0 + r)} ${f(top)}H${f(x1 - r)}A${f(r)} ${f(r)} 0 0 1 ${f(x1)} ${f(top + r)}V${f(tip)}L${f(cx)} ${f(apex)}L${f(x0)} ${f(tip)}V${f(top + r)}A${f(r)} ${f(r)} 0 0 1 ${f(x0 + r)} ${f(top)}Z`;
  if (back !== d) throw new Error('base cut not in the expected form: ' + d + ' vs ' + back);
  return c;
}

// A pixel cut's two halves. c: the bookmark (x0, x1, top, tip, r, and the notch line through (x0, tip) with slope);
// s: slot in px; feet: 'line' (a diagonal on the notch line, sharp corners like the base's tips) or 'stair'
// (whole-pixel 45 degree steps, one pixel across and one up per column).
function halvesPx(c, s, feet) {
  const cx = (c.x0 + c.x1) / 2, xl = cx - s / 2, xr = cx + s / 2;
  if (feet === 'stair') {
    // n columns per half; column j (0 at the outer side) ends at tip - j, so the foot climbs one pixel per column
    // and meets the cut at tip - (n - 1). Only the outer shoulder is rounded; every step is a whole pixel.
    const n = xl - c.x0, L = [[c.x0, c.top], [xl, c.top]], R = [[xr, c.top], [c.x1, c.top]];
    for (let j = n - 1; j >= 0; j--) L.push([c.x0 + j + 1, c.tip - j], [c.x0 + j, c.tip - j]);
    for (let j = 0; j <= n - 1; j++) R.push([c.x1 - j, c.tip - j], [c.x1 - j - 1, c.tip - j]);
    const rr = (pts, iTop) => g.roundedPolygon(pts, pts.map((p, i) => (i === iTop ? c.r : 0)));
    return { d: rr(L, 0) + rr(R, 1), xl, xr, yCut: c.tip - (n - 1) };
  }
  const yCut = c.tip - (xl - c.x0) * c.slope;
  const L = g.roundedPolygon([[c.x0, c.top], [xl, c.top], [xl, yCut], [c.x0, c.tip]], [c.r, 0, 0, 0]);
  const R = g.roundedPolygon([[xr, c.top], [c.x1, c.top], [c.x1, c.tip], [xr, yCut]], [0, c.r, 0, 0]);
  return { d: L + R, xl, xr, yCut };
}

// The base cut at size n, with the changes a slot needs (width, notch slope), as { x0, x1, top, tip, r, slope }.
export function cutGeom(n, o = OPT) {
  const b = parseCut(CUTS[n === 24 ? 'glyph' : n]);
  const baseSlope = (b.tip - b.apex) / ((b.x1 - b.x0) / 2);
  const c = { ...b, slope: baseSlope };
  const co = n === 24 ? o.glyph : o['c' + n];
  if (n === 32) {
    if (co.widen === 'left') c.x0 -= 1; else if (co.widen === 'right') c.x1 += 1;
    if (co.feet === '2:3') c.slope = 2 / 3;
    else if (co.feet === 'apex') c.slope = (b.tip - b.apex) / ((c.x1 - c.x0) / 2);
  }
  if (n === 16) {
    const dw = co.width - (b.x1 - b.x0);
    if (dw === -1) { if (co.shift === 'left') c.x1 -= 1; else c.x0 += 1; }
    if (dw === 1) { if (co.shift === 'left') c.x0 -= 1; else c.x1 += 1; }
    if (co.feet === 'diag45') c.slope = 1;
  }
  if (n === 48 && co.feet === '2:3') c.slope = 2 / 3;
  return c;
}

export function draw(o = OPT) {
  const m = master(o), out = {}, info = { master: m, cuts: {} };
  out['mark.svg'] = g.svg(108, atScale(`<path fill="${PAPER}" fill-rule="evenodd" d="${m.d}"/>`),
    `C Split: the shared bookmark (candidates/base, ${MASTER.w} dp wide, top ${MASTER.top}) cut down its centre line by a ${g.fmt(m.gap)} dp slot, ${g.fmt(o.slot)} of its width. Built by build.mjs.`);
  for (const n of [48, 32, 16]) {
    const c = cutGeom(n, o), co = o['c' + n], h = halvesPx(c, co.slot, co.feet === 'stair' ? 'stair' : 'line');
    info.cuts[n] = { ...c, ...h, slot: co.slot, ratio: co.slot / (c.x1 - c.x0) };
    out[`cut-${n}.svg`] = g.svg(n, `${g.tileRect(n)}<path fill="${PAPER}" d="${h.d}"/>`,
      `C at ${n} px: bookmark ${c.x1 - c.x0} x ${c.tip - c.top} px, slot ${co.slot} px (${g.fmt(co.slot / (c.x1 - c.x0))} of the width). Built by build.mjs.`);
  }
  if (o.glyph.mode === 'plain') {
    out['glyph-24.svg'] = g.svg(24, `<path fill="#FFFFFF" d="${CUTS.glyph}"/>`, 'C glyph: the plain shared bookmark (candidates/base). Built by build.mjs.');
  } else {
    const c = cutGeom(24, o), h = halvesPx(c, o.glyph.slot, o.glyph.feet === 'stair' ? 'stair' : 'line');
    info.cuts[24] = { ...c, ...h, slot: o.glyph.slot, ratio: o.glyph.slot / (c.x1 - c.x0) };
    out['glyph-24.svg'] = g.svg(24, `<path fill="#FFFFFF" d="${h.d}"/>`, `C glyph, split: slot ${o.glyph.slot} px. Built by build.mjs.`);
  }
  return { out, info };
}

// ---- meta.json: numbers from the drawing; softness from the last `node tools/sheet.mjs candidates/C` (build again after it)
export function meta(info, metrics, base) {
  const m = info.master, f = v => g.fmt(Math.round(v * 100) / 100), c = info.cuts;
  const half = m.xl - m.x0, drawnH = metrics?.master?.bbox?.h ?? 52.1; // drawn height: top edge to the rounded tips (metrics bbox, as the base)
  const px1 = v => g.fmt(Math.round(v * 48 / 72 * 10) / 10); // dp to pixels on a 1× home screen (72 dp shown at 48 px)
  const dims = n => `${c[n].x1 - c[n].x0} × ${c[n].tip - c[n].top}`; // a cut's bookmark, width × height in px
  const sp = (mm, k) => mm?.cuts?.[k]?.soft_pct, sn = (mm, k) => mm?.cuts?.[k]?.soft;
  const soft = k => {
    const a = sp(metrics, k), b = sp(base, k);
    if (a == null) return 'softness not yet measured';
    if (a === b) return `${a}% soft, as the base`;
    // the same soft pixels over fewer paper pixels: say so, so a higher share doesn't read as a softer drawing
    return sn(metrics, k) === sn(base, k) ? `${a}% soft against the base's ${b}: the same ${sn(metrics, k)} soft pixels, a larger share because the slot takes paper away` : `${a}% soft against the base's ${b}`;
  };
  const corners = `A corner's radius follows what made it. The outline makes the square shoulders, which keep 4/34 of the width (${f(m.rTop)} dp); cuts make everything else, the notch's tips and the slot's four corners, and those all take the tips' 1.5/34 (${f(m.rTip)} dp). In the pixel cuts every cut corner is sharp, as the base draws its tips.`;
  return {
    title: 'Split bookmark',
    one: 'Shelf\'s bookmark cut once down the middle, so its two halves make a pause sign.',
    tags: ['One cut', 'Split down to 16 px', 'Plain glyph'],
    idea: 'Shelf\'s bookmark cut once down its centre line. The two halves stand as a pause sign, and the round outer shoulders and the two halves of the notch hold them together as one bookmark. A bookmark and a pause both mean stop here and come back later.',
    built: `The shared bookmark (candidates/base: ${MASTER.w} dp wide, top at ${MASTER.top}, shown at 90% about the canvas centre, as every option is: reach ${metrics?.master?.reach_dp ?? 29.3} of 33) with a slot down its centre line 1/7 of its width, ${f(m.gap)} dp. Each half is 3/7 of the width, ${f(half)} dp, so the slot is exactly a third of a half; a half is ${drawnH} dp tall, about 1 : ${Math.round(drawnH / half * 10) / 10}. I chose the width by eye between 0.12 and 0.15: at 0.12 the slot looked like a crack, and at 0.15 the halves began to come apart in the light colourway. 1/7 is also a ratio the 48 and 32 px cuts can draw exactly (${c[48].slot} px in ${c[48].x1 - c[48].x0}, and ${c[32].slot} in ${c[32].x1 - c[32].x0} once the 32 px bookmark gains a pixel), so one ratio holds from the launcher down to the 32 px cut; the 16 px cut is ${c[16].slot}/${c[16].x1 - c[16].x0}. Each foot runs along the base's notch line to the slot, which meets it ${f(m.yCut - m.apex)} dp below where the apex was, so the eye carries the V across the slot. Corner rule: ${corners[0].toLowerCase() + corners.slice(1)} On the bookmark itself this is the judges' rule by angle (90 degree shoulders at 4/34, 57 degree tips at 1.5/34). It differs only at the slot's two top corners, which are right angles. Drawn at the shoulder radius, each half became a rounded bar and the pair read as II before it read as a bookmark; drawn sharp, they looked harder than the tips at 4× and no different at 1×. At 1× the ${f(m.rTip)} dp corners are ${px1(m.rTip)} px, as crisp as the tips beside the ${px1(m.rTop)} px shoulders.`,
    corners,
    small: `The 48, 32 and 16 px cuts keep the slot; the glyph is the plain bookmark. 48 px: the base's ${dims(48)} px bookmark with a ${c[48].slot} px slot (1/7) between ${c[48].xl - c[48].x0} px halves, the feet on the base's notch line (${soft('cut-48')}). 32 px: the base's 20 px bookmark gains a pixel on the left, because a 3 px slot needs an odd width to sit between whole-pixel halves; on 20 px the centred slots nearest 1/7 are 2 px (0.1) and 4 px (0.2, round one's, which read as a pause sign first). So ${dims(32)} px with a ${c[32].slot} px slot (1/7), ${c[32].xl - c[32].x0} px halves at the base's notch slope, and the mark half a pixel left of the tile's centre (${soft('cut-32')}). 16 px: the bookmark gives up its right-hand pixel, ${dims(16)} px, so a ${c[16].slot} px slot can sit between two ${c[16].xl - c[16].x0} px halves (1/9, the nearest to 1/7 of any bookmark within a pixel of the base's 10 px; round one's 2 px in 10 was 0.2). The feet leave the base's notch line for whole-pixel stairs at 45 degrees, the angle of the brand's own 16 px notch, so they have no soft pixels; they meet the slot ${c[16].tip - c[16].yCut} px above the tips, level with the base's apex. This mark is also half a pixel left (${soft('cut-16')}). Glyph: the plain shared bookmark (${soft('glyph-24')}). Drawn split, it sat beside the media card's pause button and read as a second pause button, or as 'paused' in the status bar while Shelf was reading aloud; media-card.png in this folder shows both. So the status bar and the media notification show the bookmark, and the split lives in the launcher icon, the launch screens and the browser.`,
    risks: 'It reads as a pause sign, and pause on its own says something is playing now; it suggests listening only to someone who knows Shelf reads aloud. At 1× on a home screen, in the themed icon and at 16 px it can be taken for a pause button before a bookmark; the round shoulders and sloped feet keep it Shelf\'s. As the extension\'s toolbar button, which only saves, it could look like a control that pauses the page; the base\'s plain bookmark is the safer button there. The notch\'s apex, the bookmark\'s most recognisable point, is gone, and the shallow V survives as two sloped feet. The light colourway, ink halves on paper, is the nearest to ElevenLabs\' II, the best-known mark in text to speech. Measured from its app icon, ElevenLabs\' bars are 1 : 4.8 with square ends, the gap is as wide as a bar (a third of the pair\'s width), and the pair is 0.63 as wide as it is tall and a quarter of the tile\'s width. Shelf\'s halves are 1 : 2.8, the slot is a third of a half (a seventh of the pair), the pair is 0.83 as wide as it is tall and fills 60% of the tile\'s width, with round outer shoulders and sloped feet. At launcher sizes the difference is plain; at 16 px it comes down to the feet. Also near: a Roman numeral II, a parallel sign, a stock pause button. The mark is two pieces, so any one-colour use (print, emboss, a cut sticker) has to keep the slot open, and at 16 px it is one pixel wide. The 32 and 16 px cuts sit half a pixel left of their tiles\' centres: with an odd slot the mark is an odd number of pixels wide, so it can\'t be centred on an even tile.',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { out, info } = draw();
  for (const [f, s] of Object.entries(out)) fs.writeFileSync(path.join(HERE, f), s);
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8')); } catch { return null; } };
  fs.writeFileSync(path.join(HERE, 'meta.json'), JSON.stringify(meta(info, read('metrics.json'), read('../base/metrics.json')), null, 2) + '\n');
  const m = info.master;
  console.log('C written. master: slot', g.fmt(m.gap), 'dp; halves', g.fmt(m.xl - m.x0), 'dp wide; yCut', g.fmt(m.yCut), '; apex (gone)', g.fmt(m.apex));
  for (const [n, c] of Object.entries(info.cuts)) console.log(n, 'px:', c.x0, '..', c.x1, 'slot', c.slot, 'ratio', g.fmt(c.ratio), 'yCut', g.fmt(c.yCut));
}
