// node docs/design/icons/negative-space/tools/freeze-d.mjs
// Writes shared/brand/src from candidates/D, once, when D became the app icon (flow decision 94, 9 October 2026).
// After that the files in shared/brand/src are frozen artwork, owned by the brand: they never change when this study
// changes. Kept so the provenance of every frozen file is on record.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STUDY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const D = path.join(STUDY, 'candidates', 'D');
const SRC = path.resolve(STUDY, '..', '..', '..', '..', 'shared', 'brand', 'src');
const read = f => fs.readFileSync(path.join(D, f), 'utf8');
const body = svg => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<!--[\s\S]*?-->/g, '').trim();
const file = (box, comment, shapes) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}">\n  <!--\n${comment.trim().split('\n').map(l => '    ' + l.trim()).join('\n')}\n  -->\n  ${shapes}\n</svg>\n`;
const FROZEN = 'FROZEN ARTWORK (flow decision 94). Written from docs/design/icons/negative-space/candidates/D by tools/freeze-d.mjs on 9 October 2026; never regenerate it.';

const mark = body(read('mark.svg'));            // <g transform="... scale(0.9) ..."><path fill="#F3F2EE" .../></g>
if (!/^<g transform="translate\(54 54\) scale\(0\.9\) translate\(-54 -54\)"><path fill="#F3F2EE" fill-rule="evenodd" d="[^"]+"\/><\/g>$/.test(mark)) throw new Error('unexpected mark.svg: ' + mark.slice(0, 120));
const BG = '<rect width="108" height="108" fill="#111112"/>';

const out = {
  'background.svg': file('0 0 108 108', `${FROZEN}
    The adaptive icon's background: graphite, the dark theme's background (#111112), flat.`, BG),
  'foreground.svg': file('0 0 108 108', `${FROZEN}
    The adaptive icon's foreground: D, "split and play". Shelf's bookmark in paper (#F3F2EE), cut twice, with nothing
    stamped on: a slot down the centre line, 1/7 of the width, makes the halves a pause; the notch's right flank carried
    on across the left half, in a cut 0.8 of the slot, makes the left tail a play. The notch is at 30 degrees, so the
    plays those angles make are equilateral, and the bookmark is exactly three of them tall: four notch depths. Drawn
    43.5 x 50.23 dp and shown at 90% about the canvas centre (39.15 x 45.21 dp), for room round the mark. One colour;
    every dark shape is a hole.`, mark),
  'full.svg': file('0 0 108 108', `${FROZEN}
    background.svg, then foreground.svg, on the 108 dp canvas. build-icons.cjs checks that these shapes match the two layers.`, BG + mark),
  'monochrome.svg': file('0 0 108 108', `${FROZEN}
    Android 13+ themed icon: foreground.svg's shape in one colour, holes and all, so the themed icon is the same drawing.`, mark.replace('fill="#F3F2EE"', 'fill="#000000"')),
  'small.svg': file('0 0 16 16', `${FROZEN}
    16 px (the favicon, the ICO's 16 entry, the browser tab): the split alone, 9 x 10 px, a 1 px slot and 45 degree
    stairs for feet, half a pixel left of centre. A 3 px play turned into a nick in the bar at this size.`, body(read('cut-16.svg'))),
  'small-28.svg': file('0 0 28 28', `${FROZEN}
    28 px (the extension options page's logo, 1x and 2x): 19 x 22 px, notch 5.5 (four notch depths tall), 3 px slot,
    the diagonal dropped 3 px; an 8 px play, its tip 1.1 px short of the slot. Half a pixel left of centre.`, body(read('cut-28.svg'))),
  'small-32.svg': file('0 0 32 32', `${FROZEN}
    32 px (the ICO's 32 entry, the tab at 2x): 21 x 24 px, notch 6, 3 px slot, the diagonal dropped 3 px; a 9 px play,
    its tip 1.1 px short of the slot. Half a pixel left of centre.`, body(read('cut-32.svg'))),
  'small-48.svg': file('0 0 48 48', `${FROZEN}
    48 px (the extension's icon-48 and the ICO's 48 entry): 28 x 32 px, notch 8, 4 px slot, the diagonal dropped 4 px;
    a 12 px play, its tip 1.5 px short of the slot.`, body(read('cut-48.svg'))),
  'toolbar-16.svg': file('0 0 16 16', `${FROZEN}
    The extension's toolbar button at 16 px: the plain bookmark on D's proportions, 10 x 12 px with a 3 px notch (four
    notch depths tall). The extension only saves, and D's split reads as a pause control at toolbar sizes.`, body(read('ext-16.svg'))),
  'toolbar-32.svg': file('0 0 32 32', `${FROZEN}
    The extension's toolbar button at 32 px (2x): the plain bookmark on D's proportions, 20 x 24 px with a 6 px notch.`, body(read('ext-32.svg'))),
  'glyph-24.svg': file('0 0 24 24', `${FROZEN}
    The status bar's and media notification's small icon: the plain bookmark on D's proportions, 16 x 18 px, white.
    A play-and-pause glyph would sit beside the media card's real play and pause button.`, body(read('glyph-24.svg'))),
};
for (const [f, s] of Object.entries(out)) fs.writeFileSync(path.join(SRC, f), s);
// Today's dark launch screen had its own drawing; D's launch screens are derived from foreground.svg in the build.
for (const f of ['splash-dark.svg']) if (fs.existsSync(path.join(SRC, f))) fs.rmSync(path.join(SRC, f));
console.log('wrote', Object.keys(out).join(', '), 'into', SRC);
