# Shelf brand assets

The app icon ("Bookmark on Terracotta", chosen by Richard on 2026-09-27): a cream, square-shouldered bookmark with a notched tail standing on a two-tone reading-progress bar, on the brand gradient #BE6947 → #944526. It ties the icon to the Saves tab's bookmark and to the app's reading-progress signature.

- `src/` holds the only hand-edited files: the adaptive-icon foreground, background and monochrome layers on Android's 108 dp canvas, two pixel-tuned 32 × 32 drawings (`small.svg` for 16 px, with a deeper notch and thicker shelf so they survive; `small-32.svg` for 32 px, in the master's proportions), and `full.svg` (foreground on background).
- `build-icons.cjs` derives every size and format into `out/`. Run it after any change to `src/`:

```
npm install --no-save @resvg/resvg-js@2
node shared/brand/build-icons.cjs
```

| Output | Use |
|---|---|
| `out/android/icon.png` (1024) | Expo `icon` (legacy launcher) |
| `out/android/adaptive-{foreground,background,monochrome}.png` (1024) | Expo `android.adaptiveIcon` foreground, background, monochrome (themed icons) |
| `out/android/splash-icon.png` (1024) | Launch screen image, on the brand colour |
| `out/android/shelf_notification.xml` | Status-bar and media-notification small icon as a VectorDrawable (24 dp, white, 2 dp padding). See the wiring notes below. |
| `out/android/notification-icon.png` (96) | The same glyph as a bitmap, for anything that needs a PNG |
| `out/android/play-store-icon.png` (512) | Google Play listing icon (32-bit PNG) |
| `out/android/play-feature-graphic.png` (1024 × 500) | Google Play feature graphic, required to publish the listing. 24-bit PNG with no alpha, as Play asks. |
| `out/extension/icon-{16,32,48,128}.png` | Manifest `icons` and `action.default_icon` |
| `out/extension/icon-16.svg`, `icon-32.svg` | Firefox manifest `icons` keys "16" and "32" (48 and 128 stay on the PNGs) |
| `out/web/favicon.svg`, `favicon.ico` (16/32/48), `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `maskable-512.png`, `site.webmanifest` | Website. `favicon.svg` is the 16 px drawing; the ICO carries both tunings. The manifest fixes `id`, `start_url` and `scope` at `/` so installs keep one identity. |
| `out/web/og-card.png` (1200 × 630) | Social sharing card. The wordmark is set in the system UI font until the name and typeface are final (Segoe UI on Windows, Arial on macOS); regenerate this and the feature graphic then. |

Sizes up to 48 px are rendered at 8× and box-averaged, so the symmetric notch rasterises symmetrically.

## Wiring notes for the mobile build

- **Splash:** set the expo-splash-screen plugin's `imageWidth` to about 200. The default of 100 dp shows the bookmark about 47 dp wide; up to about 210 dp keeps every part of the art inside Android 12's 192 dp circle.
- **Media notification icon:** expo-audio 57 hard-codes its small icon to media3's `media3_icon_circular_play` and its plugin takes no icon option, so the status bar would show a generic play circle. Either add a small config plugin that writes `shelf_notification.xml` into `res/drawable*/media3_icon_circular_play.xml` (after prebuild, check which qualifier directories the media3-session AAR uses and match each one), or patch both `setSmallIcon` calls to resolve an app-owned `shelf_notification` drawable. An upstream icon option for the plugin would be the clean fix.
- **app.json** in the paused spike still points at the Expo template icons, is named "mobile" and has no splash config. Point it at these outputs when the build resumes.

The in-app interface icons are Lucide, plus the custom skip ±15 pair in `docs/design/icons/app/`.
