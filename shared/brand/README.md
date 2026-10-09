# Shelf brand assets

**The app icon is D, "split and play"** (flow decision 94, chosen by Richard on 9 October 2026, replacing decisions 70 and 72). Shelf's bookmark in paper (#F3F2EE) on graphite (#111112, the dark theme's background), cut twice with nothing stamped on:

- a **slot** down the centre line, 1/7 of the bookmark's width, makes the two halves a pause;
- a **diagonal** that carries the notch's right edge on across the left half, 0.8 of the slot's width, makes the left tail a play pointing into the gap.

The notch is at 30 degrees, so the plays its two angles make up the left half are equilateral, and the bookmark is exactly three of them tall (four notch depths). The master is drawn 43.5 × 50.23 dp and shown at 90% about the canvas centre, 39.15 × 45.21 dp of the 72 dp the launcher shows, for room round the mark. The study it came from, with every candidate, the judges' notes and two blind reads, is `docs/design/icons/negative-space/`.

## The rule the build checks

The mark is **one paper shape, and every dark shape inside it is a hole**. So the light launch screen (the mark in ink on paper), the dark one (in paper on graphite), Android's themed icon and the monochrome layer are all the same drawing, and they can't drift apart. `build-icons.cjs` refuses to run unless the foreground is fills only, in paper alone; the background is one flat graphite rect; `monochrome.svg` is the foreground's shape exactly; `full.svg` is the background then the foreground; and every cut is a graphite tile with the mark in paper.

Two places show the **plain bookmark** in D's proportions in place of D:

- **The extension's toolbar button**, at 16 and 32 px (`toolbar-16.svg`, `toolbar-32.svg`). The extension only saves, and at toolbar sizes D's split reads as a pause control.
- **The status bar's and media notification's glyph** (`glyph-24.svg`). A play-and-pause glyph would sit beside the media card's real play and pause button.

The browser tab (the favicon), the launcher and every size from 48 px up show D.

## The frozen rule

Everything in `src/` is frozen artwork, owned by the brand. It was written once from the study's `candidates/D` by `docs/design/icons/negative-space/tools/freeze-d.mjs` on 9 October 2026, and it never changes when the study changes or the app is renamed. The colours are copied in as hex, not linked to `shared/tokens/tokens.json`, so a later token change can't recolour the icon. Changing the icon takes a new flow decision; then edit `src/` and rebuild every output.

## Sources

| File | What it is |
|---|---|
| `src/background.svg` | Adaptive-icon background: graphite (#111112), flat |
| `src/foreground.svg` | Adaptive-icon foreground: D in paper, its drawing in a group scaled to 90% about the canvas centre, transparent around it; one compound path with even-odd holes |
| `src/monochrome.svg` | Android 13+ themed icon: the foreground's shape in #000000, holes and all |
| `src/full.svg` | Background then foreground, on the 108 dp canvas. The build refuses to run if it doesn't match the two layers |
| `src/small.svg` | 16 px (the favicon, the ICO's 16 entry): the split alone, 9 × 10 px, a 1 px slot and 45 degree stairs for feet, half a pixel left of centre. A 3 px play turned into a nick in the bar at this size |
| `src/small-28.svg` | 28 px (the extension options page's logo, 1x and 2x): 19 × 22 px, notch 5.5, 3 px slot, the diagonal dropped 3 px; an 8 px play |
| `src/small-32.svg` | 32 px (the ICO's 32 entry, the tab at 2x): 21 × 24 px, notch 6, 3 px slot, the diagonal dropped 3 px; a 9 px play, half a pixel left of centre |
| `src/small-48.svg` | 48 px (the extension's icon-48, the ICO's 48 entry): 28 × 32 px, notch 8, 4 px slot, the diagonal dropped 4 px; a 12 px play |
| `src/toolbar-16.svg` | The extension's toolbar button at 16 px: the plain bookmark, 10 × 12 px with a 3 px notch |
| `src/toolbar-32.svg` | The extension's toolbar button at 32 px: the plain bookmark, 20 × 24 px with a 6 px notch |
| `src/glyph-24.svg` | The status bar's and media notification's small icon: the plain bookmark, 16 × 18 px, white, inside the 24 dp artboard's 2 dp padding |

Every cut is drawn on its own pixel grid: straight edges on whole pixels, cut corners sharp, and the notch, the diagonal and the play's edges the only diagonals. Each keeps the rule that the height is four notch depths.

## Build

`build-icons.cjs` derives every size and format into `out/`. Run it after any change to `src/`, with `@resvg/resvg-js@2` on `NODE_PATH`:

```
npm install --prefix ~/.cache/shelf-resvg @resvg/resvg-js@2     # once, anywhere outside the repo
NODE_PATH=~/.cache/shelf-resvg/node_modules node shared/brand/build-icons.cjs
```

It reads `shared/cover/cover-v1.js` only for the strip of covers on the OG card and the feature graphic, and `shared/fonts/out` for the name and tagline on those cards, which are set in Archivo so they come out the same on any machine. Besides the layer checks above, every run checks that the mark stays inside Android's 66 dp safe circle (it reaches 28.3 dp) and the maskable icon's 40% circle (32.9%), that the two launch screens are one drawing, that the feature graphic is opaque 24-bit RGB, and that every PNG has its expected size. Sizes up to 48 px are rendered at 8× and box-averaged, so the diagonals rasterise evenly.

| Output | Use |
|---|---|
| `out/android/icon.png` (1024) | Expo `icon` (legacy launcher) |
| `out/android/adaptive-{foreground,background,monochrome}.png` (1024) | Expo `android.adaptiveIcon` foreground, background, monochrome (themed icons) |
| `out/android/splash-icon.png` (1024) | Light launch screen image: the mark in ink, for a paper background (#F3F2EE) |
| `out/android/splash-icon-dark.png` (1024) | Dark launch screen image: the mark in paper, for the dark background (#111112). Same footprint as the light one |
| `out/android/shelf_notification.xml` | Status-bar and media-notification small icon as a VectorDrawable (24 dp, white), from `glyph-24.svg`. See the wiring notes |
| `out/android/notification-icon.png` (96) | The same glyph as a bitmap, for anything that needs a PNG |
| `out/android/play-store-icon.png` (512) | Google Play listing icon (32-bit PNG) |
| `out/android/play-feature-graphic.png` (1024 × 500) | Google Play feature graphic, 24-bit PNG with no alpha, as Play asks: paper ground, the icon tile, the name in ink and a strip of eight covers under it |
| `out/extension/icon-{16,32}.png` | Manifest `icons` and `action.default_icon` at 16 and 32: the toolbar button, the plain bookmark |
| `out/extension/icon-{48,128}.png` | The same keys at 48 (the tuned cut of D, which Chrome's extensions page shows) and 128 (the 108 dp drawing as a tile with the Chrome Web Store's 16 px of transparent padding) |
| `out/extension/icon-16.svg`, `icon-32.svg` | Firefox manifest `icons` keys "16" and "32": the toolbar button |
| `out/extension/options-logo-28.svg` | The options page's logo: `small-28.svg` ready to inline in the brand row's 28 px slot, comments stripped and `aria-hidden`, since the name sits beside it |
| `out/web/favicon.svg`, `favicon.ico` (16/32/48), `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `maskable-512.png`, `site.webmanifest` | Website. `favicon.svg` is the 16 px cut; the ICO carries the 16, 32 and 48 px cuts. The manifest's `theme_color` is ink (#17171A) and its `background_color` paper (#F3F2EE), and it fixes `id`, `start_url` and `scope` at `/` so installs keep one identity |
| `out/web/og-card.png` (1200 × 630) | Social sharing card: paper ground, the icon tile, the name in ink, the tagline in the muted grey (#5C5B56) and a short strip of eight covers under it |

**The cards.** The strip is real cover v1 output at depth 3, the Fingerprint board's eight sample articles (sha256 of each normalised URL, as `shared/cover/fixtures.json` records them), drawn at build time; if cover v1 changes before it ships, the strip changes with it and the icon doesn't. "Shelf" is the working name: regenerate both cards when the name is final.

## Wiring notes for the mobile build

- **Launcher layers:** `apps/mobile/app.json` takes the icon and the adaptive layers from `apps/mobile/assets/brand`, copies of `out/android/icon.png` and `adaptive-*.png`. Copy them again after any rebuild.
- **Splash:** `apps/mobile/app.json` configures the expo-splash-screen plugin: `splash-icon.png` on paper, #F3F2EE, and in its `dark` block `splash-icon-dark.png` on the dark theme's background, #111112, at an `imageWidth` of 200 dp, from copies in `apps/mobile/assets/brand`. The two images have the same footprint, so the mark sits in the same place in either theme; Android picks the dark pair from the phone's dark theme before the app has run, and the app follows the same setting (flow decision 16). The splash hides when the app is ready, the plugin's default. It is baked into the native project at prebuild, so copy the two PNGs again after a rebuild and make a new development build. At 200 dp the mark reaches about 79 dp from the centre; up to about 244 dp keeps it inside Android 12's 192 dp icon circle.
- **Media notification icon:** `apps/mobile/plugins/with-shelf-notification.js` copies `out/android/shelf_notification.xml` into the app's drawables at prebuild, and shelf-voice's service sets it on media3's notification provider by name, so a rebuild of the brand files reaches the app at the next prebuild.

The in-app interface icons are Lucide at 1.75 stroke, plus Shelf's own skip ±15 pair and speed-read icon in `docs/design/icons/app/` (decisions 62 and 65).
