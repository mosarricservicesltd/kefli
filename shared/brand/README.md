# Shelf brand assets

**The app icon is "C·L·063 with the paper mark"** (flow decision 70, chosen by Richard on 2026-10-04, completing decision 67). Fingerprint is Shelf's visual direction (decision 65) and Terracotta is retired (decision 66), so the icon is a cover picked by hand from the cover generator with today's bookmark and progress bar standing on it.

- **The cover:** cover v1 for `2c7601c0d38e939a7bffbe46ab3cdf5c88871873a92ec375b0fffb35a41eab13`, drawn at depth 1. That is candidate No. 12's shape (seed "shelf/icon/2") recoloured through its colour bytes: complement scheme, light ground, hue 63°. One 8-unit leaf, "bands" at rotation 2: orange quarter-disc bands (#E08200) about the bottom-right corner on a warm cream ground (#F4ECD8).
- **The mark:** the bookmark (square shoulders, notched tail) on the reading-progress bar, inverted for the light ground: paper fill (#F3F2EE, the light theme's `background` token), an ink outline (#17171A, the light theme's `text` token) and the read two thirds of the bar in ink.
- **Themed icons and the notification glyph** stay the one-colour bookmark and bar of decision 55, unchanged.

Richard compared the options in `docs/design/icons/fingerprint-icons.html` and `docs/design/icons/fingerprint-icon-12.html`; the mark is that page's `fgMark(true)`.

## The frozen rule

Everything in `src/` is frozen artwork, owned by the brand. It never changes when the cover generator changes (a seam fix, cover v2) or when the app is renamed.

- `src/background.svg` was generated from `ShelfCover` once, on 2026-10-04, from `shared/cover/cover-v1.js` as it stood then (version `cover-v1`, file sha256 `50a774f5f8a245e41dcb01b59f3a2730e3d07e96b64aa1baf24d1016cde699fb`), and written out as four static shapes on the 108 dp canvas. It matches the generator's own drawing to within arc flattening (about 0.01 dp). Never regenerate it. Later the same day `cover-v1.js` gained the seam rule (`shared/cover/README.md`, Drawing), so its sha256 no longer matches the one above. For this cover the rule only adds strips along the canvas's bottom and right edges, in the colours already there, so the generator still draws the same picture; the frozen file doesn't depend on it either way.
- The colours are copied in as hex, not linked to `shared/tokens/tokens.json`, so a later token change can't recolour the icon.
- Changing the icon takes a new flow decision. Then edit `src/` and rebuild every output.

Two details differ from the comparison page, both on purpose:

- The mark is scaled to 96% about the canvas centre. Drawn at full size, its ink outline reaches 34.3 dp from the centre at the bar's ends, outside Android's 66 dp safe circle (radius 33). At 96% the farthest ink is 32.9 dp. The build checks this.
- The 16, 28, 32 and 48 px cuts are redrawn on their own pixel grids (below). The comparison page put the 108 dp mark's thin outline on them, which was too faint at 16 px.

And the dark launch screen has its own drawing of the mark (`src/splash-dark.svg`), because the paper mark's ink outline and read part vanish on a dark background.

## Sources

| File | What it is |
|---|---|
| `src/background.svg` | Adaptive-icon background: the frozen cover on the 108 dp canvas |
| `src/foreground.svg` | Adaptive-icon foreground: the paper mark, transparent around it. Each shape has a 3-unit ink stroke under its paper fill (the picture `paint-order="stroke"` gives, written as layers so every tool draws it) |
| `src/monochrome.svg` | One-colour bookmark and bar for Android 13+ themed icons; the bar breaks where reading stops. Unchanged since decision 55 |
| `src/full.svg` | Background then foreground. The build refuses to run if it doesn't match the two layers |
| `src/small.svg` | 16 px cut on a 32 × 32 grid (two units per pixel). A 1 px ink outline on whole pixels, about three times the 108 dp drawing's at that size; the notch at 45° so it survives; a 3 px bar whose unread part is a 1 px paper slot and whose read part is two thirds of it (8 of 12 px), as on the 108 dp drawing and the 48 px cut (the 32 and 28 px cuts land within a pixel of it, at 15 of 24 and 13 of 20). The cover is simplified to one arc (orange with the cream inside the r = 72 band edge): at 16 px the cream corner and the orange core were a few soft pixels that read as a chipped corner |
| `src/small-32.svg` | 32 px cut (the toolbar at 2x). A 2 px ink outline on whole pixels, matching the 16 px cut's weight and still holding up where a browser scales it to 20 or 24 px; the master's shallow notch; the full cover |
| `src/small-48.svg` | 48 px cut (the extension's 48 px icon and the ICO's 48 entry). A 3 px ink outline on whole pixels, a sixteenth of the tile as on the 16 and 32 px cuts, so the three carry the same weight (the 108 dp drawing shrunk to 48 had about 0.8 px); the 32 px cut's layout at 1.5 times, with the bookmark one pixel taller so every edge lands on a whole pixel; a 9 px bar with a 3 px slot and the read part 24 of its 36 px; the master's shallow notch; the full cover |
| `src/small-28.svg` | 28 px cut (the extension options page's logo, at 1x and 2x). A 2 px ink outline on whole pixels at 1x and 4 device pixels at 2x; the bar 20 px with a 2 px slot and the read part 13 of its 20; the master's shallow notch; the full cover. `small-32.svg` drawn at 28 was the other option: at 1x its edges fall between pixels, so the outline, the notch and the slot go soft, and at 2x it is still a little soft. The tuned cut is sharp at both |
| `src/splash-dark.svg` | The launch-screen mark for the dark background (#111112, the dark theme's `background`). `foreground.svg`'s bookmark with the ink turned to paper, and the bar as a paper outline ring and read pill: a solid paper bookmark, a paper outline round the bar, the read two thirds in paper and the unread slot open to the background. It has the light splash's size and footprint. The build refuses to run if its bookmark drifts from `foreground.svg`'s |

## Build

`build-icons.cjs` derives every size and format into `out/`. Run it after any change to `src/`:

```
npm install --no-save @resvg/resvg-js@2
node shared/brand/build-icons.cjs
```

It reads `shared/cover/cover-v1.js` only for the strip of covers on the OG card and the feature graphic. Every run checks that `full.svg` is background then foreground, that the mark stays inside the 66 dp safe circle and the maskable icon's 40% circle, that the dark splash is paper only, stays inside the light splash's footprint and keeps its slot open, that the feature graphic is opaque 24-bit RGB, and that every PNG has its expected size. Sizes up to 48 px are rendered at 8× and box-averaged, so the symmetric notch rasterises symmetrically.

| Output | Use |
|---|---|
| `out/android/icon.png` (1024) | Expo `icon` (legacy launcher) |
| `out/android/adaptive-{foreground,background,monochrome}.png` (1024) | Expo `android.adaptiveIcon` foreground, background, monochrome (themed icons) |
| `out/android/splash-icon.png` (1024) | Launch screen image: the paper mark alone. On a paper background (#F3F2EE) it shows as its ink outline and ink read part. See the wiring notes |
| `out/android/splash-icon-dark.png` (1024) | Dark launch screen image, from `splash-dark.svg`: the mark in paper with the unread slot cut out, for the dark background (#111112). See the wiring notes |
| `out/android/shelf_notification.xml` | Status-bar and media-notification small icon as a VectorDrawable (24 dp, white, 2 dp padding), from `monochrome.svg`. See the wiring notes below |
| `out/android/notification-icon.png` (96) | The same glyph as a bitmap, for anything that needs a PNG |
| `out/android/play-store-icon.png` (512) | Google Play listing icon (32-bit PNG) |
| `out/android/play-feature-graphic.png` (1024 × 500) | Google Play feature graphic, required to publish the listing. 24-bit PNG with no alpha, as Play asks. Paper ground, the icon tile, the name in ink and a strip of eight covers under it, centred |
| `out/extension/icon-{16,32,48,128}.png` | Manifest `icons` and `action.default_icon`. 16, 32 and 48 are the tuned cuts, drawn to the edge as the toolbar sizes are. Chrome's extensions page always shows the 48: at 36 CSS px on the list and 24 on the details page, which is the 48 at its own size on a 2x screen. 128 is the 108 dp drawing as a tile with the Chrome Web Store's 16 px of transparent padding |
| `out/extension/icon-16.svg`, `icon-32.svg` | Firefox manifest `icons` keys "16" and "32" (48 and 128 stay on the PNGs) |
| `out/extension/options-logo-28.svg` | The options page's logo: `small-28.svg` ready to inline in the brand row's 28 px slot (the extension mockup's `MARK(28)` inlines it as `LOGO_28`; it used to draw `full.svg`'s 72 dp crop with a 0.56 px outline). Comments stripped inside the `<svg>`, its clip id renamed `shelfLogo28` so it can't collide with the other inline icons on the page, and `aria-hidden`, since the name sits beside it. The covers' inset hairline stays in the page's CSS (`.brandrow .mark::after`) |
| `out/web/favicon.svg`, `favicon.ico` (16/32/48), `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `maskable-512.png`, `site.webmanifest` | Website. `favicon.svg` is the 16 px cut; the ICO carries the 16, 32 and 48 px cuts. The manifest's `theme_color` is ink (#17171A) and its `background_color` paper (#F3F2EE), and it fixes `id`, `start_url` and `scope` at `/` so installs keep one identity |
| `out/web/og-card.png` (1200 × 630) | Social sharing card: paper ground, the icon tile, the name in ink, the tagline in the muted grey (#5C5B56) and a short strip of eight covers under it, bottom-aligned with the tile |

**The cards.** The icon tile and every cover carry the covers' inset hairline (ink at 9%), because the icon's cream ground sits close to paper. The strip is real cover v1 output at depth 3, the Fingerprint board's eight sample articles (sha256 of each normalised URL, as `shared/cover/fixtures.json` records them), drawn at build time; if cover v1 changes before it ships, the strip changes with it and the icon doesn't. The name is set in the system UI font until the name and typeface are final (Segoe UI on Windows, Arial on macOS); regenerate both cards then.

## Wiring notes for the mobile build

- **Splash:** set the expo-splash-screen plugin's `backgroundColor` to paper, #F3F2EE, and `imageWidth` to about 200. The default of 100 dp shows the bookmark about 49 dp wide with its outline; up to about 210 dp keeps every part of the art inside Android 12's 192 dp circle. `splash-icon.png` is drawn for the paper background only (on a dark one its ink outline and read part disappear), so give the plugin's `dark` block the dark image and the dark theme's background, #111112:

  ```json
  ["expo-splash-screen", {
    "image": "./assets/brand/splash-icon.png",
    "backgroundColor": "#F3F2EE",
    "imageWidth": 200,
    "dark": { "image": "./assets/brand/splash-icon-dark.png", "backgroundColor": "#111112" }
  }]
  ```

  `imageWidth` applies to both, and the two images have the same footprint, so the mark sits in the same place in either theme. Android picks the dark pair from the phone's dark theme (night resources) before the app has run; the app follows the same setting (flow decision 16), so the launch screen always matches the theme the app opens in. Copy the two PNGs into the app's assets (the paths above are examples) and rebuild the native project, since the splash is baked in at prebuild.
- **Media notification icon:** expo-audio 57 hard-codes its small icon to media3's `media3_icon_circular_play` and its plugin takes no icon option, so the status bar would show a generic play circle. Either add a small config plugin that writes `shelf_notification.xml` into `res/drawable*/media3_icon_circular_play.xml` (after prebuild, check which qualifier directories the media3-session AAR uses and match each one), or patch both `setSmallIcon` calls to resolve an app-owned `shelf_notification` drawable. An upstream icon option for the plugin would be the clean fix.
- **app.json** in the paused spike still points at the Expo template icons, is named "mobile" and has no splash config. Point it at these outputs when the build resumes.

The in-app interface icons are Lucide at 1.75 stroke, plus Shelf's own skip ±15 pair and speed-read icon in `docs/design/icons/app/` (decisions 62 and 65).

**Bar drawing (decision 72).** In `foreground.svg` and `full.svg` the bar is one ink pill (its outline and the read two thirds) with the unread slot drawn in paper on top, its left end following the read part's round cap. The earlier drawing stacked an ink read pill on a paper track, so their shared edges left a faint light hairline inside the ink; no shape now shares an edge with another, as in the tuned 16, 28, 32 and 48 px cuts.
