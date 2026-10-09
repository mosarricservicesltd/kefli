// The shared bookmark every finalist is cut from: the master at 43.5 dp wide with its top at 27.1 (as large as the
// 66 dp safe circle allows), and the cuts' bookmarks at 28 × 34 px (48), 20 × 24 (32), 10 × 12 (16) and 16 × 20 (glyph),
// the sizes most of round one converged on. Solid: no holes. Also the plain bookmark for the extension's toolbar.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as g from '../../tools/geom.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = (f, s) => fs.writeFileSync(path.join(here, f), s);

export const MASTER = { cx: 54, top: 27.1, w: 43.5 };
export const CUTS = {
  48: 'M13 7H35A3 3 0 0 1 38 10V41L24 32L10 41V10A3 3 0 0 1 13 7Z',
  32: 'M8 4H24A2 2 0 0 1 26 6V28L16 21.5L6 28V6A2 2 0 0 1 8 4Z',
  16: 'M4 2H12A1 1 0 0 1 13 3V14L8 11L3 14V3A1 1 0 0 1 4 2Z',
  glyph: 'M6 2H18A2 2 0 0 1 20 4V22L12 17L4 22V4A2 2 0 0 1 6 2Z',
};
// The launcher drawing is shown at 90% of its drawn size, about the canvas centre, for room round the mark (Richard's
// designer friend, 9 October 2026), as decision 70's foreground.svg showed its mark at 96%. Every option's
// mark.svg wraps its drawing in this group; the pixel cuts and the glyph keep their size.
export const SCALE = 0.9;
export const atScale = body => `<g transform="translate(54 54) scale(${SCALE}) translate(-54 -54)">${body}</g>`;
out('mark.svg', g.svg(108, atScale(`<path fill="#F3F2EE" d="${g.bookmark(MASTER)}"/>`), 'Shared base: Shelf\'s bookmark, drawn 43.5 dp wide with its top at 27.1, solid, shown at 90% about the canvas centre'));
for (const n of [48, 32, 16]) out(`cut-${n}.svg`, g.svg(n, `${g.tileRect(n)}<path fill="#F3F2EE" d="${CUTS[n]}"/>`));
out('glyph-24.svg', g.svg(24, `<path fill="#FFFFFF" d="${CUTS.glyph}"/>`));
out('meta.json', JSON.stringify({
  title: 'Plain bookmark',
  idea: 'Shelf\'s bookmark, solid, at the size every finalist shares: the silhouette the cuts are made in, and the plain mark for places that only save, such as the extension\'s toolbar button.',
  built: 'geom.bookmark at 43.5 dp wide with today\'s proportions and its top at 27.1, the largest the 66 dp safe circle allows, then shown at 90% about the canvas centre (39.2 dp wide), as every option is, for room round the mark. Cuts: 28 × 34 px at 48 with a 9 px notch, 20 × 24 at 32 with a 6.5 px notch, 10 × 12 at 16 with a 3 px notch, and 16 × 20 for the glyph with a 5 px notch.',
  small: 'Nothing to drop: every size is the bookmark alone.',
  risks: 'No second idea: it says bookmark and nothing about listening.',
}, null, 2) + '\n');
