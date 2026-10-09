// h2 · Two saves. Writes mark.svg, cut-48.svg, cut-32.svg, cut-16.svg and glyph-24.svg.
// Run from anywhere: node build.mjs
//
// Two of Shelf's bookmarks, the same size, one in front of the other. The back one sits half a width to the right and
// one notch lower, so its left flank runs exactly through the front one's right tip (and its apex sits under that
// tip). Then the only part of the back bookmark that shows under the front one's tail is its lower-left corner: a
// triangle whose top edge is the front bookmark's right flank, whose bottom edge is the back bookmark's own left
// flank and whose back is its left side. The notch flanks run at 32.9 degrees, as the app's play icon does (Lucide,
// 32.7), so that corner is a play. No bookmark is cut: the play comes from where the two are placed.
//
// Geometry (B front, A back; s = 2 notch / w, the flanks' slope), kept general for the record:
//   A's left side = B's centre line + slide;  A's tip line = B's tip line + s (w/2 - slide).
// slide 0 (used everywhere): the back bookmark drops a whole notch and its apex meets the front's right tip.
// A slide a little over the gap lets the back bookmark's apex clear the gap so its notch shows, but the play loses
// 2 s slide of its height; drawn and rejected for that.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAPER = '#F3F2EE', WHITE = '#FFFFFF';
const out = (f, s) => fs.writeFileSync(path.join(HERE, f), s);
const f3 = g.fmt;

// The pair on any grid. xB: front's left side; topB: front's top; w; h: top to sharp tips; notch; slide; gapX: the
// gap between the front's right side and the strip; gapV: how far the play's top edge sits below the front's right
// flank, measured vertically; radii. withPlay false drops the play (for the smallest cut).
function twoSaves({ xB, topB, w, h, notch, slide = 0, gapX, gapV, rTop, rTip, rCut = rTip, withPlay = true }) {
  const half = w / 2, s = notch / half;
  const cxB = xB + half, x1B = xB + w, y1B = topB + h;
  const xA = cxB + slide, cxA = xA + half, x1A = xA + w, y1A = y1B + s * (half - slide), topA = y1A - h;
  const front = g.bookmark({ cx: cxB, top: topB, w, h, notch, rTop, rTip });
  // A's strip right of the front: its bottom is A's left flank up to the apex (if the apex clears the gap), then
  // A's right flank down to the right tip
  const sx = x1B + gapX;
  const bottomA = x => (x <= cxA ? y1A - s * (x - xA) : y1A - notch + s * (x - cxA));
  const stripPts = sx < cxA
    ? [[sx, topA], [x1A, topA], [x1A, y1A], [cxA, y1A - notch], [sx, bottomA(sx)]]
    : [[sx, topA], [x1A, topA], [x1A, y1A], [sx, bottomA(sx)]];
  const stripR = sx < cxA ? [rCut, rTop, rTip, 0, rCut] : [rCut, rTop, rTip, rCut];
  const strip = g.roundedPolygon(stripPts, stripR);
  // A's corner under the front's right flank (lowered by the gap): the play
  const backTop = y1B - notch + s * (xA - cxB) + gapV;
  const d = (y1A - backTop) / (2 * s);
  const tip = [xA + d, y1A - s * d];
  const play = g.roundedPolygon([[xA, backTop], tip, [xA, y1A]], [rCut, rCut, rTip]);
  return { d: withPlay ? g.join(front, strip, play) : g.join(front, strip), playH: y1A - backTop, playD: d, tip,
    box: [xB, topB, x1A, y1A], y1A, topA, x1A };
}

// ---------------------------------------------------------------------------------------------------------------
// Master, 108 dp canvas.
// slide 0: tried 3.75 so the back bookmark's notch showed, but the play shrank to 11.6 x 8.9 dp (8 x 6 px on a 1x
// home screen) and no longer matched the cuts; at 0 it is 17.1 x 13.2 and the rule is exact: half a width, one notch.
const W = 31, k = W / 34;
const M = { w: W, notch: 11 * k, h: 42 * k, rTop: 4 * k, rTip: 1.5 * k, gap: 2.5, slide: 0 };
{
  const s = 2 * M.notch / M.w, c = Math.cos(Math.atan(s));
  const dropA = s * (W / 2 - M.slide);
  const spanX = 1.5 * W + M.slide, spanY = M.h + dropA - 0.84 * M.rTip;
  const xB = 54 - spanX / 2, topB = 54 - spanY / 2;
  const r = twoSaves({ xB, topB, w: W, h: M.h, notch: M.notch, slide: M.slide, gapX: M.gap, gapV: M.gap / c, rTop: M.rTop, rTip: M.rTip });
  M.info = r;
  out('mark.svg', g.svg(108, `<path fill="${PAPER}" fill-rule="evenodd" d="${r.d}"/>`,
    `h2 · Two saves. Two of Shelf's bookmarks, ${W} dp wide in today's proportions (notch ${f3(M.notch)}, shoulders r ${f3(M.rTop)}, tips r ${f3(M.rTip)}). ` +
    `The back one sits ${f3(W / 2 + M.slide)} right and ${f3(dropA)} lower, so its left flank runs through the front one's right tip; gaps ${M.gap} dp. ` +
    `Its corner under the front tail is a play ${f3(r.playH)} tall and ${f3(r.playD)} deep. Pair box centred. Built by build.mjs.`));
}
// ---------------------------------------------------------------------------------------------------------------
// The tuned cuts: one unit = one pixel, the same rule as the master: the back bookmark exactly half a width right
// and one notch lower, its apex under the front tip.
const CUTS = {
  48: { xB: 9, topB: 8, w: 20, h: 25, notch: 7, gapX: 3, gapV: 4, rTop: 2.5, rTip: 1,
        note: 'Two 20 x 25 px bookmarks, notch 7 px (slope 0.7). Front 9..29 from y 8; back 19..39 from y 15, its apex under the front tip at (29, 33). 3 px gap beside the front; the play drops 4 px (3.3 px square) under the front right flank: 10 px tall (30 to 40), 7.1 deep. Pair 9..39, centred.' },
  32: { xB: 5, topB: 5, w: 14, h: 17, notch: 5, gapX: 2, gapV: 3, rTop: 1.5, rTip: 0.75,
        note: 'Two 14 x 17 px bookmarks, notch 5 px (slope 0.71). Front 5..19 from y 5; back 12..26 from y 10. 2 px gap; the play drops 3 px (2.5 square): 7 px tall (20 to 27), 4.9 deep. The pair is 21 px wide, so it sits half a pixel left of centre to keep every straight edge on a whole pixel.' },
};
for (const [n, p] of Object.entries(CUTS)) {
  const r = twoSaves(p);
  out(`cut-${n}.svg`, g.svg(+n, `${g.tileRect(+n)}<path fill="${PAPER}" fill-rule="evenodd" d="${r.d}"/>`, `h2 at ${n} px. ${p.note}`));
}

// 16 px, in whole pixels: the play would be two or three lopsided pixels, so it is dropped (the brief allows the
// smallest cut to lose its innermost element); the pair stays. Front 8 x 9 px (2..10, from y 3);
// the back one half a width right and one notch (2 px) lower, showing as a 3 px strip (11..14) right of a 1 px gap,
// with its own notch's right half. Notches 2 px deep in 2-1-1 steps.
{
  const front = 'M3 3H9A1 1 0 0 1 10 4V12H8V11H7V10H5V11H4V12H2V4A1 1 0 0 1 3 3Z';
  const strip = 'M11 5H13A1 1 0 0 1 14 6V14H12V13H11Z';
  out('cut-16.svg', g.svg(16, `${g.tileRect(16)}<path fill="${PAPER}" fill-rule="evenodd" d="${front + strip}"/>`,
    'h2 at 16 px, in whole pixels: the front bookmark 8 x 9 px (2..10, 3..12) with a 2 px stepped notch, the back one 4 px right and 2 px lower, showing as a 3 px strip (11..14, 5..14) right of a 1 px gap. The play is dropped at this size.'));
}

// Status-bar glyph: white on transparent, inside the central 20 x 20.
{
  const p = { xB: 3, topB: 3, w: 12, h: 15, notch: 4, gapX: 2, gapV: 2, rTop: 1.5, rTip: 0.5 };
  const r = twoSaves(p);
  out('glyph-24.svg', g.svg(24, `<path fill="${WHITE}" fill-rule="evenodd" d="${r.d}"/>`,
    `h2 glyph. Two 12 x 15 px bookmarks, notch 4 (slope 2/3): front 3..15 from y 3, back 9..21 from y 7. 2 px gap; the play drops 2 px: ${f3(r.playH)} tall, ${f3(r.playD)} deep.`));
}
console.log(JSON.stringify({ master: { playH: f3(M.info.playH), playD: f3(M.info.playD) } }));
