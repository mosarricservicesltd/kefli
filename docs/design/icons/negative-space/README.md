# Icon study: negative space

Made on 8 October 2026, when Richard asked for a new direction for the app icon: keep the bookmark, work with negative space, and keep it simple ("dark mode - dark background, solid white bookmark icon, dark play icon within it and within that a light pause icon"). A first attempt that day was rejected: it drew a generic bookmark with eyeballed geometry and no drawn small sizes. This round starts from Shelf's own bookmark and draws every size by hand. Nothing in `shared/brand` changes until Richard chooses.

`study.html` is the page (published privately; the link is in the conversation that made it). Pick an option to see it beside today's icon, on home screens, in the launcher's mask shapes, on the lock screen while Shelf reads aloud, at real size in a browser toolbar, and as both launch screens.

## The rule every option follows

One paper shape (#F3F2EE) on the dark theme's background (#111112), and every dark shape inside it is a real hole. So one drawing gives the light version (ink on paper), Android's themed icon (the monochrome layer is the mark itself) and the status-bar glyph, and they can't drift apart. The master is fills only, so it converts to a VectorDrawable. The full rules are in `BRIEF.md`.

## How it was made

1. **Brief and tools.** `BRIEF.md` fixes the bookmark (`tools/geom.mjs`'s `bookmark()` reproduces `shared/brand/src/foreground.svg`'s exactly), the colours, the canvas and safe zone, the files and the craft standard. `tools/sheet.mjs` renders one candidate in every context with measurements (reach from the centre, ink centroid, and how many of each cut's pixels are blurred part-tone); `tools/compare.mjs` puts candidates side by side.
2. **Exploring.** Seven designer agents each took one direction (nested play and pause, a play cut, pause made from the bookmark, the tail as the play, figure and ground swapped, the hidden figure, the ribbon from the edge) and drew two or three candidates, each with a master, 48, 32 and 16 px cuts drawn on their pixel grids, and a 24 px glyph.
3. **Judging.** Three judges scored every candidate separately: concept and negative space (with a lookalike check against other reading and audio apps), craft at small sizes, and Richard's brief.
4. **Refining.** The shortlist was redrawn from the judges' notes and checked again.
5. **The page.** `tools/build-page.mjs` reads `page.json` (the options shown, their groups and the page's text), each option's files, `meta.json` and `notes.json`, and today's icon from `shared/brand/src`, and writes `study.html` from `tools/page.tpl.html`.

## Rebuilding

```bash
node tools/sheet.mjs candidates/<id>             # one candidate's contact sheet and metrics
node tools/compare.mjs sheets/all.png candidates/*   # side by side
node tools/build-page.mjs                         # study.html
FLAT=1 node tools/shot.mjs study.html sheets/page.png 1280 dark
```

They need Node 24 and Google Chrome (through `tools/design-qa/cdp.mjs`), nothing to install. `sheets/`, each candidate's `sheet.png` and `metrics.json` are git-ignored.

## Outcome

Richard chose D, "split and play", on 9 October 2026 (flow decision 94), and it was fine-tuned in three steps before it was made official:

1. **Three plays tall** (`tools/d-height.mjs`). After a note from Richard's designer friend: a tad shorter, and the height set by three play buttons facing right, left and right. D's two cuts lie on the notch's two angles, so those angles make a grid of plays up the left half; at 30 degrees the plays are equilateral and three of them are exactly the height, 6.5% shorter than today's proportions. The earlier D is kept in `candidates/D-was`.
2. **90% in the tile, for every option.** The same note's point about room round the mark: each option's master wraps its drawing in one group scaled to 90% about the canvas centre (`candidates/base/build.mjs` exports `SCALE` and `atScale`), as decision 70's foreground scaled its mark to 96%. The pixel cuts keep their size.
3. **A bigger play** (`tools/d-play.mjs`). After the second blind read, which judged the shorter D better drawn but still pause first: the diagonal cut at 0.8 of the slot's width makes the play 8% taller without changing the height. The one-width version is kept in `candidates/D-even`.

Two system choices came with it: the extension's toolbar button at 16 and 32 px is the plain bookmark (the extension only saves, and the split reads as a pause control there), and so is the notification glyph. `tools/freeze-d.mjs` wrote `shared/brand/src` from `candidates/D`; from then on those files are frozen and owned by the brand.

The blind reads are in `rounds/round3-d.json` (the first D) and `rounds/blind-read-2.json` (the shorter D beside the first); the judges' rounds in `rounds/round1.json` and `rounds/round2.json`.
