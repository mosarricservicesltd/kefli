// Chooses the mark for any cover by sampling the colours just outside the bookmark and the bar, where the mark meets
// the pattern (a ring 2.5 units out from every edge, in the 108 dp canvas, after the mark's 96% scale).
//   bookmark: paper only (the dark launch screen's) when the ground is dark and paper stands out from at least 90% of
//             its surroundings; otherwise paper with an ink outline, which stands out wherever paper or ink does.
//   bar:      the ink bar (today's) unless the paper bar (outline ring and read part in paper) stands out from clearly
//             more of its surroundings.
//   fade:     set when the chosen bookmark or bar still fails to stand out from 20% or more of its surroundings.
// "Stands out" means a contrast of 2:1 or more against the sampled colour.
const { Resvg } = require('@resvg/resvg-js');
const path = require('path');
const C = require(path.join(__dirname, '..', '..', '..', '..', 'shared', 'cover', 'cover-v1.js'));
const PAPER = '#F3F2EE', INK = '#17171A';
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lumRgb = c => { const v = c.map(x => x / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
const contrastL = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
const LP = lumRgb(hexRgb(PAPER)), LI = lumRgb(hexRgb(INK));
const t = v => 54 + (v - 54) * 0.96;
const OUT = 2.5;
// the bookmark's outline: top edge, both sides, and the two legs of the notch, each pushed OUT units outward
const BOOK = [];
for (let x = 39; x <= 69; x += 1.5) BOOK.push([x, 25 - OUT]);
for (let y = 27; y <= 64; y += 1.5) { BOOK.push([37 - OUT, y]); BOOK.push([71 + OUT, y]); }
for (let k = 0; k <= 1; k += 0.08) { BOOK.push([37 + 17 * k, 64.24 - 8.24 * k + OUT]); BOOK.push([71 - 17 * k, 64.24 - 8.24 * k + OUT]); }
// the bar: above and below its length, and beyond both ends
const BAR = [];
for (let x = 30; x <= 78; x += 1.5) { BAR.push([x, 70 - OUT]); BAR.push([x, 79 + OUT]); }
for (const y of [72, 74.5, 77]) { BAR.push([30 - OUT, y]); BAR.push([78 + OUT, y]); }
const BOOK_T = BOOK.map(([x, y]) => [t(x), t(y)]), BAR_T = BAR.map(([x, y]) => [t(x), t(y)]);

function choose(hash, opts = {}) {
  const svg = C.svg(hash, { depth: 1, size: 216, grey: opts.grey || null });
  const img = new Resvg(svg, { fitTo: { mode: 'width', value: 216 } }).render();
  const lumAt = (x, y) => { const i = (Math.min(215, Math.floor(y * 2)) * 216 + Math.min(215, Math.floor(x * 2))) * 4; return lumRgb([img.pixels[i], img.pixels[i + 1], img.pixels[i + 2]]); };
  const P = C.palette(hash);
  const ground = opts.grey ? C.grey[opts.grey].ground : P.ground;
  const darkGround = lumRgb(hexRgb(ground)) < 0.2;
  const share = (pts, test) => pts.filter(([x, y]) => test(lumAt(x, y))).length / pts.length;
  const bookPaper = share(BOOK_T, l => contrastL(LP, l) >= 2);
  const bookEither = share(BOOK_T, l => contrastL(LP, l) >= 2 || contrastL(LI, l) >= 2);
  const barInk = share(BAR_T, l => contrastL(LI, l) >= 2);
  const barPaper = share(BAR_T, l => contrastL(LP, l) >= 2);
  const outline = !(darkGround && bookPaper >= 0.9);
  const paperBar = barPaper > barInk + 0.1;
  const bookSeen = outline ? bookEither : bookPaper, barSeen = paperBar ? barPaper : barInk;
  return { outline, paperBar, fade: bookSeen < 0.8 || barSeen < 0.8, bookSeen: +bookSeen.toFixed(2), barSeen: +barSeen.toFixed(2), ground };
}
module.exports = { choose };

if (require.main === module) {
  const base = '2c76160cd38e939a7bffbe46ab3cdf5c88871873a92ec375b0fffb35a41eab13';
  for (const [name, col] of [['today C·L·063', '2c7601c0'], ['teal C·D·210', '9555010c'], ['gold C·D·090', '4000010c']])
    console.log(name, JSON.stringify(choose(col + base.slice(8))));
}
