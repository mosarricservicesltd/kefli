import { RATES, WPS_SEED, clock, nextRate, positionClocks, rateLabel, readRate, readWps, seconds, snapRate, startWord, stepWord, wordAt, wpsFor, wpsKey } from '../src/voice/clock';
import { S } from '../src/ui/strings';

describe('the listening clock (mobile spec 5.7)', () => {
  test('the speed pill steps 1, 1.5, 2, 0.5 and back to 1 (FD 107)', () => {
    expect(RATES.map(nextRate)).toEqual([1, 1.5, 2, 0.5]);
    let r = 1;
    const seen = [r];
    for (let k = 0; 4 > k; k++) seen.push((r = nextRate(r)));
    expect(seen).toEqual([1, 1.5, 2, 0.5, 1]);
    expect(rateLabel(1.5)).toBe('1.5×');
  });

  test('a rate widened from the engine\'s float is snapped to its step, in the pill and its label', () => {
    expect(snapRate(1.2000000476837158)).toBe(1);
    expect(snapRate(0.800000011920929)).toBe(1);
    expect(snapRate(0.5000000001)).toBe(0.5);
    expect(nextRate(1.5000000001)).toBe(2);
    expect(nextRate(2.0000000476837158)).toBe(0.5);
    expect(rateLabel(1.5000000476837158)).toBe('1.5×');
  });

  test('time is words over words a second at the rate', () => {
    expect(seconds(390, 3.9, 1)).toBe(100);
    expect(seconds(390, 3.9, 2)).toBe(50);
    expect([clock(0), clock(65), clock(600), clock(3725)]).toEqual(['0:00', '1:05', '10:00', '1:02:05']);
  });

  test('a session starts at the saved word in view, else the first word in view, and a finished one from the top', () => {
    expect(startWord(120, { first: 100, last: 200 }, 1000)).toBe(120);
    expect(startWord(50, { first: 100, last: 200 }, 1000)).toBe(100);
    expect(startWord(999, { first: 100, last: 200 }, 1000)).toBe(100);
    expect(startWord(999, { first: 999, last: 999 }, 1000)).toBe(0);
    expect(startWord(0, { first: 0, last: 0 }, 0)).toBe(0);
  });

  test('words a second are kept per voice and rate, 1× under the key it always had (FD 107)', () => {
    expect([wpsKey('en-gb-x', 1), wpsKey('en-gb-x', 2), wpsKey('default', 0.5000000001)]).toEqual(['voice.wps.en-gb-x', 'voice.wps.en-gb-x@2', 'voice.wps.default@0.5']);
    const kept: Record<string, string> = { 'voice.wps.v': '3.2', 'voice.wps.v@1.5': '3.3', 'voice.wps.w@2': 'x' };
    const get = (k: string) => kept[k] ?? null;
    // a rate measured is its own; one not yet heard is 1×'s scaled by the seed; with nothing learned, the seed of 3.9
    expect(wpsFor(get, 'v', 1)).toBe(3.2);
    expect(wpsFor(get, 'v', 1.5)).toBe(3.3);
    expect(wpsFor(get, 'v', 2)).toBe(3.2);
    expect(wpsFor(get, 'v', 0.5)).toBeCloseTo(3.2 * 1.3);
    expect(wpsFor(get, 'w', 2)).toBe(WPS_SEED);
    expect(wpsFor(get, 'w', 0.5)).toBeCloseTo(WPS_SEED * 1.3);
    expect(wpsFor(get, 'none', 1)).toBe(WPS_SEED);
  });

  test('stored values are checked', () => {
    expect([readRate('1.5'), readRate('0.5'), readRate('3'), readRate(null)]).toEqual([1.5, 0.5, 1, 1]);
    // the old steps read as 1
    expect([readRate('0.8'), readRate('1.2')]).toEqual([1, 1]);
    expect([readWps('3.03'), readWps('0'), readWps(null)]).toEqual([3.03, WPS_SEED, WPS_SEED]);
  });

  test('a point on the ruler is a word: the share of the words, to the word, within the article (FD 115)', () => {
    expect(wordAt(0, 1000)).toBe(0);
    expect(wordAt(0.5, 1000)).toBe(500);
    expect(wordAt(0.2504, 1000)).toBe(250);
    expect(wordAt(0.2506, 1000)).toBe(251);
    // the far end is the last word; a point beyond either end is clamped
    expect(wordAt(1, 1000)).toBe(999);
    expect(wordAt(1.3, 1000)).toBe(999);
    expect(wordAt(-0.2, 1000)).toBe(0);
    // an empty article, or a ruler not yet measured
    expect(wordAt(0.5, 0)).toBe(0);
    expect(wordAt(NaN, 1000)).toBe(0);
  });

  test('a screen reader steps the ruler by a twentieth of the article, at least a word (FD 115)', () => {
    expect(stepWord(400, 1000, 1)).toBe(450);
    expect(stepWord(400, 1000, -1)).toBe(350);
    expect(stepWord(980, 1000, 1)).toBe(999);
    expect(stepWord(20, 1000, -1)).toBe(0);
    expect(stepWord(3, 10, 1)).toBe(4);
    expect(stepWord(0, 0, 1)).toBe(0);
  });

  test('the ruler reads as the card’s clocks, elapsed of total (FD 115)', () => {
    expect(positionClocks(390, 3900, 3.9, 1)).toEqual(['1:40', '16:40']);
    expect(positionClocks(390, 3900, 3.9, 2)).toEqual(['0:50', '8:20']);
    expect(S.listen.positionValue(...positionClocks(0, 3900, 3.9, 1))).toBe('0:00 of 16:40');
  });
});
