# Shelf brand assets

The app icon ("Bookmark on Terracotta", chosen by Richard on 2026-09-27): a cream, square-shouldered bookmark with a notched tail standing on a two-tone reading-progress bar, on the brand gradient #BE6947 → #944526. It ties the icon to the Saves tab's bookmark and to the app's reading-progress signature.

- `src/` holds the only hand-edited files: the adaptive-icon foreground, background and monochrome layers on Android's 108 dp canvas, a pixel-tuned 32 × 32 `small.svg` for 16–32 px, and `full.svg` (foreground on background).
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
| `out/android/notification-icon.png` (96, white on transparent) | Status-bar and media-notification small icon |
| `out/android/play-store-icon.png` (512) | Google Play listing |
| `out/extension/icon-{16,32,48,128}.png`, `icon.svg` | Manifest `icons` and `action.default_icon`; Firefox can use the SVG |
| `out/web/favicon.svg`, `favicon.ico` (16/32/48), `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `maskable-512.png`, `site.webmanifest` | Website |
| `out/web/og-card.png` (1200 × 630) | Social sharing card. The wordmark is set in the system UI font until the name and typeface are final. |

The in-app interface icons are Lucide, plus the custom skip ±15 pair in `docs/design/icons/app/`.
