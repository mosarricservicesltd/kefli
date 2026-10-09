import {
  BURY, CREST, SUMMIT_ASPECT, coverFrame, crestAt, descent, duskProgress, duskState, smooth, veilOffset, wordTop,
} from '../src/scene/geometry';

describe('smooth', () => {
  it('clamps and eases', () => {
    expect(smooth(0, 1, -1)).toBe(0);
    expect(smooth(0, 1, 2)).toBe(1);
    expect(smooth(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(smooth(0, 1, 0.25)).toBeLessThan(0.25);
  });
});

describe('coverFrame', () => {
  it('fills a wide desktop stage, centred, never smaller than the stage', () => {
    const f = coverFrame(1440, 900);
    expect(f.width).toBeCloseTo(900 * SUMMIT_ASPECT);
    expect(f.height).toBeCloseTo(900);
    expect(f.left).toBeCloseTo((1440 - f.width) / 2);
    expect(f.width).toBeGreaterThanOrEqual(1440);
  });
  it('keeps the aspect on an ultrawide stage and crops top and bottom', () => {
    const f = coverFrame(3440, 1000);
    expect(f.width).toBe(3440);
    expect(f.height).toBeCloseTo(3440 / SUMMIT_ASPECT);
    expect(f.top).toBeLessThan(0);
  });
  it('slides the window left on a phone', () => {
    const f = coverFrame(400, 860);
    expect(f.left).toBeCloseTo((400 - f.width) * 0.3);
  });
});

describe('crestAt', () => {
  it('returns the samples at their own positions and interpolates between', () => {
    expect(crestAt(0)).toBe(CREST[0]);
    expect(crestAt(1)).toBe(CREST[CREST.length - 1]);
    const mid = crestAt(0.5 / 64);
    expect(mid).toBeCloseTo((CREST[0] + CREST[1]) / 2);
  });
  it('clamps outside the photograph', () => {
    expect(crestAt(-1)).toBe(CREST[0]);
    expect(crestAt(2)).toBe(CREST[CREST.length - 1]);
  });
});

describe('wordTop', () => {
  const frame = coverFrame(1440, 900);
  it('stands the wordmark with its foot just behind the rock', () => {
    const top = wordTop(frame, 720 - frame.left, 800, 270, BURY.wide);
    const foot = top + 270;
    // The foot sits below the crest under the word by 40% of its height.
    expect(foot).toBeGreaterThan(0.7 * frame.height);
    expect(foot).toBeLessThan(frame.height);
  });
  it('buries more when asked to', () => {
    const a = wordTop(frame, 1000, 800, 270, 0.2);
    const b = wordTop(frame, 1000, 800, 270, 0.5);
    expect(b - a).toBeCloseTo(0.3 * 270);
  });
  it('falls back to a fixed foot over open sky', () => {
    const top = wordTop(frame, frame.width * 0.95, 100, 100, 0);
    expect(top + 100).toBeCloseTo(0.85 * frame.height);
  });
});

describe('descent', () => {
  it('runs from 0 to 1 over the hero track', () => {
    expect(descent(0, 2160, 900)).toBe(0);
    expect(descent(-630, 2160, 900)).toBeCloseTo(0.5);
    expect(descent(-5000, 2160, 900)).toBe(1);
  });
  it('is 0 when there is no track to scroll', () => {
    expect(descent(-100, 900, 900)).toBe(0);
  });
});

describe('veilOffset', () => {
  it('hides the bank before the descent and fills the stage with paper at the end', () => {
    expect(veilOffset(0)).toBe(100);
    expect(veilOffset(1)).toBe(-30);
    expect(veilOffset(0.4)).toBeLessThan(100);
  });
});

describe('dusk', () => {
  it('measures progress from the scene meeting the bottom of the screen', () => {
    expect(duskProgress(900, 600, 900)).toBe(0);
    expect(duskProgress(-2000, 600, 900)).toBe(1);
  });
  it('clears the fog by just over half way while the peaks keep settling', () => {
    const half = duskState(0.55);
    expect(half.fogOpacity).toBeCloseTo(0.2);
    expect(half.fogLift).toBeCloseTo(-60);
    expect(half.scale).toBeGreaterThan(1);
    const end = duskState(1);
    expect(end.scale).toBeCloseTo(1);
    expect(duskState(0)).toEqual({ scale: 1.14, fogLift: -0, fogOpacity: 1 });
  });
});
