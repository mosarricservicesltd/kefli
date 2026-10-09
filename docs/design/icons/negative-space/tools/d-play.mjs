// node docs/design/icons/negative-space/tools/d-play.mjs
// The play-weight study. D as chosen has its diagonal cut at 0.8 of the slot's width, for a bigger play; this draws the
// alternative it was chosen over, both cuts one width (drops of 5 and 4 px at 48 and 32 for D's 4 and 3), into
// candidates/D-even with candidates/D/build.mjs, and writes the three-play construction overlay for D and D-even, at
// the same 90% as their masters.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from './geom.mjs';
import { build, master, OPT } from '../candidates/D/build.mjs';
import { atScale } from '../candidates/base/build.mjs';

const STUDY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINE = '#E08200', f = g.fmt, r2 = v => Math.round(v * 100) / 100;

function overlay(m) {
  const x0 = m.x0, cx = 54, y1 = m.y1, n = m.n;
  const tri = (P, fill) => `<path d="M${P.map(p => f(p[0]) + ' ' + f(p[1])).join('L')}Z" fill="${fill ? LINE : 'none'}" fill-opacity="${fill ? 0.16 : 0}" stroke="${LINE}" stroke-width="0.67" stroke-linejoin="round"/>`;
  const T1 = [[x0, y1 - 2 * n], [x0, y1], [cx, y1 - n]], T2 = [[x0, y1 - 2 * n], [cx, y1 - n], [cx, y1 - 3 * n]], T3 = [[x0, y1 - 2 * n], [cx, y1 - 3 * n], [x0, y1 - 4 * n]];
  const top = `<path d="M${f(x0 - 4)} ${f(y1 - 4 * n)}H${f(cx + 4)}" stroke="${LINE}" stroke-width="0.67" stroke-dasharray="1.8 1.3"/>`;
  return g.svg(108, atScale(tri(T1, true) + tri(T2, false) + tri(T3, true) + top), 'Construction only: three plays, right, left and right, interlocked up the left half. Not part of the mark.');
}

const EVEN = { diag: 1, cv: { 48: 5, 32: 4, 28: 4 } };
const dir = path.join(STUDY, 'candidates', 'D-even');
fs.mkdirSync(dir, { recursive: true });
const info = build(EVEN, dir);
const d = master(OPT), p = info.master;   // d: D as chosen, p: the one-width alternative
fs.writeFileSync(path.join(STUDY, 'candidates', 'D', 'overlay.svg'), overlay(d));
fs.writeFileSync(path.join(dir, 'overlay.svg'), overlay(p));
const grow = d.playH / p.playH - 1;
fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
  title: 'D, one-width cuts',
  one: 'D with both cuts one width, the version before the bigger play.',
  idea: 'D with the slot and the diagonal one width, 1/7 of the bookmark\'s, so the two cuts look made by one blade; its play is smaller than D\'s.',
  built: `Slot and diagonal both ${f(r2(p.slot))} dp (before the 90%). Play ${f(r2(p.playH))} × ${f(r2(p.depth))} dp, its tip ${f(r2(p.tipGap))} dp short of the slot; D's bigger play is ${Math.round(grow * 100)}% taller, its tip ${f(r2(d.tipGap))} dp short.`,
  small: `48 px: the diagonal dropped 5 px (D: 4), ${f(r2(info.cuts[48].band))} px square to itself; the play ${info.cuts[48].playH} px tall, its tip ${f(r2(info.cuts[48].tipGap))} px short of the slot. 32 px: dropped 4 px (D: 3); the play ${info.cuts[32].playH} px tall, its tip ${f(r2(info.cuts[32].tipGap))} px short of the slot. 16 px, the glyph and the extension's buttons are D's.`,
  risks: 'The play is smaller against the two bars, which the reviewer with no context read as pause first.',
}, null, 2) + '\n');
console.log(JSON.stringify({ D: { playH: r2(d.playH), depth: r2(d.depth), tipGap: r2(d.tipGap), cut: r2(d.cut), grow: Math.round(grow * 1000) / 10 + '%' },
  'D-even': { playH: r2(p.playH), depth: r2(p.depth), tipGap: r2(p.tipGap), cut: r2(p.cut) },
  cuts: { 48: { playH: info.cuts[48].playH, tipGap: r2(info.cuts[48].tipGap), band: r2(info.cuts[48].band) }, 32: { playH: info.cuts[32].playH, tipGap: r2(info.cuts[32].tipGap), band: r2(info.cuts[32].band) } } }));
