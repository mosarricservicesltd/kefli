# UI brief: Soft pills (signed off 2026-09-27)

Anchor: the Style Lab's Soft pills rendering in Terracotta (`style-lab.html`). A Warm paper alternative (serif titles, no cards) was shown side by side in `mockups/direction-compare.html`; Richard chose Soft pills.

- **Direction:** friendly, tactile, phone-native. Soft warm-white canvas, white cards floating on gentle shadows, pill-shaped controls, Terracotta used sparingly.
- **Type:** Inter (Roboto on the phone) for the whole app. Noto Serif 18 / 1.55 only inside the Reader for article text.
- **Colour:** canvas `background`, cards `surface`, `text` and `muted` from `shared/tokens/tokens.json`. Terracotta for the active control, play and links. The gradient appears on exactly two things: the one primary button on a screen, and the play button.
- **Density:** 16 px screen gutter, 10 px between cards, 12 px inside, 10 px card corners, pills fully round.
- **Rows:** a real article image when the page has one; otherwise no tile and the title takes the full width.
- **Signature:** reading progress. Part-read cards carry a thin Terracotta bar along the bottom edge and say "4 min left" instead of the total.
- **Forbidden:** placeholder thumbnails; gradients beyond the two uses; grey-on-grey low-contrast text; blue or purple anywhere; bare spinners.
- **Dark mode:** shadows don't read on dark, so dark cards use a `line` hairline instead of a shadow.
