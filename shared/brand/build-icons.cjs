// Builds every Kefli icon and brand asset from the source SVGs in ./src.
//
//   npm install --prefix ~/.cache/kefli-resvg @resvg/resvg-js@2      (once, anywhere outside the repo)
//   NODE_PATH=~/.cache/kefli-resvg/node_modules node shared/brand/build-icons.cjs
//
// Sources: the app icon of flow decision 94, D "split and play", frozen as artwork (README.md):
//   src/background.svg  adaptive-icon background: graphite (#111112), flat
//   src/foreground.svg  adaptive-icon foreground: the bookmark in paper, cut twice (the halves a pause, the left tail a
//                       play), shown at 90% about the canvas centre; one colour, every dark shape a hole
//   src/monochrome.svg  Android 13+ themed icon: the foreground's shape in one colour (checked below)
//   src/full.svg        background then foreground, 108 canvas (checked against the two layers)
//   src/small.svg       16 px (favicon, the ICO's 16): the split alone, on its pixel grid
//   src/small-28.svg    28 px (the extension options page's logo, 1x and 2x)
//   src/small-32.svg    32 px (the ICO's 32, the tab at 2x)
//   src/small-48.svg    48 px (the extension's icon-48, the ICO's 48)
//   src/toolbar-16.svg  the extension's toolbar button at 16 px: the plain bookmark (the extension only saves)
//   src/toolbar-32.svg  the extension's toolbar button at 32 px (2x): the plain bookmark
//   src/glyph-24.svg    the status bar's and media notification's small icon: the plain bookmark, white
// Everything else is derived here, so a change to the mark is made once in src: both launch screens come from the
// foreground, in ink for the light one and as drawn for the dark one. The icon never comes from the cover generator;
// only the strip of covers on the OG card and the Play feature graphic is drawn from it, at build time.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Resvg } = require('@resvg/resvg-js');
const ShelfCover = require(path.join(__dirname, '..', 'cover', 'cover-v1.js'));

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'out');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const inner = svg => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const shapes = svg => inner(svg).replace(/<!--[\s\S]*?-->/g, '').replace(/>\s+</g, '><').trim();

const full = read('full.svg'), fg = read('foreground.svg'), bg = read('background.svg'), mono = read('monochrome.svg');
const small = read('small.svg'), small32 = read('small-32.svg'), small48 = read('small-48.svg'), small28 = read('small-28.svg');
const toolbar16 = read('toolbar-16.svg'), toolbar32 = read('toolbar-32.svg'), glyph = read('glyph-24.svg');
if (shapes(full) !== shapes(bg) + shapes(fg)) throw new Error('src/full.svg must be background.svg followed by foreground.svg');

// Fingerprint chrome, light theme (shared/tokens/tokens.json 0.2.0). Copied, like the icon's own colours.
const INK = '#17171A', PAPER = '#F3F2EE', MUTED = '#5C5B56', EDGE_OPACITY = 0.09;   // cover edge: ink at 9%
const GRAPHITE = '#111112';                                                           // the dark theme's background

// The rule decision 94 rests on: the mark is one paper shape with real holes, so the light launch screen, the themed
// icon and the glyph are the same drawing. The foreground is fills only, in paper alone; the background is one flat
// graphite rect; the themed layer is the foreground's shape exactly.
function checkLayers(){
  const f = shapes(fg);
  if (/stroke|mask|clip-path|filter|gradient|opacity/i.test(f)) throw new Error('src/foreground.svg: fills only (no stroke, mask, clip, filter, gradient or opacity)');
  const fills = [...new Set([...f.matchAll(/fill="([^"]+)"/g)].map(m => m[1].toUpperCase()))];
  if (fills.length !== 1 || fills[0] !== PAPER) throw new Error('src/foreground.svg: paper only, got ' + fills.join(', '));
  if (shapes(bg) !== `<rect width="108" height="108" fill="${GRAPHITE}"/>`) throw new Error('src/background.svg: one flat graphite rect');
  if (shapes(mono) !== f.split(PAPER).join('#000000')) throw new Error("src/monochrome.svg must be foreground.svg's shape in #000000");
  for (const [name, svg] of [['small.svg', small], ['small-28.svg', small28], ['small-32.svg', small32], ['small-48.svg', small48], ['toolbar-16.svg', toolbar16], ['toolbar-32.svg', toolbar32]])
    if (!new RegExp(`^<rect width="(\\d+)" height="\\1" rx="[\\d.]+" fill="${GRAPHITE}"/><path fill="${PAPER}"`).test(shapes(svg))) throw new Error(`src/${name}: a graphite tile, then the mark in paper`);
  if (!/^<path fill="#FFFFFF" d="[^"]+"\/>$/.test(shapes(glyph))) throw new Error('src/glyph-24.svg: one white path');
  return 'one paper shape with holes; themed layer and tiles as drawn';
}
const layers = checkLayers();

// The launcher shows the central 72 of the 108 canvas: crop to it where an icon is shown unmasked.
const crop72 = svg => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72">${inner(svg)}</svg>`;
// A rounded tile of the cropped mark inside a square with transparent padding (Chrome store guidance: 96 art in 128).
const tile = (size, pad, radius) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
  <defs><clipPath id="t"><rect x="${pad}" y="${pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" rx="${radius}"/></clipPath></defs>
  <g clip-path="url(#t)"><svg x="${pad}" y="${pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" viewBox="18 18 72 72">${inner(full)}</svg></g></svg>`;
// Android notification small icon: glyph-24.svg, a white silhouette drawn on the 24 dp artboard inside Material's
// 20 dp live area (2 dp padding).
const notification = glyph;
// The same glyph as an Android VectorDrawable, the form a small icon should take in res/drawable.
const glyphPath = glyph.match(/<path fill="#FFFFFF" d="([^"]+)"\/>/)[1];
const vectorDrawable = `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by shared/brand/build-icons.cjs from src/glyph-24.svg. Do not edit. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp" android:height="24dp"
    android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF" android:pathData="${glyphPath}"/>
</vector>
`;
// Launch screens: the mark alone, from the foreground. The light one (on paper, #F3F2EE in app config) draws it in
// ink; the dark one (on #111112) as drawn, in paper. Both have the same footprint, so the mark sits in the same place.
const splash = crop72(fg.split(PAPER).join(INK)), splashDark = crop72(fg);
// The options page inlines its 28 px logo into a page that holds other inline icons, so the copy has no comments,
// a clip id of its own and is hidden from assistive technology (the name "Kefli" sits beside it).
const LOGO_ID = 'kefliLogo28';
const inlineLogo = '<!-- Generated by shared/brand/build-icons.cjs from src/small-28.svg. Do not edit. -->\n'
  + `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="28" height="28" aria-hidden="true" focusable="false">`
  + shapes(small28).replace(/id="tile"/g, `id="${LOGO_ID}"`).replace(/url\(#tile\)/g, `url(#${LOGO_ID})`) + '</svg>\n';
if (/id="tile"|#tile\b/.test(inlineLogo)) throw new Error('options logo: the clip id was not renamed');
// Maskable web icon: the platform masks the whole image and keeps a centred circle of radius 40%.
// Cropping the 108 canvas to 86 puts the art at 38% and sizes the mark close to the native launcher icon.
const MASKABLE_BOX = '11 11 86 86';
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MASKABLE_BOX}">${inner(full)}</svg>`;

// The strip on the OG card and the feature graphic: real covers, drawn by cover v1 from the sha256 of each
// normalised URL. These are the Fingerprint board's eight sample articles, as shared/cover/fixtures.json records them.
if (ShelfCover.version !== 'cover-v1') throw new Error('expected cover-v1, got ' + ShelfCover.version);
const STRIP = [
  '5971c1f7c8fb6934c0db39d1cf17cfede14197bc087924dab4cc59ae13aa8cff',   // theguardian.com, the quiet return of the read-it-later app
  '34331f690e10f4e9184b0c53e40388e8caeb8bd26c8f44a34ae11f7f9e62213d',   // bitcoinmagazine.com, why relays, not servers
  '9f40a2ca59c109dd3b5c4f5c3c88fd84ff5579309ebdec62e3294eebb5d4fbd4',   // stratechery.com, aggregation theory ten years on
  '08246b635f8db8e14834c0a17044949b490975582e1f61be89c8e6062ae4d30e',   // arstechnica.com, Readability is quietly everywhere
  '862030a9aef3d2bd9f5f93d4986d9c9029bbf72e7f574169014dda44a9fc93ca',   // nytimes.com, the long road back to the office
  '02a662fcfb69bec8626bbd14b40ca01b06cfa05b3bb4af946c28168f03ff9e34',   // theatlantic.com, reading long things
  '340732b408a9f0f2e531a95f3c3be03d89fc3f51f5c74e3372ae7fae25e8e79c',   // aeon.co, the case for boring technology
  '11ac0d2ee6159446a9271841f8dc2e330c9a9c1d64d74d96be0b8519a7e46389',   // wired.com, your bookmarks are a graveyard
];
// One cover as a row draws it (depth 3), clipped to its corner radius, with the inset hairline every cover gets.
let clipId = 0;
function cover(hash, x, y, s, rx){
  const id = 'c' + clipId++;
  return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${rx}"/></clipPath></defs>`
    + `<g clip-path="url(#${id})"><svg x="${x}" y="${y}" width="${s}" height="${s}" viewBox="0 0 800 800">${inner(ShelfCover.svg(hash, { depth: 3 }))}</svg></g>`
    + `<rect x="${x + 0.5}" y="${y + 0.5}" width="${s - 1}" height="${s - 1}" rx="${rx - 0.5}" fill="none" stroke="${INK}" stroke-opacity="${EDGE_OPACITY}"/>`;
}
const strip = (x, y, s, gap, rx) => STRIP.map((h, i) => cover(h, x + i * (s + gap), y, s, rx)).join('');
// The icon as a tile on a card: graphite on paper needs no edge of its own.
function iconTile(x, y, s, rx){
  const id = 'i' + clipId++;
  return `<defs><clipPath id="${id}"><rect x="${x}" y="${y}" width="${s}" height="${s}" rx="${rx}"/></clipPath></defs>`
    + `<g clip-path="url(#${id})"><svg x="${x}" y="${y}" width="${s}" height="${s}" viewBox="18 18 72 72">${inner(full)}</svg></g>`;
}

// The name and tagline are set in Archivo, the interface's typeface, from the repo's own static instances
// (shared/fonts/out), so the cards come out the same on any machine. Regenerate them when the name is final.
const FONT_DIR = path.join(__dirname, '..', 'fonts', 'out');
const FONT_FILES = ['Archivo-400.ttf', 'Archivo-600.ttf'].map(f => path.join(FONT_DIR, f));
const NAME_FONT = 'Archivo-600', TEXT_FONT = 'Archivo-400';
// Social card, 1200 x 630: the icon tile, then the name, the tagline and a short strip of saves, bottom-aligned with the tile.
const og = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="${PAPER}"/>
  ${iconTile(120, 165, 300, 68)}
  <text x="484" y="258" font-family="${NAME_FONT}" font-size="112" letter-spacing="-3" fill="${INK}">Kefli</text>
  <text x="488" y="326" font-family="${TEXT_FONT}" font-size="34" fill="${MUTED}">Save anything. Read it clean and offline,</text>
  <text x="488" y="370" font-family="${TEXT_FONT}" font-size="34" fill="${MUTED}">or listen to it.</text>
  ${strip(488, 409, 56, 10, 6)}
</svg>`;
// Google Play feature graphic, 1024 x 500, opaque. Tile, name and strip sit centred, clear of Play's edge cutoff zones;
// the strip starts under the name's ink and the name and strip are centred on the tile.
const feature = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 500">
  <rect width="1024" height="500" fill="${PAPER}"/>
  ${iconTile(262, 150, 200, 45)}
  <text x="506" y="265" font-family="${NAME_FONT}" font-size="120" letter-spacing="-3" fill="${INK}">Kefli</text>
  ${strip(512, 297, 28, 4, 3)}
</svg>`;
// Chrome Web Store small promo tile, 440 x 280, opaque: the feature graphic's layout at 0.7, centred.
const promo = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 440 280">
  <rect width="440" height="280" fill="${PAPER}"/>
  ${iconTile(44, 70, 140, 31.5)}
  <text x="214.8" y="150.5" font-family="${NAME_FONT}" font-size="84" letter-spacing="-2.1" fill="${INK}">Kefli</text>
  ${strip(219, 173, 20, 3, 2)}
</svg>`;

// Minimal PNG writer: resvg's own encoder always writes RGBA, and we need RGB for Play and our own
// downsampled pixels for the small sizes.
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]); len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
function encodePng(w, h, channels, px){
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  const stride = w * channels, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function write(file, buf){ fs.mkdirSync(path.dirname(path.join(OUT, file)), { recursive: true }); fs.writeFileSync(path.join(OUT, file), buf); return buf; }
// Only the two cards set text, from the repo's Archivo files; nothing reads the system's fonts.
const render = (svg, width) => new Resvg(svg, { fitTo: { mode: 'width', value: width },
  font: svg.includes('<text') ? { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: TEXT_FONT } : { loadSystemFonts: false },
  background: 'rgba(0,0,0,0)' }).render();

// Up to 48 px, render at 8x and box-average each 8 x 8 block. resvg's own 4 x 4 sampling counts edges that
// run through pixel corners on one side only, which makes the symmetric notch lopsided at 16 and 32 px.
const SS = 8;
function png(svg, size, file){
  if (size > 48) return write(file, render(svg, size).asPng());
  const img = render(svg, size * SS), src = img.pixels, W = size * SS, out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0, 0];
    for (let j = 0; j < SS; j++) for (let i = 0; i < SS; i++) { const o = ((y * SS + j) * W + x * SS + i) * 4; for (let c = 0; c < 4; c++) acc[c] += src[o + c]; }
    const a = acc[3] / (SS * SS), o = (y * size + x) * 4;   // pixels are premultiplied: average, then divide by alpha
    for (let c = 0; c < 3; c++) out[o + c] = a ? Math.min(255, Math.round(acc[c] / acc[3] * 255)) : 0;
    out[o + 3] = Math.round(a);
  }
  return write(file, encodePng(size, size, 4, out));
}
// Opaque 24-bit PNG (no alpha channel), as Google Play asks for the feature graphic.
function pngRgb(svg, width, file){
  const img = render(svg, width), src = img.pixels, n = img.width * img.height, out = Buffer.alloc(n * 3);
  for (let p = 0; p < n; p++) {
    if (src[p * 4 + 3] !== 255) throw new Error(`${file}: pixel ${p} is not opaque`);
    src.copy(out, p * 3, p * 4, p * 4 + 3);
  }
  const buf = write(file, encodePng(img.width, img.height, 3, out));
  if (buf[25] !== 2) throw new Error(`${file}: expected colour type 2`);
  return buf;
}
const copy = (svg, file) => write(file, svg);
// ICO with PNG payloads (supported by every current browser and Windows since Vista).
function ico(pngs, file){
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(([size, buf], i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3); head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(offset, e + 12); offset += buf.length;
  });
  write(file, Buffer.concat([head, ...pngs.map(p => p[1])]));
}

// The farthest painted pixel from the centre of a square render, as a fraction of its side. Counting each pixel
// to its far corner makes this an upper bound, at most two pixel diagonals above the true reach.
function reach(svg, size){
  const img = render(svg, size), px = img.pixels, c = (size - 1) / 2;
  let r = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (px[(y * size + x) * 4 + 3]) r = Math.max(r, Math.hypot(x - c, y - c));
  return (r + Math.SQRT1_2) / size;   // to the pixel's far corner
}
// The mark must stay inside Android's 66 dp safe circle (radius 33 of 108) and the maskable icon's 40% circle.
function checkSafeZones(){
  const fgReach = reach(fg, 3240) * 108, maskReach = reach(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MASKABLE_BOX}">${inner(fg)}</svg>`, 860);
  if (fgReach > 33) throw new Error(`foreground reaches ${fgReach.toFixed(2)} dp from the centre, outside the 66 dp safe circle`);
  if (maskReach > 0.4) throw new Error(`maskable mark reaches ${(maskReach * 100).toFixed(1)}%, outside the 40% safe circle`);
  return `safe zones: mark ${fgReach.toFixed(2)} of 33 dp; maskable mark ${(maskReach * 100).toFixed(1)}% of 40%`;
}
const zones = checkSafeZones();
// The two launch screens are one drawing in two colours: the same footprint, and nothing painted outside it.
function checkSplashes(){
  const N = 512, l = render(splash, N).pixels, d = render(splashDark, N).pixels;
  for (let p = 0; p < N * N; p++) if (Math.abs(l[p * 4 + 3] - d[p * 4 + 3]) > 1) throw new Error(`launch screens: pixel ${p} differs in coverage`);
  return 'both launch screens one drawing';
}
const splashes = checkSplashes();

fs.rmSync(OUT, { recursive: true, force: true });

// Android / Expo (app.json: icon, android.adaptiveIcon.{foregroundImage, backgroundImage, monochromeImage}, splash plugin image, notification icon)
png(crop72(full), 1024, 'android/icon.png');
png(fg, 1024, 'android/adaptive-foreground.png');
png(bg, 1024, 'android/adaptive-background.png');
png(mono, 1024, 'android/adaptive-monochrome.png');
png(splash, 1024, 'android/splash-icon.png');
png(splashDark, 1024, 'android/splash-icon-dark.png');
png(notification, 96, 'android/notification-icon.png');   // the glyph at 4x, for anything that needs a bitmap
copy(vectorDrawable, 'android/kefli_notification.xml');
png(crop72(full), 512, 'android/play-store-icon.png');
pngRgb(feature, 1024, 'android/play-feature-graphic.png');

// Browser extension (manifest "icons" and "action.default_icon"; Firefox also takes SVGs, keyed by size).
// 16 and 32 are the toolbar button, the plain bookmark (decision 94: the extension only saves, and the split reads as
// a pause control at toolbar sizes); 48 is the tuned cut of the icon, which Chrome's extensions page shows; 128 is the
// 108 dp drawing with the Chrome Web Store's 16 px of padding. The options page inlines options-logo-28.svg.
png(toolbar16, 16, 'extension/icon-16.png');
png(toolbar32, 32, 'extension/icon-32.png');
png(small48, 48, 'extension/icon-48.png');
png(tile(128, 16, 22), 128, 'extension/icon-128.png');
copy(toolbar16, 'extension/icon-16.svg');
copy(toolbar32, 'extension/icon-32.svg');
copy(inlineLogo, 'extension/options-logo-28.svg');
pngRgb(promo, 440, 'extension/cws-promo-tile.png');
// addons.mozilla.org's listing icon, uploaded in the Developer Hub: no padding, since AMO shows it at 64 and 32 and
// would otherwise take icon-128's Chrome padding; the corners in the web icons' proportion (42 in 192).
png(tile(64, 0, 14), 64, 'extension/amo-icon-64.png');

// Website. favicon.svg stays the 16 px drawing because tabs show it at 16 CSS px; the ICO carries the 16, 32 and 48 cuts.
copy(small, 'web/favicon.svg');
ico([[16, png(small, 16, 'web/.f16.png')], [32, png(small32, 32, 'web/.f32.png')], [48, png(small48, 48, 'web/.f48.png')]], 'web/favicon.ico');
['.f16.png', '.f32.png', '.f48.png'].forEach(f => fs.rmSync(path.join(OUT, 'web', f)));
png(crop72(full), 180, 'web/apple-touch-icon.png');
png(tile(192, 0, 42), 192, 'web/icon-192.png');
png(tile(512, 0, 112), 512, 'web/icon-512.png');
png(maskable, 512, 'web/maskable-512.png');
png(og, 1200, 'web/og-card.png');
// id, start_url and scope are fixed before the site first ships, so an install from a deep link still
// launches the home page and later changes never turn existing installs into a separate app.
// theme_color is ink and background_color is paper, the Fingerprint chrome's light text and page.
fs.writeFileSync(path.join(OUT, 'web/site.webmanifest'), JSON.stringify({
  id: '/', start_url: '/', scope: '/',
  name: 'Kefli', short_name: 'Kefli', theme_color: INK, background_color: PAPER, display: 'standalone',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2) + '\n');

// Every PNG is the size its use asks for.
const SIZES = {
  'android/icon.png': [1024, 1024], 'android/adaptive-foreground.png': [1024, 1024], 'android/adaptive-background.png': [1024, 1024],
  'android/adaptive-monochrome.png': [1024, 1024], 'android/splash-icon.png': [1024, 1024], 'android/splash-icon-dark.png': [1024, 1024],
  'android/notification-icon.png': [96, 96],
  'android/play-store-icon.png': [512, 512], 'android/play-feature-graphic.png': [1024, 500],
  'extension/icon-16.png': [16, 16], 'extension/icon-32.png': [32, 32], 'extension/icon-48.png': [48, 48], 'extension/icon-128.png': [128, 128],
  'extension/cws-promo-tile.png': [440, 280], 'extension/amo-icon-64.png': [64, 64],
  'web/apple-touch-icon.png': [180, 180], 'web/icon-192.png': [192, 192], 'web/icon-512.png': [512, 512], 'web/maskable-512.png': [512, 512], 'web/og-card.png': [1200, 630],
};
for (const [file, [w, h]] of Object.entries(SIZES)) {
  const b = fs.readFileSync(path.join(OUT, file));
  if (b.readUInt32BE(16) !== w || b.readUInt32BE(20) !== h) throw new Error(`${file}: expected ${w} x ${h}, got ${b.readUInt32BE(16)} x ${b.readUInt32BE(20)}`);
}

const list = [];
(function walk(d){ for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : list.push(`${path.relative(OUT, p).replace(/\\/g, '/')}  ${fs.statSync(p).size} B`); } })(OUT);
console.log(list.join('\n'));
console.log([layers, zones, splashes, 'every PNG at its expected size', 'feature graphic 24-bit RGB'].join('; '));
