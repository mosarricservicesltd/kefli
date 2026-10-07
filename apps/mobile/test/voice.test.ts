import { RATES, WPS_SEED, clock, nextRate, rateLabel, readRate, readWps, seconds, startWord } from '../src/voice/clock';

describe('the listening clock (mobile spec 5.7)', () => {
  test('the speed pill steps and wraps', () => {
    expect(RATES.map(nextRate)).toEqual([1, 1.2, 1.5, 2, 0.8]);
    expect(nextRate(1.1)).toBe(0.8);
    expect(rateLabel(1.5)).toBe('1.5×');
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
    expect([readRate('1.5'), readRate('3'), readRate(null)]).toEqual([1.5, 1, 1]);
    expect([readWps('3.03'), readWps('0'), readWps(null)]).toEqual([3.03, WPS_SEED, WPS_SEED]);
  });
});
