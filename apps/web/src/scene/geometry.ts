// The landing page's scene geometry, kept free of the DOM so it can be tested.
// The summit photograph is cover-fitted to the stage; the plate, its cloud loop, the wordmark and the
// cut-out near ridge share that one box, so they stay aligned at every size.

/** The summit loop's frame, 2206 × 946 (docs/design/web/assets/SOURCES.md). */
export const SUMMIT_ASPECT = 2206 / 946;

/**
 * The near ridge's crest across the photograph: y from 0 (top) to 1 (bottom), 65 samples left to right,
 * measured from the cut-out (ridge-*.webp). Regenerate it with the cut.
 */
export const CREST: readonly number[] = [
  0.56, 0.559, 0.544, 0.542, 0.536, 0.542, 0.549, 0.555, 0.569, 0.631, 0.648, 0.67, 0.699, 0.723, 0.748, 0.74, 0.742,
  0.74, 0.711, 0.707, 0.707, 0.715, 0.721, 0.726, 0.747, 0.754, 0.783, 0.799, 0.804, 0.819, 0.822, 0.812, 0.779, 0.788,
  0.784, 0.77, 0.772, 0.781, 0.783, 0.815, 0.822, 0.826, 0.8, 0.804, 0.813, 0.832, 0.837, 0.839, 0.852, 0.867, 0.913,
  0.951, 0.952, 0.992, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
];

/** Below this width the window onto the photograph slides left, where the near ridge stands tallest. */
export const NARROW = 760;

/** The share of the wordmark's height hidden behind the rock. */
export const BURY = { wide: 0.4, narrow: 0.24 } as const;

export interface Frame {
  /** The photograph's box in stage pixels. */
  width: number;
  height: number;
  left: number;
  top: number;
}

export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Smoothstep from a to b, clamped. */
export function smooth(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

/** Cover-fit the photograph to a stage of w × h. */
export function coverFrame(w: number, h: number, aspect = SUMMIT_ASPECT): Frame {
  const width = Math.max(w, h * aspect);
  const height = width / aspect;
  const xAnchor = w < NARROW ? 0.3 : 0.5;
  return { width, height, left: (w - width) * xAnchor, top: (h - height) * 0.62 };
}

/** The crest's height at x (0 to 1 across the photograph), interpolated between samples. */
export function crestAt(x: number, crest: readonly number[] = CREST): number {
  const last = crest.length - 1;
  const f = clamp01(x) * last;
  const i = Math.floor(f);
  const j = Math.min(last, i + 1);
  return crest[i] + (crest[j] - crest[i]) * (f - i);
}

/**
 * Where the wordmark's top edge goes, in frame pixels: its foot stands behind the rock by `bury` of its
 * height, measured against the crest averaged across the span it covers. Open sky (no rock) is ignored.
 */
export function wordTop(frame: Frame, centreX: number, wordWidth: number, wordHeight: number, bury: number): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i <= 8; i++) {
    const c = crestAt((centreX - wordWidth / 2 + (wordWidth * i) / 8) / frame.width);
    if (c < 0.99) {
      sum += c;
      n++;
    }
  }
  const foot = (n ? sum / n : 0.85) * frame.height + bury * wordHeight;
  return foot - wordHeight;
}

/** How far the descent into the cloud has gone: 0 at the top of the hero, 1 once its scroll track is used up. */
export function descent(heroTop: number, heroHeight: number, stageHeight: number): number {
  const span = heroHeight - stageHeight;
  return span > 0 ? clamp01(-heroTop / span) : 0;
}

/** The cloud bank's offset, in percent of its own height: 100 hides it below, -30 fills the stage with paper. */
export function veilOffset(d: number): number {
  const p = smooth(0, 0.8, d);
  return (1 - p) * 100 - p * 30;
}

/** How far the dusk scene has come into view: 0 as its top meets the bottom of the screen. */
export function duskProgress(top: number, height: number, viewport: number): number {
  return clamp01((viewport - top) / (viewport * 0.75 + height * 0.25));
}

/** The dusk scene at progress p: its settling zoom, and the fog's lift (percent) and opacity on a quicker clock. */
export function duskState(p: number): { scale: number; fogLift: number; fogOpacity: number } {
  const q = smooth(0, 0.55, p);
  return { scale: 1.14 - 0.14 * smooth(0, 1, p), fogLift: -q * 60, fogOpacity: 1 - 0.8 * q };
}
