// Builds every Shelf icon and brand asset from the source SVGs in ./src.
//
//   npm install --no-save @resvg/resvg-js@2      (once, anywhere on NODE_PATH)
//   node shared/brand/build-icons.cjs
//
// Sources (the chosen mark, "Bookmark on Terracotta", 2026-09-27):
//   src/foreground.svg  adaptive-icon foreground on the 108 dp canvas (transparent)
//   src/background.svg  adaptive-icon background (the brand gradient)
//   src/monochrome.svg  one-colour silhouette for Android 13+ themed icons
//   src/small.svg       pixel-tuned 32 x 32 version for 16-32 px (favicon, toolbar)
//   src/full.svg        foreground on background, 108 canvas
// Everything else is derived here, so a change to the mark is made once in src.

const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const SRC = path.join(__dirname, 'src');
const OUT = path.join(__dirname, 'out');
const read = f => fs.readFileSync(path.join(SRC, f), 'utf8');
const inner = svg => svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const full = read('full.svg'), fg = read('foreground.svg'), mono = read('monochrome.svg'), small = read('small.svg');

// The launcher shows the central 72 of the 108 canvas: crop to it where an icon is shown unmasked.
const crop72 = svg => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="18 18 72 72">${inner(svg)}</svg>`;
// A rounded tile of the cropped mark inside a square with transparent padding (Chrome store guidance: 96 art in 128).
const tile = (size, pad, radius) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}">
  <defs><clipPath id="t"><rect x="${pad}" y="${pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" rx="${radius}"/></clipPath></defs>
  <g clip-path="url(#t)"><svg x="${pad}" y="${pad}" width="${size - 2 * pad}" height="${size - 2 * pad}" viewBox="18 18 72 72">${inner(full)}</svg></g></svg>`;
// Android notification small icon: white silhouette, tightly framed (art spans x 30-78, y 25-79 on the 108 canvas).
const notification = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="25 23 58 58">${inner(mono).replace(/#000000/g, '#FFFFFF')}</svg>`;
// Launch screen: the white mark alone, on the brand colour set in app config.
const splash = crop72(fg);

// Social card, 1200 x 630. The wordmark uses the system UI font until the name and type are final.
const og = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
  <rect width="1200" height="630" fill="#FCF7F6"/>
  <defs><clipPath id="m"><rect x="120" y="165" width="300" height="300" rx="68"/></clipPath></defs>
  <g clip-path="url(#m)"><svg x="120" y="165" width="300" height="300" viewBox="18 18 72 72">${inner(full)}</svg></g>
  <text x="484" y="300" font-family="Inter, Segoe UI, Roboto, sans-serif" font-size="112" font-weight="600" letter-spacing="-3" fill="#181D27">Shelf</text>
  <text x="488" y="372" font-family="Inter, Segoe UI, Roboto, sans-serif" font-size="38" fill="#535862">Save anything. Read it clean and offline,</text>
  <text x="488" y="422" font-family="Inter, Segoe UI, Roboto, sans-serif" font-size="38" fill="#535862">or listen to it.</text>
  <rect x="0" y="618" width="1200" height="12" fill="#F8EEEA"/>
  <rect x="0" y="618" width="744" height="12" fill="#B5542E"/>
</svg>`;

function png(svg, size, file){
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size }, font: { loadSystemFonts: true }, background: 'rgba(0,0,0,0)' });
  const buf = r.render().asPng();
  fs.mkdirSync(path.dirname(path.join(OUT, file)), { recursive: true });
  fs.writeFileSync(path.join(OUT, file), buf);
  return buf;
}
function copy(svg, file){ fs.mkdirSync(path.dirname(path.join(OUT, file)), { recursive: true }); fs.writeFileSync(path.join(OUT, file), svg); }
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
  fs.writeFileSync(path.join(OUT, file), Buffer.concat([head, ...pngs.map(p => p[1])]));
}

fs.rmSync(OUT, { recursive: true, force: true });

// Android / Expo (app.json: icon, android.adaptiveIcon.{foregroundImage, backgroundImage, monochromeImage}, splash plugin image, notification icon)
png(crop72(full), 1024, 'android/icon.png');
png(fg, 1024, 'android/adaptive-foreground.png');
png(read('background.svg'), 1024, 'android/adaptive-background.png');
png(mono, 1024, 'android/adaptive-monochrome.png');
png(splash, 1024, 'android/splash-icon.png');
png(notification, 96, 'android/notification-icon.png');
png(crop72(full), 512, 'android/play-store-icon.png');

// Browser extension (manifest "icons" and "action.default_icon"; Firefox also takes the SVG)
png(small, 16, 'extension/icon-16.png');
png(small, 32, 'extension/icon-32.png');
png(tile(48, 4, 10), 48, 'extension/icon-48.png');
png(tile(128, 16, 22), 128, 'extension/icon-128.png');
copy(small, 'extension/icon.svg');

// Website
copy(small, 'web/favicon.svg');
ico([[16, png(small, 16, 'web/.f16.png')], [32, png(small, 32, 'web/.f32.png')], [48, png(tile(48, 0, 10), 48, 'web/.f48.png')]], 'web/favicon.ico');
['.f16.png', '.f32.png', '.f48.png'].forEach(f => fs.rmSync(path.join(OUT, 'web', f)));
png(crop72(full), 180, 'web/apple-touch-icon.png');
png(tile(192, 0, 42), 192, 'web/icon-192.png');
png(tile(512, 0, 112), 512, 'web/icon-512.png');
png(full, 512, 'web/maskable-512.png');
png(og, 1200, 'web/og-card.png');
fs.writeFileSync(path.join(OUT, 'web/site.webmanifest'), JSON.stringify({
  name: 'Shelf', short_name: 'Shelf', theme_color: '#B5542E', background_color: '#FCF7F6', display: 'standalone',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2) + '\n');

const list = [];
(function walk(d){ for (const f of fs.readdirSync(d)) { const p = path.join(d, f); fs.statSync(p).isDirectory() ? walk(p) : list.push(`${path.relative(OUT, p).replace(/\\/g, '/')}  ${fs.statSync(p).size} B`); } })(OUT);
console.log(list.join('\n'));
