import { RATES, WPS_SEED, clock, nextRate, rateLabel, readRate, readWps, seconds, snapRate, startWord } from '../src/voice/clock';

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

  test('stored values are checked', () => {
    expect([readRate('1.5'), readRate('0.5'), readRate('3'), readRate(null)]).toEqual([1.5, 0.5, 1, 1]);
    // the old steps read as 1
    expect([readRate('0.8'), readRate('1.2')]).toEqual([1, 1]);
    expect([readWps('3.03'), readWps('0'), readWps(null)]).toEqual([3.03, WPS_SEED, WPS_SEED]);
  });
});
