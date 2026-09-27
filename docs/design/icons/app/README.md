# Shelf app icons (Lucide companions)

Five interface icons that Lucide doesn't have. They're drawn by hand to Lucide's rules so they can sit in the same toolbar, player or empty state as Lucide icons without looking out of place. They're used exactly like Lucide SVGs: colour comes from `currentColor`, and they scale from the 24 x 24 viewBox.

| File | Use | Metaphor |
| --- | --- | --- |
| `skip-back-15.svg` | Player: jump back 15 seconds | Counter-clockwise circular arrow (the rotate-ccw head and tail) with the numerals 15 drawn as strokes inside it |
| `skip-forward-15.svg` | Player: jump forward 15 seconds | Horizontal mirror of the arc and head (clockwise, head top right). The numerals are identical and are not mirrored |
| `speed-read.svg` | Speed read (RSVP, one word at a time) | RSVP reticle: two rules with a focus tick above and below, and a word bar running through the gap. The ticks sit on the optimal recognition point, about a third of the way into the word, so this doesn't read as a centred "align" icon |
| `speed.svg` | Playback-speed pill button | Speedometer: a 270° dial, a hub dot and a needle at 45°. It doesn't depend on the current rate, so the pill's own text (for example "1.25×") carries the number |
| `shelf.svg` | "Your shelf": empty states, the restore card | Outline bookshelf: a plank with one upright book and one book leaning towards it. The books are open at the bottom and the plank closes them |

## Style rules followed

- 24 x 24 viewBox, `fill="none"`, `stroke="currentColor"`, `stroke-width="2"`, `stroke-linecap="round"`, `stroke-linejoin="round"`, on the root `<svg>` exactly as Lucide ships it.
- Every mark is a stroke: no fills, no `<text>`, no transforms, and no hidden bounding-box rect. The numerals 1 and 5 are plain paths. The only `<circle>` is the speed hub, which is `r="1"`; at stroke 2 that renders as a solid dot, the same way Lucide draws its dots.
- Padding: every stroke centreline stays inside 2 to 22. No stroke edge comes closer than 1 px to the canvas edge, which is Lucide's minimum.
- Lucide geometry is reused where it exists:
  - The skip icons use the rotate-ccw and rotate-cw construction: a large arc, then a tangent-continuous flatter arc into a 45° tail, then an axis-aligned L-shaped head.
  - The book corners use `rx 1`, as in library-big.
  - The 1 has a flag like the one in heading-1. The 5 has a top bar, a short stem and a round bowl, like heading-5.
- Spacing: separate elements are kept about 2 px apart (measured edge to edge on the rendered stroke):
  - arc to numerals: 1.96
  - skip-back head to the 1: 2.03
  - speed-read ticks to the word bar: 2.0
  - speed needle tip to the dial: 2.05
  - the leaning book to the upright book: 2.18
- Documented exceptions to the spacing rule:
  - The gap between the 1 and the 5 is 1.5. This is inside one numeral group, and Lucide's own numerals use 1 px counters.
  - In skip-forward-15, the gap from the head to the corner of the 5's top bar is 1.54.
- Optical size:
  - speed-read, speed and shelf use the same 3 to 21 live area as play and bookmark.
  - The skip circle is r = 10, the size of Lucide's circle-* family, rather than rotate-ccw's r = 9. Fifteen as two 7-unit-tall stroked digits cannot sit inside an r = 9 circle next to a Lucide-sized head. Every r = 9 layout tried left the numerals 1 px or less from the head in at least one of the pair. With r = 10 there is room for about 2 px all round, and the head keeps rotate-ccw's position and form (corner at x = 3; the arms are 4.5 rather than 5 so the head sits in scale with the larger circle).

- The skip icons use Lucide rotate-ccw/rotate-cw geometry exactly (circle r 9), with the numerals `15` centred on (12, 12) at a 1.5 stroke and 3-unit arrowhead arms. Chosen by Richard on 2026-09-27 (variant C) as the best weight match for the surrounding Lucide icons; earlier drafts (r 10, stroke-2 numerals) read too bold and first set the numerals off-centre.

## Checking

Each file was rendered at 24, 32, 48 and 144 px next to Lucide's rotate-ccw, play, zap and bookmark, and the gaps were measured from the centrelines. At 24 px, "15" reads as two digits, and the back and forward heads point in opposite directions.
