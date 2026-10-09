# Kefli app icons (Lucide companions)

Interface icons that Lucide doesn't have. Three are in use: the skip ±15 pair and speed read (flow decisions 56 and 62). They're drawn by hand to Lucide's rules so they can sit in the same toolbar, player or menu as Lucide icons without looking out of place, and they're used exactly like Lucide SVGs: colour comes from `currentColor`, and they scale from the 24 x 24 viewBox.

Since Fingerprint (decision 65) the files are drawn for a **1.75 stroke**, to sit with Lucide at 1.75. The stroke-2 versions that sat with Lucide at 2 are kept in `variants/stroke-2/`. The comparison sheet is `../app-icons.html` (serve `docs/design` and open `/icons/app-icons.html`; it reads these files, so it won't load from `file://`).

| File | Use | Metaphor |
| --- | --- | --- |
| `skip-back-15.svg` | Player: jump back 15 seconds | Lucide's rotate-ccw ring (r 9, its arc and tail exactly) with a shorter 3-unit head, and the numerals 15 drawn as strokes, centred on (12, 12) |
| `skip-forward-15.svg` | Player: jump forward 15 seconds | Horizontal mirror of the ring and head (rotate-cw, head top right). The numerals are identical and are not mirrored |
| `speed-read.svg` | Speed read (RSVP, one word at a time): the Reader's ⋯ sheet row, in place of Lucide's zap | RSVP reticle: two rules with a focus tick above and below, and a word bar running through the gap. The ticks sit on the optimal recognition point, about a third of the way into the word, so this doesn't read as a centred "align" icon |
| `unused/speed.svg` | Not used (decision 62). Drawn for the playback-speed pill, which stays text only | Speedometer: a 270° dial, a hub dot and a needle at 45° |
| `unused/shelf.svg` | Not used (decision 62). Drawn for "your library" moments; no screen needs one | Outline bookshelf: a plank with one upright book and one leaning towards it |

The two unused drawings are still at stroke 2 and haven't been redrawn for Fingerprint.

## Path data (stroke 1.75)

Root, as Lucide ships it but at 1.75:

```
viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
```

skip-back-15:

```
<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
<path d="M3 5v3h3"/>
<path stroke-width="1.3125" d="M9 10.5l1.125-1.125v5.25"/>
<path stroke-width="1.3125" d="M15 9.375h-2.25v2.25h.75a1.5 1.5 0 0 1 0 3h-.75"/>
```

skip-forward-15:

```
<path d="M21 12a9 9 0 1 1-9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
<path d="M21 5v3h-3"/>
<path stroke-width="1.3125" d="M9 10.5l1.125-1.125v5.25"/>
<path stroke-width="1.3125" d="M15 9.375h-2.25v2.25h.75a1.5 1.5 0 0 1 0 3h-.75"/>
```

speed-read:

```
<path d="M3 4h18"/>
<path d="M10 4v4"/>
<path d="M6 12h12"/>
<path d="M10 20v-4"/>
<path d="M3 20h18"/>
```

The geometry is the same as the stroke-2 files. Only the root stroke (2 to 1.75) and the numerals' stroke (1.5 to 1.3125) changed.

## Style rules followed

- 24 x 24 viewBox, `fill="none"`, `stroke="currentColor"`, round caps and joins, on the root `<svg>` exactly as Lucide ships it, at `stroke-width="1.75"`.
- Every mark is a stroke: no fills, no `<text>`, no transforms and no hidden bounding-box rect. The numerals 1 and 5 are plain paths.
- **The numerals are three quarters of the root stroke**: 1.5 on 2 before, 1.3125 on 1.75 now. Richard chose that proportion with variant C (2026-09-27) as the best weight match for the Lucide icons around it. Left at 1.5 under a 1.75 ring, as the Fingerprint board first drew them, the 15 gains on the ring. Because the numerals carry their own `stroke-width`, a platform that overrides the root stroke (for example a `strokeWidth` prop in React Native) must set the numerals to 0.75 of it, or they won't follow.
- Padding: every stroke centreline stays inside 2 to 22. At 1.75 the nearest stroke edge is 2.125 px from the canvas edge (Lucide's minimum is 1).
- Lucide geometry is reused where it exists:
  - The skip ring is rotate-ccw and rotate-cw exactly: r 9, a large arc, then a tangent-continuous flatter arc into a 45° tail. The head keeps rotate-ccw's corner (x 3, y 8) with 3-unit arms instead of 5, which leaves room for the numerals.
  - The 1 has a flag like the one in heading-1. The 5 has a top bar, a short stem and a round bowl, like heading-5.
- Centring: the numerals' centreline box runs 9 to 15 by 9.375 to 14.625, so it's centred on (12, 12), the centre of the ring.
- Speed read uses the same 3 to 21 live area as play and bookmark.

## Spacing

Edge to edge on the rendered stroke, in px at 24 px, sampled from the paths in Chrome. Separate elements stay about 2 px apart. Thinning the strokes widens each gap a little, the same way Lucide's own gaps open up at 1.75.

| Icon | Between | Stroke 2 | Stroke 1.75 |
| --- | --- | --- | --- |
| skip-back-15 | head to the 1 | 2.16 | 2.37 |
| skip-back-15 | ring to the 5 | 3.26 | 3.48 |
| skip-forward-15 | head to the corner of the 5's top bar | 1.55 | 1.77 |
| skip-forward-15 | ring to the 1 | 3.90 | 4.12 |
| both skips | the 1 to the 5 | 1.13 | 1.31 |
| speed-read | focus ticks to the word bar | 2.00 | 2.25 |

Documented exceptions: the 1 to the 5 is inside one numeral group (Lucide's own numerals use 1 px counters), and in skip-forward-15 the head comes closest to the corner of the 5's top bar, at 1.77.

## Weight

Rendered ink of skip-back-15 divided by Lucide rotate-ccw's at the same stroke and size: 1.17 at stroke 2, 1.16 at 1.75 (24 and 48 px alike). With the numerals left at 1.5 under a 1.75 ring it would be 1.20.

## Checking

The sheet renders each icon at 20, 24, 32 and 48 px beside rotate-ccw, rotate-cw and zap at 1.75, in Fingerprint's light and dark, in the Now playing card and the dock (an inverted play disc, the speed pill as text only), on the ink and paper fills, and in the Reader's ⋯ sheet. At 24 px on a 1x screen, "15" reads as two digits and the back and forward heads point in opposite directions.

## Variants

- `variants/stroke-2/`: the three in-use icons as drawn for Lucide at 2 (variant C for the skip pair), before Fingerprint.
- `variants/skip-*-15-b.svg`: variant B, an earlier draft on an r 10 circle with larger numerals at 1.5. Richard chose C over it; the drafts before it read too bold and first set the numerals off-centre.
- `variants/skip-*-15-c.svg`: variant C at stroke 2, the same as `variants/stroke-2/`.
