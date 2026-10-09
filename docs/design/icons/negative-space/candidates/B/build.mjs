// B · Play and pause. Richard's idea: the bookmark, a dark play inside it and a paper pause inside that. Run: node build.mjs.
//
// Cut from the shared bookmark (../base) with A's construction (../A/build.mjs): the same notch-parallel play, larger here
// so a pause fits, and the same corner rule. Where the pause is dropped (32 and 16 px, the glyph), B's files are A's,
// written from A's build each time this runs, so run it again after any change to ../A/build.mjs (B also takes A's axis).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';
import { MASTER, atScale } from '../base/build.mjs';
import { BOOK, R_PLAY, rBar, notchPlay, playInset, walls, outline, gap, bookPts, cutBook, pathEl, writeShared, f2, A as PA } from '../A/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = (f, s) => fs.writeFileSync(path.join(HERE, f), s);

// ---------------------------------------------------------------------------------------------------------------
// The play: as large as 6 dp of paper above it and along the notch allow, on A's axis (y 49.8), so its walls at the
// flat side and the tip come out as A's do, the tip a little closer than the flat side.
export const B = {
  wall: 6,                     // paper above the play and along the notch (the strap), the least anywhere
  ym: PA.ym,                   // the same axis as A's play
  // the pause: Shelf's own, the app's Lucide pause drawn filled at a 1.75 stroke: bars 5.75 x 17.75 with a 2.25 gap
  gapRatio: 5.75 / 2.25,       // bar width / gap (2.56)
  tall: 17.75 / 5.75,          // bar height / bar width (3.09)
  ring: 3.5,                   // least dark round the pause (at the right bar's outer corners)
  dx: -1,                      // the pause's centre from the play's incircle centre, towards the flat side: there the
                               // dark band along the flat side (parallel to the bar, so it looks narrower) comes out at
                               // 4.5 against 3.5 at the corners, which reads as an even ring
};

// The 48 px cut keeps the pause, at its smallest: 2 px bars with a 2 px gap (the least that stays open), 7 px tall,
// on whole pixels, with 3 px of dark at the flat side. The play grows until the bars' outer corners clear its slanted
// edges by 2.5 px, which leaves 3.3 px of paper above it and 3.4 along the notch.
export const B48 = { xl: 15, ym: 21.5, bars: [[18, 18, 2, 7], [22, 18, 2, 7]], ring: 2.5 };
export function playB() {
  const ins = playInset(BOOK.slope, R_PLAY), n = Math.hypot(1, BOOK.slope);
  const yt = BOOK.top + B.wall - ins.top, yb = 2 * B.ym - yt;
  const xl = BOOK.x0 + (BOOK.tips - yb - B.wall * n) / BOOK.slope;     // the strap is B.wall at this flat side
  return notchPlay(xl, B.ym, yb - yt);
}
const rectPts = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
export function pause(cx, cy, b) {
  const gp = b / B.gapRatio, H = b * B.tall;
  return { b, gp, H, r: rBar(b), cx, cy, rects: [[cx - gp / 2 - b, cy - H / 2, b, H], [cx + gp / 2, cy - H / 2, b, H]] };
}
// the largest pause, centred at (cx, cy), with at least B.ring of dark between it and the drawn play
export function fitPause(PL, cx, cy, ring) {
  const least = P => Math.min(...P.rects.map(r => gap(outline(rectPts(...r), P.r, 0.04), PL)));
  let lo = 1, hi = 8;
  for (let i = 0; i < 24; i++) { const b = (lo + hi) / 2; if (least(pause(cx, cy, b)) >= ring) lo = b; else hi = b; }
  const P = pause(cx, cy, lo);
  return { ...P, least: least(P) };
}

function cut48() {
  const b = cutBook(48), r = R_PLAY * (b.x1 - b.x0) / MASTER.w;
  const ringAt = h => { const PL = outline(notchPlay(B48.xl, B48.ym, h, b.slope).pts, r, 0.02);
    return Math.min(...B48.bars.map(br => gap(outline(rectPts(...br), 0, 0.02), PL))); };
  let lo = 18, hi = 30;                                   // the smallest play that gives the bars their ring
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (ringAt(m) >= B48.ring) hi = m; else lo = m; }
  const p = notchPlay(B48.xl, B48.ym, hi, b.slope), w = walls(b, p, r), ring = ringAt(hi);
  const flat = B48.bars[0][0] - B48.xl;
  out('cut-48.svg', g.svg(48, g.tileRect(48) + pathEl(g.join(b.d, g.roundedPolygon(p.pts, r), ...B48.bars.map(br => g.rect(...br)))),
    `B at 48 px: the shared bookmark (28 x 34) with a play parallel to this cut's notch, ${f2(p.h)} x ${f2(p.w)} px, corners r ${f2(r)}, ` +
    `flat side on x ${B48.xl}; walls ${f2(w.flat)} at the flat side, ${f2(w.tip)} at the tip, ${f2(w.top)} above, strap ${f2(w.strap)}. ` +
    `Pause on whole pixels: bars 2 x 7 px, 2 px apart (x 18 to 24, y 18 to 25), ${flat} px of dark at the flat side and ${f2(ring)} at the corners.`));
  return { h: f2(p.h), w: f2(p.w), walls: Object.fromEntries(Object.entries(w).map(([k, v]) => [k, f2(v)])), ring: f2(ring), flat };
}

function buildB() {
  const p = playB(), w = walls(BOOK, p, R_PLAY), ic = g.incircle(p.pts);
  const PL = outline(p.pts, R_PLAY, 0.04);
  const P = fitPause(PL, ic.cx + B.dx, ic.cy, B.ring);
  const flatGap = P.rects[0][0] - p.xl;
  const BK = outline(bookPts(BOOK), [BOOK.rTop, BOOK.rTop, BOOK.rTip, 0, BOOK.rTip], 0.05);
  const least = gap(BK, outline(p.pts, R_PLAY, 0.05));
  const d = g.join(g.bookmark(MASTER), g.roundedPolygon(p.pts, R_PLAY), ...P.rects.map(r => g.rect(...r, P.r)));
  out('mark.svg', g.svg(108, atScale(pathEl(d)),
    `B Play and pause, built by build.mjs. The shared bookmark (base: 43.5 dp wide, top at 27.1), shown at 90%. Play hole parallel to the notch, ` +
    `${f2(p.h)} x ${f2(p.w)} dp, corners r ${f2(R_PLAY)} (the tail tips'); walls ${f2(w.flat)} at the flat side, ${f2(w.tip)} at the drawn tip, ` +
    `${f2(w.top)} above, strap ${f2(w.strap)} (least ${f2(least)}). Pause island: bars ${f2(P.b)} x ${f2(P.H)} dp, ${f2(P.gp)} apart, corners r ${f2(P.r)}, ` +
    `centred ${f2(-B.dx)} dp left of the play's incircle (${f2(ic.cx)}, ${f2(ic.cy)}, r ${f2(ic.r)}); ${f2(flatGap)} dp of dark at the flat side, ${f2(P.least)} at the bars' outer corners.`));
  const shared = writeShared(HERE);   // A's cuts: 32, 16 and the glyph stay A's files exactly (no pause there)
  const c48 = cut48();                // and the 48 is replaced by B's own, with the pause
  const info = { master: { h: f2(p.h), w: f2(p.w), xl: f2(p.xl), ym: p.ym, walls: Object.fromEntries(Object.entries(w).map(([k, v]) => [k, f2(v)])), least: f2(least),
    incircle: { cx: f2(ic.cx), cy: f2(ic.cy), r: f2(ic.r) }, pause: { bar: f2(P.b), tall: f2(P.H), gap: f2(P.gp), r: f2(P.r), cx: f2(P.cx), flatGap: f2(flatGap), ring: f2(P.least) } },
    cut48: c48, shared };
  console.log(JSON.stringify(info));
  return info;
}
buildB();
