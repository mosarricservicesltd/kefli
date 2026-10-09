# Cover v1

Every save in Shelf draws its own cover from the sha256 of its normalised URL, the hash already in its d tag (`shelf/item/<sha256>`, contract section 4.3). The same hash gives the same picture on the phone, in the extension and on the website, today and after a restore on a new phone. This folder is the one shared generator for that picture (flow decisions 65 to 68).

The generator was drawn on the Fingerprint concept board (`docs/design/study/fingerprint.html`, the block between `GEN-START` and `GEN-END`). This module is that code, rewritten so that no JavaScript engine can drift from it. Its leaves and derived inks are the board's exactly. It differs from the board in two stated ways: the seam rule of 4 October 2026 (see Drawing), and the winter rule of 9 October 2026, which confines the palette's hues and lowers its chroma (see Palette).

| File | What it is |
|---|---|
| `cover-v1.js` | The generator. Dependency-free ES2015. A classic `<script>` defines `window.ShelfCover`; `require()` returns the same object. |
| `fixtures.json` | 64 golden cases. Every platform's CI must reproduce every value in it. |
| `test.cjs` | `node shared/cover/test.cjs` checks the source rules, the fixtures, the board's own functions and the served copy. The SVG is checked against the board's through `seamRule()`, which restates the seam rule on the board's markup and changes nothing else, and every output is checked against the board's generator with `winterRule()` applied to its source, which restates the winter rule and changes nothing else. `--exhaustive` adds every possible palette (about two minutes). Exits 1 on any mismatch. |
| `build.mjs` | `node shared/cover/build.mjs` copies the module to `docs/design/mockups/cover-v1.js` (with a "generated, do not edit" header), so the prototypes can load it with `<script src="cover-v1.js">`. |

## Status and the versioning rule

This is cover v1. Once a build that draws covers ships, v1 is frozen: `cover-v1.js` and `fixtures.json` are never edited again, not even to fix an ugly cover. Any change to any output (a palette colour, a leaf, a byte of SVG, a derived ink) ships as `cover-v2.js` with its own fixtures and version string, next to v1, and with a stated migration. The migration has to say which saves draw which version. Keeping every existing save on v1 needs a way to tell old saves from new (a contract change, such as a cover version in the save event). Moving every save to v2 at once changes every face people already know and needs Richard's sign-off. Until the first ship, a change can still be made to v1 itself, but only with the fixtures regenerated, the board difference stated, and this file updated. Two such changes have been made: the seam rule (4 October 2026) and the winter rule (9 October 2026, flow decision 99).

## API

```js
ShelfCover.version                  // 'cover-v1'
ShelfCover.palette(hash)            // {ground, deep, soft, signal, hue, scheme, dark, hash}, frozen
ShelfCover.leaves(hash, {depth, cols})
                                    // [{x, y, s, d, mod, rot, bg, fg}] in drawing order
ShelfCover.svg(hash, {size, depth, cols, grey, draw, title})
                                    // an SVG string
ShelfCover.lineInk(hash, surface, text?)
                                    // the article's ink for progress lines, link underlines, countdowns
ShelfCover.highlight(hash, {bg, text})
                                    // the spoken-word tint; also ([bg, text]) or (bg, text)
ShelfCover.night(hash)              // the article's Night reading palette {bg, text, muted, line, hl}
ShelfCover.contrast(a, b)           // WCAG 2 contrast ratio of two #RRGGBB colours
ShelfCover.luminance(c)             // WCAG 2 relative luminance
ShelfCover.mix(a, b, t)             // a towards b by t, per sRGB byte
ShelfCover.grey                     // the two grey sets, {light, dark}
ShelfCover.css                      // the draw-in CSS (class "lf", custom property --i)
ShelfCover.motion                   // the same timings as numbers, for native animation
```

- `hash` is 64 hexadecimal characters, read case-insensitively. Anything else throws a `TypeError`.
- `depth` is 0 to 3, default 3. Rows, Listen, the Reader band and media art use 3. The board drew the app icon at 1, and from flow decision 70 to 94 the app icon was cover v1 `2c7601c0…` at depth 1; since decision 94 it is no longer a cover.
- `cols` is 1 to 16, default 1. Wider frames (the Reader's 3:1 band, Now playing) continue the cover to the right: the second square carries on from the same random stream, so the first square of a wide cover is the row's square.
- `size` (whole pixels) sets `width` and `height` (`size × cols` by `size`). Without it, the SVG fills its box.
- `grey` is `'light'`, `'dark'` or null: the same shapes in the chrome's greys, for a save whose text couldn't be fetched.
- `draw: true` wraps each leaf in `<g class="lf" style="--i:n">` for the draw-in. Add `ShelfCover.css` to the page; a container with class `loop` repeats the drawing, but Shelf doesn't use it: a cover draws once, when the save first appears, and a save whose text is still being fetched waits drawn, with its waiting dot (flow decision 69). Reduced motion shows the cover already drawn.
- `title` gives the SVG `role="img"` and a `<title>`. Without it, the cover is decorative: `aria-hidden="true"`, as in every row, because the title and source beside it already say what it is.
- `lineInk` without `text` falls back to the chrome's own text colour: `#17171A` on light surfaces and `#EDECE8` on dark. Pass the surface's text token when you have it.

## What each byte of the hash drives

| Bytes | Drives |
|---|---|
| 0 and 1 | The hue: 150 + the 16-bit number × 170 / 65536 degrees (150 to 319.997), the winter rule's range. `palette.hue` is the same angle rounded to whole degrees, from 150 to 320. |
| 2 | The scheme, from its lowest two bits. The other six bits are unused. |
| 3 | The ground: below 80 is a dark ground (80 in 256, about three covers in ten), 80 and above a light one. |
| 4 to 19 | The composition: four big-endian 32-bit words seed sfc32. |
| 20 to 31 | Unused in v1. |

## Palette

Four inks with fixed roles, built together as one set in OKLCH, in the winter palette (flow decision 99): hues from 150 to 320 degrees, greens through teal and blue to violet and mauve, at 0.7 of the board's chroma.

| Role | Light ground (L, C, hue) | Dark ground (L, C, hue) |
|---|---|---|
| ground | 0.945, 0.0196, h2 | 0.255, 0.0315, h2 |
| deep | 0.33, 0.0595, h1 | 0.93, 0.0245, h1 |
| soft | 0.81, 0.0665, h1 | 0.60, 0.084, h1 |
| signal | L(hue), 0.1225, hue | the same |

The two secondary hues stay inside the range (W = 170 degrees). *Fold* reflects a hue back at the range's ends; *wrap* carries it round the range, from 320 back to 150.

| Scheme (lowest two bits of byte 2) | h1 | h2 |
|---|---|---|
| 0 analogous | fold(hue + 38) | fold(hue − 34) |
| 1 complement | wrap(hue + W/2) | fold(hue + 26) |
| 2 triad | wrap(hue + W/3) | wrap(hue + 2W/3) |
| 3 split | wrap(hue + 0.42W) | wrap(hue + 0.58W) |

The board drew every hue round the wheel at the full chroma (0.175 for the signal; 0.028, 0.085 and 0.095 on a light ground and 0.045, 0.035 and 0.12 on a dark one) with h1 and h2 at the hue plus +38/−34, +180/+26, +120/+240 or +150/+210. The winter rule replaced that before the first ship, after a study of four directions (`docs/design/study/winter-palette.html`).

The signal's lightness follows its hue so yellows stay yellow and blues stay deep: L(hue) = 0.63 + 0.17 × e^−(d/38)², where d is the hue's distance in degrees from 100 (the shorter way round). Inside the winter range it is nearly flat, from about 0.63 to 0.66, since its peak at 100 degrees lies outside it.

An OKLCH colour that falls outside sRGB keeps its lightness and hue and loses chroma: 18 rounds of bisection between 0 and the requested chroma find the largest that fits (a linear channel may stray 0.0001 outside 0 to 1), and the lower bound is used. The linear values are then encoded to sRGB bytes and written as upper-case `#RRGGBB`.

## Composition

**Random stream.** sfc32 with a = bytes 4–7, b = 8–11, c = 12–15, d = 16–19. Each step: t = a + b + d; d = d + 1; a = b ^ (b >>> 9); b = c + (c << 3); c = (c rotated left 21) + t, all in 32 bits; the step returns t / 2^32. The first 12 steps are discarded.

**Weighted pick.** Draw r, multiply by the total weight, and walk the list subtracting each weight; the first entry that takes the value below zero wins.

**The square.** A root square is 8 × 8 units. Starting from the root at depth 0, each square splits into four quarters (top left, top right, bottom left, bottom right, in that order) with probability 0.86 at depth 0, 0.46 at depth 1 and 0.24 at depth 2, while its depth is below the maximum depth. The split test draws from the stream only when splitting is allowed. Leaves are 8, 4, 2 or 1 units across. About one cover in seven is a single 8-unit leaf.

**Each leaf** then takes four draws, in this order:

1. its module, from the big set if it is 4 or 8 units across, otherwise the small set;
2. its background role;
3. its foreground role, from the foreground weights without the background's role;
4. its rotation, floor(r × 4) quarter turns.

| Big set (8 and 4 units) | quarter 5, bands 2, half 2, disc 2, lens 2, ring 1, diag 1 |
|---|---|
| Small set (2 and 1 units) | quarter 4, solid 3, diag 2, dot 2, half 2, disc 1, lens 1 |
| Background, depths 0 and 1 | ground 6, deep 2, soft 2, signal 1 |
| Background, depths 2 and 3 | ground 8, deep 2, soft 2, signal 1 |
| Foreground | signal 4, deep 3, soft 3, ground 2 |

**The signal rule.** Every square has one loud shape: after its leaves are drawn, the largest leaf (the first one, on a tie) gets the signal as its foreground if neither of its roles is already the signal, and if its module is solid or dot it becomes a quarter.

**Wider frames** repeat the square for each column from the same stream, with x offset by 8 units per column.

The drawing order is the leaf order: depth first, quarters in reading order, columns left to right. It is also the draw-in order.

## Drawing

One unit is 100 px in the viewBox, so a root square is 800 × 800 and every coordinate below is a whole number apart from the bands' thirds.

1. Fill the whole viewBox (800·cols × 800) with the ground.
2. For each leaf, in order, translate to (x·100, y·100) and fill a square of side S + 2 (S = s·100) from the leaf's top-left corner in its background, the ground included.
3. Rotate by rot × 90° clockwise about the leaf's centre, draw its module in its foreground, then draw the module's strips (see Seams) in the same rotated frame.

| Module | Shape, with S = s·100, before rotation |
|---|---|
| quarter | A quarter disc of radius S centred on the top-left corner. |
| bands | Quarter discs of radius S (foreground), 2S/3 (background) and S/3 (foreground). |
| half | A half disc of radius S/2 hanging from the top edge. |
| diag | The triangle (0, 0), (S, 0), (0, S). |
| disc | A disc of radius S/2 at the centre. |
| ring | A disc of radius S/2 (foreground) with a disc of radius S/4 (background) on it. |
| dot | A disc of radius S/5 at the centre. |
| lens | The lens between (S, 0) and (0, S), two arcs of radius S. |
| solid | No shape: the leaf is its background square. |

Bands only occur on leaves of 4 or 8 units, so their thirds are 266.6666666666667 and 133.33333333333334, or 533.3333333333334 and 266.6666666666667; the module writes these as fixed strings, in the strips too.

### Seams

The squares in step 2 and the strips in step 3 are the seam rule, added on 4 October 2026, before the freeze. QA saw faint lines of the ground between neighbouring shapes of one colour at 2x and above, in the Reader's 3:1 band and on Now playing. Antialiasing gives a pixel on the edge between two leaves two partial coats, one from each leaf, and whatever lies under both shows through as a line. Skia on the phone does the same. The board's 2 px overlap covered background squares only, and where the next leaf was ground-backed it stood 1.3 px proud of its cell at 512 px.

- Every leaf fills its own square, ground included, 2 px oversize to the right and below. The leaves to the right and below are always drawn later (depth first, quarters in reading order), so the oversize is always covered, and the board's overhang is gone.
- After its module, a leaf paints a strip from 2 px outside its cell's edge to 2 px inside it, along each stretch of the edge its module touches, in the colour that touches it there. Before rotation a module touches only the top and left sides:

| Module | Strips, with S = s·100, before rotation |
|---|---|
| quarter | Foreground: x 0 to S by y −2 to 2 (top), and x −2 to 2 by y 0 to S (left). |
| half | Foreground: x 0 to S by y −2 to 2 (top). |
| diag | Foreground: the pentagons (0, −2), (S, −2), (S, 0), (S − 2, 2), (0, 2) (top) and (−2, 0), (2, 0), (2, S − 2), (0, S), (−2, S) (left), cut along the diagonal so that they add nothing inside the cell. |
| bands | Foreground: 0 to S/3 and 2S/3 to S along the top and the left, 2 px either side. Background: S/3 to 2S/3, the same way. |
| disc, ring, dot, lens, solid | None: these touch the edge only at points, or are their square. |

The modules keep the board's paths, so no curve moves. Merging the bands into one path was tried and dropped: Chrome rasterises an arc up to a third of a pixel differently inside a path that isn't convex.

What it fixes, measured in Chrome on 24 fixture covers drawn as 3:1 bands 390 px wide, against an 8× supersampled drawing with no overlaps, on pixels that lie inside one colour within 2 px of an edge between leaves (worst channel, 0 to 255):

| | Worst pixel before | after | Pixels off by more than 4 before | after |
|---|---|---|---|---|
| 1x | 101 | 28 | 1,391 | 850 |
| 2x | 158 | 12 | 1,284 | 2 |
| 3x | 238 | 30 | 4,420 | 5 |

The pixels left at 2x and 3x are single pixels where four leaves meet. At 1x a 2 px strip is a third of a device pixel across, too narrow to cover an edge pixel, so faint lines remain at about a quarter of their old strength. Rows at 64 px (1x to 3x), play buttons at 48 px (3x) and the 512 px media art went from up to 244 to 2 or less. Between the old drawing and the new, every pixel that changed by more than 8 lies within 3 px of an edge between leaves (1.25 px in the bands), or in the cover's two outermost pixel rows, where a strip's end meets an arc or a diagonal's tip at the border.

What it costs: where a strip runs over the earlier leaf and that leaf's colour differs, the edge between them moves 2 viewBox px towards the top or left, about 1 device pixel in a phone's 3:1 band at 3x and 1.3 px at 512 px. This replaces the board's 1.3 px overhang.

The draw-in: each leaf's group now holds its whole square, so with `ShelfCover.css` every leaf scales about its cell's centre. Before, a ground-backed half disc scaled about its own box.

### The SVG string

Exactly: `<svg` + (` width="W" height="H"` with a size) + ` viewBox="0 0 W H" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" ` + (`aria-hidden="true" focusable="false">` or, with a title, `role="img" focusable="false"><title>…</title>`) + `<g ><rect …ground/>` + the leaves + `</g></svg>`. A leaf is `<g transform="translate(X Y)">` + (with `draw`, `<g class="lf" style="--i:n">`) + `<rect fill="BG" width="S+2" height="S+2"/>` + `<g transform="rotate(R S/2 S/2)">` + the module + the strips (one `<path>` in the foreground, and for bands a second in the background) + `</g>` + (with `draw`, `</g>`) + `</g>`. The fixtures record it in full at size 64 and depth 2, and as sha256 for nine variants. They were regenerated for the seam rule on 4 October 2026, with every palette, leaf and ink unchanged.

On the phone, the leaf list feeds react-native-skia directly (a Path or Circle per shape) with the same geometry, the oversize squares and the strips included, in the same order: square, module, strips, leaf by leaf. The fixtures check the leaves, so the SVG text is only needed where an SVG is drawn.

## Grey covers

A save whose text couldn't be fetched keeps its shapes, drawn in the chrome's greys at full strength. These are the same values as the `cover-grey-*` tokens.

| Role | Light | Dark |
|---|---|---|
| ground | `#E4E2DC` | `#29292D` |
| soft | `#CFCCC4` | `#3A3A3E` |
| signal | `#A9A69F` | `#55545A` |
| deep | `#8C8A83` | `#7A7983` |

## Derived inks

All contrast decisions use WCAG 2 contrast, with luminance read from the 256-entry table described under determinism.

**lineInk(hash, surface, text)**: the ink an article lends to its progress line, its link underlines and the toast's countdown. On a light surface (luminance above 0.4) the candidates are signal, then the dark ink (ground on a dark cover, deep on a light one), then soft; on a dark surface, signal, then soft, then (on a dark cover) deep. The first that clears 3:1 on the surface wins. If none does, the signal is mixed towards the text colour in ten steps of 0.1 until one clears 3:1; if none does, the text colour is returned. Checked over every possible palette: on Shelf's own surfaces (paper, white surface, graphite, dark surface, the ink toast, Reader Paper, Sepia and Night) the answer is always the signal or the second candidate, and the closest call is 3.0001:1 on paper, which is why contrast must never be recomputed with `Math.pow`.

**highlight(hash, {bg, text})**: the spoken-word tint, the signal mixed into the page at 34%, then 32%, and so on down to 6% (fifteen steps), taking the first whose text keeps 7:1; if none does, the 6% tint is returned without a check. The loop runs while the step is above 0.04, and the value after 6% is 0.039999999999999994, so 4% is never tried. On Paper, Sepia and every Night paper the lowest text contrast over every possible hash is 7.001:1, so the fallback is never reached with Shelf's palettes.

**The steps exactly.** Both loops build their steps by repeated addition or subtraction in doubles, as the board does, so a step is not always the round number. lineInk uses 0.1, 0.2, 0.30000000000000004, 0.4, 0.5, 0.6, 0.7, 0.7999999999999999, 0.8999999999999999 and 0.9999999999999999. highlight uses 0.34, 0.32, 0.3, 0.27999999999999997, 0.25999999999999995, 0.23999999999999996, 0.21999999999999997, 0.19999999999999998, 0.18, 0.16, 0.14, 0.12000000000000001, 0.1, 0.08 and 0.06. A port in another language has to use these doubles, not 0.34 − 0.02 × i.

**night(hash)**: the Night reading palette, tinted with the article's hue in whole degrees: bg OKLCH(0.215, 0.022, hue), text (0.905, 0.012, hue), muted (0.745, 0.022, hue), line = lineInk on bg with muted as the text colour, hl = highlight on bg and text.

## Determinism

The promise is the same picture in V8 (Chrome, Node), SpiderMonkey (Firefox) and Hermes (React Native). ECMAScript defines double-precision + − × ÷, comparisons, integer operations and number parsing exactly, but lets each engine approximate `Math.pow`, `sin`, `cos`, `exp` and the rest, and engines do differ in the last bit. So:

- No `Math.random`, `Date`, locale, `Intl` or timezone anywhere. The input is the hash string; the module never hashes or parses URLs.
- No `Math.pow`, `**`, `sin`, `cos`, `tan`, `exp`, `log`, `sqrt` or `cbrt` anywhere (`test.cjs` scans for them). Cubes are `x * x * x`.
- sRGB to linear light is a 256-entry table (`LIN`), and linear light to an sRGB byte is a table of 255 thresholds (`ENC`). Both were generated once, in V8, from the board's own formulas and written into the file as literals. The thresholds reproduce the board's `pow`-based encoder exactly (checked 4,096 doubles either side of every step and two million random values).
- OKLCH angles use the board's radians, (deg × π) / 180, a three-part Cody–Waite reduction by π/2 (fdlibm's constants) and the FreeBSD msun sine and cosine kernels. These are not bit-identical to V8's `Math.sin` and `Math.cos`: they differ in the last bit on 3,730 of the 393,528 angles the module can receive. No colour depends on that last bit; the exhaustive check below shows every palette's bytes equal the board's. The signal lightness uses a port of FreeBSD's `e_exp.c`, which agrees with V8's `Math.exp` bit for bit on all 65,536 inputs it can receive.
- `Math.floor`, `Math.round`, `%` and `parseInt` are used too, and ECMAScript defines them exactly. One engine family is known to round wrongly: Windows' JScript rounds by floor(x + 0.5), so `Math.round(0.49999999999999994)` gives 1. Every argument `mix()` can receive from lineInk and highlight (its 25 steps and the 6% fallback, with every pair of bytes) was enumerated, and none is that value. Exact halves do occur (at the 0.5 step) and round up, as the specification says.
- Every numeric literal has 17 significant digits or fewer, because ECMAScript only guarantees correct parsing up to 20.
- Geometry is whole numbers; the bands' thirds are fixed strings, in the strips as in the modules.
- This relies on what ECMAScript requires: IEEE-754 doubles, each operation rounded to nearest-even, with no fused multiply-add. V8, SpiderMonkey and Hermes all do this.

Checked: with `--exhaustive`, every one of the 524,288 palette inputs (65,536 hues × 4 schemes × dark and light) and every Night hue gives the board's colours, and the luminance of every one of the 16,777,216 colours equals the board's. The fixtures pass in Node 24 and in Chrome 154 with the served copy loaded as a classic script, run again after the seam rule.

A second engine has run the module: Windows Script Host's JScript 11.0.16384 (the Chakra-based engine in Windows 11, in its ES3 mode), on the module transpiled to ES5 by TypeScript and reprinted by terser without compression, with small ES3 stand-ins for `Map`, `Object.freeze`, `Array.isArray` and `Array.prototype.filter`. It reproduced every value in `fixtures.json` (every SVG hash and the full SVGs included), every output for 1,000 further hashes, and the palette, Night palette, three lineInks and two highlights of all 524,288 palette inputs. That engine's `Math.round` is the faulty one described above, so this also shows the outputs don't lean on it. Hermes's own parser (hermes-parser 0.36, the C++ parser built to WASM) reads all 853 numeric literals in `cover-v1.js` as it then stood as the same doubles as V8, and `hermesc` from `hermes-compiler` 250829098.0.17 compiles the file with `-O`. Both runs predate the seam rule. It adds only string building, the whole numbers 0 and 2 and one whole-number subtraction (S − 2), and its regenerated SVG entries have been checked in Node and Chrome only.

SpiderMonkey and the Hermes runtime haven't run the fixtures yet: the first Firefox build of the extension and the first Hermes build of the app must pass `fixtures.json` before either ships.

## Fixtures

`fixtures.json` holds 64 cases:

- the board's nine sample hashes (its eight articles, sha256 of their normalised URLs, and `https://shelf.app/`, the board's provisional icon seed, kept as a case although the app icon later became C·L·063, flow decision 70, and then D, flow decision 94);
- `shelf-fixture-1` to `shelf-fixture-40` (sha256 of the string);
- edge cases: all zeros, all f, alternating nibbles and bits, both sides of the dark boundary, the signal's lightness peak, and an upper-case hash;
- probes: an unsplit square, both kinds of signal rule, all big modules, many 1-unit leaves.

Each case records the palette; the leaves at depths 1, 2 and 3; the SVG at size 64 and depth 2 in full, and the sha256 of nine SVG variants; `lineInk` on every Shelf surface plus two probe surfaces that reach the mixing step and the text-colour fallback; `highlight` for Paper, Sepia, Night and a probe palette that reaches the 6% floor; and `night`. The surfaces and palettes are listed at the top of the file.

A port passes when it reproduces every value, and every platform runs the whole file, including a platform that draws from leaves (the phone). The leaves are recorded for one square at depths 1 to 3; the SVG hashes are the only record of a wide layout (`cols: 3`, as in the Reader's 3:1 band), of the draw-in markup and of the grey covers, so skipping them would leave those untested on that platform. Depth 0 isn't recorded, because nothing draws it; add it to the fixtures before anything does.
