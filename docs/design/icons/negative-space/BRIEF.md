# Brief: Shelf's app icon, negative-space round

Shared by every agent working on this round. Read all of it before drawing.

## Shelf, in one paragraph

Shelf is a free read-it-later app, phone first (Android), with a browser extension for Chrome and Firefox. Save anything, read it clean and offline, and listen to it: on-device text to speech with lock-screen controls. The icon has to say "saved, to come back to" first, and it can also say "you can listen to it". The interface is ink, paper, two greys and hairlines with no brand colour (the Fingerprint style); type is Archivo and Archivo Expanded; in-app icons are Lucide at 1.75 stroke.

## Where the icon stands today

Flow decision 70 (`shared/brand/src/`, `shared/brand/README.md`): a cover pattern (orange quarter-disc bands on cream) with Shelf's bookmark and a reading-progress bar standing on it, in paper with an ink outline. The dark launch screen (`shared/brand/src/splash-dark.svg`) already shows the bookmark as one solid paper shape on graphite.

## What Richard asked for

Richard's words: "I like the bookmark part of the icon, but I think we need to work with some negative space. One idea, dark mode - dark background, solid white bookmark icon, dark play icon within it and within that a light pause icon. Lets play with the negative space idea, simplicity, and give me some options."

A first attempt was rejected ("you did some great design before but this was poor"). It failed because:

- it drew a generic bookmark instead of Shelf's;
- the geometry was eyeballed: sharp triangles in a bookmark with rounded shoulders, pause bars floating off centre, nothing optically centred;
- the small sizes were the master shrunk, never drawn;
- most ideas were clip art (a bookmark with a symbol stamped in it), not negative space doing work.

This round has to be the opposite on each of those points.

## Fixed for every candidate

1. **Shelf's bookmark.** Square shoulders (corner radius 4/34 of the width), straight sides, a notched tail with today's shallow notch (11/34 of the width deep, measured from the sharp tips), tips rounded at 1.5/34. `geom.bookmark()` draws it at any size; with its defaults it reproduces `shared/brand/src/foreground.svg`'s bookmark exactly. Change a proportion only when the idea depends on it, say so in `meta.json`, and keep it recognisably the same bookmark.
2. **One colour and real holes.** The master is one paper shape (#F3F2EE) on the dark tile (#111112, the dark theme's background, Graphite). Anything that looks dark inside the mark is a hole, never a dark shape painted on top. An island inside a hole (Richard's light pause inside the dark play) is paper too. Because of this, the light colourway (ink on paper), Android's themed icon and the notification glyph all come from the same drawing.
3. **Fills only.** `mark.svg` uses `<path>`, `<rect>`, `<circle>` and `<g transform>` with fills: no strokes, masks, clip paths, filters, gradients or opacity, so Android's VectorDrawable and the brand build can take it. Compound paths with `fill-rule="evenodd"` are fine; VectorDrawable supports evenOdd.
4. **The adaptive-icon canvas.** 108 × 108 dp. Launchers show the central 72 dp through a mask (circle, squircle, rounded square or teardrop), and only the central 66 dp circle (radius 33 about (54, 54)) is sure to show. Keep everything inside that circle, unless the idea deliberately bleeds off the tile; then it has to work under all four masks.
5. **Nothing else.** No progress bar, no cover pattern, no extra colours, no text. Richard asked for simplicity.

Android launcher icons don't change with dark mode: this dark icon will sit on light wallpapers too, and the sheets show it there. The light colourway is for the light launch screen, the website and anywhere the mark sits on paper.

## Size

Without the bar, the bookmark can be the hero. Today it is 34 × 40.6 dp; the solid reference in `candidates/ref-solid` is about 40 × 48 dp and reaches 30.7 of the 33 dp safe radius. Go as big as the idea allows inside the safe circle: holes need room.

## Files for each candidate, in `candidates/<id>/`

| File | What |
|---|---|
| `mark.svg` | The master: viewBox `0 0 108 108`, the mark alone in #F3F2EE, transparent around it, holes real. |
| `cut-48.svg`, `cut-32.svg`, `cut-16.svg` | The icon redrawn on its own pixel grid, for the browser toolbar, the favicon and the extension. viewBox `0 0 N N`, one unit = one pixel. First the tile, `<rect width="N" height="N" rx="7N/32" fill="#111112"/>` (`geom.tileRect(N)`), then the mark in #F3F2EE. Straight edges on whole pixels; diagonals only where the shape needs them. Smallest detail: 1 px at 16, 2 px at 32, 3 px at 48. Drop inner layers rather than shrinking them into mush: the 16 px cut may lose its innermost element as long as it is still plainly the same icon. |
| `glyph-24.svg` | The status-bar and media-notification icon: white #FFFFFF on transparent, viewBox `0 0 24 24`, content inside the central 20 × 20 (2 px padding), whole pixels. Android draws it from alpha only, so holes are all it has. |
| `meta.json` | `{"title": "2 to 4 words", "idea": "one or two plain sentences: what you see and why it works", "built": "how it is constructed: sizes, ratios, alignment decisions", "small": "what each cut keeps and drops", "risks": "what could go wrong: lookalikes, legibility"}`. Plain British English, no inverted-emphasis constructions ("it's not X, it's Y"). |
| `build.mjs` | Recommended: the script that writes the SVGs from `tools/geom.mjs`, so a drawing can be adjusted by changing a number. Run it from the candidate folder or with paths relative to it. |

## Tools (run from `docs/design/icons/negative-space`)

- `node tools/sheet.mjs candidates/<id>` writes `candidates/<id>/sheet.png` and `metrics.json`, and prints the metrics. Read the PNG: it shows the launcher in four masks, the themed icon, light and dark home screens at 1×, the light colourway, both launch screens, the toolbar cuts at 1× and magnified, and the glyph in a status bar. A cut you haven't drawn yet falls back to the master shrunk and is flagged.
- `node tools/compare.mjs sheets/<name>.png candidates/<a> candidates/<b> …` puts candidates side by side, one row each.
- Metrics: `reach_dp` must stay at or under 33 (`inside_safe`); `centroid` is the ink's centre of mass; `soft_pct` on a cut is the share of the mark's pixels that are blurred part-tone, lower is crisper (the solid reference's 16 px cut is 14.7, its 48 is 3.5).
- `tools/geom.mjs`: `bookmark({cx, top, w, h, notch, rTop, rTip})`, `play({cx, cy, h, w, r, dir, at})` placed by centroid by default, `pause({cx, cy, barW, barH, gap, r})`, `rect(x, y, w, h, r)`, `circle(cx, cy, r)`, `roundedPolygon(points, radii)` for any shape with rounded corners (the notch's reflex corner is handled), `incircle(triangle)` for the largest circle inside a triangle, `join(...)`, `svg(size, body)`, `tileRect(n)`. Join shapes into one path with `fill-rule="evenodd"` to cut holes; an island inside a hole is just one more subpath.
- `candidates/ref-solid` is the solid bookmark with tuned cuts, a starting point for your own cuts.

Work only inside your own candidate folders. Don't edit `tools/`, `BRIEF.md` or anyone else's folders.

## Craft: what good means here

- **The negative space does work.** The hole or gap carries the second idea (listen, play, pause); it isn't decoration. At 48 px the eye should find it without effort.
- **Optical centring.** A right-pointing triangle looks off centre when its box is centred: start from its centroid (geom's default) and nudge by eye on the sheet. A hole sits in the bookmark's body, above the notch's apex. The bookmark's visual centre is higher than its box centre, because the notch takes weight from the bottom.
- **Walls.** The paper between a hole and the bookmark's edge is even, or unmistakably uneven on purpose. At 48 px no wall is under 3 px; at 32 px, 2 px. If a wall can't survive a size, that size gets a different drawing.
- **One corner language.** The bookmark has round shoulders and nearly sharp tips. Holes follow it: triangle corners rounded at about the shoulder radius, pause bars with a small radius. Sharp and soft never mix at random.
- **Nesting costs legibility.** Every level of figure and ground (bookmark, hole, island) makes the next one smaller. Three levels is the limit, and the third needs real size.
- **Simplicity tests.** Can it be described in five words? Could someone draw it from memory after one look? Does it still read as a bookmark first?
- **Lookalikes.** Avoid anything close to Google Play Books (a bookmark-like shape built around a play triangle), Pocket (a red shield with a chevron), Apple Podcasts, Audible, YouTube, Spotify or a generic media-player button. An icon that reads as a video or music app before a reading app fails.

## Process

1. Think through your territory first: list four to six ideas in it and pick the strongest for the number of candidates you were asked for. Drop an idea that fails at 48 px and say why in your notes.
2. Build each candidate with `geom.mjs`. Render its sheet, Read the PNG, write down what is wrong, fix it and render again: at least three render-and-look rounds per candidate, the last spent on the 48, 32 and 16 px cuts and the glyph.
3. Compare your candidates with each other and with `ref-solid` using `compare.mjs`, and Read that sheet before you finish.
4. Before returning, check every candidate has all six files (build.mjs optional), `inside_safe` is true (or the bleed is deliberate and checked in all four masks), and `meta.json` is filled in.
