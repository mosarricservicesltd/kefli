# Kefli website: landing options brief (9 October 2026)

Three landing-page directions for `apps/web`, to choose from before the real build. Each is one
self-contained HTML file in this folder, in artifact format: no doctype/html/head/body tags, with
`<title>` and `<style>` at the top. Fonts come from Google Fonts only: Archivo (including Archivo
Expanded through the `wdth` axis: `family=Archivo:wdth,wght@62..125,100..900`), Literata and
Martian Mono. Scripts come only from cdnjs, pinned to an exact version; prefer raw WebGL or canvas
with no library.

## The job

Explain Kefli, then get it: the Android app by sideloading (Zapstore, or the APK directly) and the
browser extension (Chrome, Firefox). Visitors: Pocket refugees and privacy-minded readers, curious
but sceptical of "your data forever" claims.

## Richard's direction

"super cool, clean, nordic themes, perhaps some fjords or mountains, perhaps a view across peaks
hidden in fog below, as if viewing from above the clouds from a mountain peak. should have movement,
go wild." Inspiration: supahero.io/hero/lewis (a motion-led designer portfolio).

## Locked identity (from the repo)

- Chrome: ink #17171A, paper #F3F2EE, surface #FFFFFF, line #DEDCD5, line-strong #8C8A83,
  muted #5C5B56. Dark: background #111112, surface #1A1A1C, line #2E2E31, line-strong #7A7983,
  text #EDECE8, muted #A7A59F. No brand colour and no gradients in the UI chrome. Landscapes and
  imagery may carry atmosphere (cold, desaturated), since the covers are the app's only colour.
- Type: Archivo and Archivo Expanded (interface, display), Literata (reading voice), Martian Mono
  (numerals, small labels). Lucide-style icons at 1.75 stroke, as inline SVG.
- The icon (frozen): an upright notched bookmark, paper on graphite. Its SVG path is in
  `shared/brand/src/full.svg` (viewBox 108, keep the `<g>` transform).
- Filled buttons: the fill is the text colour and the content is the page colour. Text is
  vertically centred in every bordered or filled element. Focus is a 2px ring with a 2px offset.

## Copy rules

British spelling. Never the inverted-emphasis construction ("it's not X, it's Y", "X is the point",
withheld punchlines, colon reveals). No nostr vocabulary, no "relay", "decentralised" or "web3".
Never mention or link kefli.net. No unverified numbers (no Bryggen counts). No em-dash asides.
Plain, specific, calm.

## Facts you may state

- Kefli is a free read-it-later app. Android first, with a browser extension for Chrome and Firefox.
- Save anything from the share sheet or the extension. Read it clean, without the clutter, offline.
- Listen to any article in your phone's own voice, with lock-screen controls.
- No signup: start a library and keep your recovery code. No feed, no tags, no social layer.
- Your saves are encrypted on your phone before they leave it, so we can't read them.
- By default your library is also copied to servers we don't run, so it outlives the service: if
  Kefli closed tomorrow, your library would still be there.
- Open source (AGPL).
- The name: Old Norse *kefli*, a short wooden stick. Rune sticks (*rúnakefli*) were everyday notes
  carved into wood to be carried and kept. Said "KEF-lee".
- Hávamál, usable as an epigraph: *deyr fé, deyja frændr … en orðstírr deyr aldregi* ("cattle die,
  kinsmen die … but the good name never dies").
- Status: pre-launch. Google Play is coming; today it's Zapstore and the APK for sideloading.

## Shared copy deck (adapt headlines to the direction; keep the facts)

- Nav: Kefli · How it works · Extension · Privacy · Get Kefli (button)
- Sections in order: Hero, Save / Read / Listen, Kept (outlives the service, encryption, open
  source), The name (rune sticks), Get Kefli (Android through Zapstore and the APK; Chrome; Firefox;
  "Coming to Google Play"), Footer (Privacy, Source code, Extension install guide, "Said KEF-lee").
- Hero line candidates: "Read it later. Keep it for good." / "Save it now. Read it in the quiet." /
  "Everything you meant to read, kept."
- Sub: "A free read-it-later app. Save from anywhere, read it clean, listen on the go. Your library
  lives under your own key, so it outlives us."
- Download links are `#` placeholders with real labels. Zapstore: "Get it on Zapstore". APK:
  "Download the APK", with a small mono line "v0.1 · Android 10+" marked as example text in an HTML
  comment.

## Build rules

- Motion: one orchestrated signature move plus ambient atmosphere. Animate only transform, opacity
  or a canvas/WebGL surface. Honour prefers-reduced-motion with a designed still frame. Pause
  rendering when the tab is hidden or the canvas is off-screen. Cap devicePixelRatio at 2.
- Never scroll-jack. Scroll-linked effects are fine.
- The page is readable at rest: no content waits at opacity 0 for an observer.
- Works at 400px wide, with 16px gutters and no horizontal scroll. Both themes, or a deliberate
  single look with every colour explicit (a dark, single-look hero is fine).
- Keyboard focus is visible, and every control is a real `<a>` or `<button>`.
- A small fixed label in a corner, "Option A · <name>" (B, C), so Richard can tell them apart.
