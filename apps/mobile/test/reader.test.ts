import { normaliseMarkdown } from '@kefli/protocol';
import { articleBlocks } from '../src/reader/blocks';
import { readPrefs, readerColors } from '../src/reader/palette';
import { isDoubleTap, scrollYForWord, wordAtOffset, wordAtScroll, type Place } from '../src/reader/position';
import { alpha, mix } from '../src/ui/colour';
import { S, articles, say, savedWhen } from '../src/ui/strings';

const MD = normaliseMarkdown(['One two three four.', 'Five six seven eight nine ten.', '![x](https://e.com/a.png)', 'Eleven twelve.'].join('\n\n'));
const H = '34331f690e10f4e9184b0c53e40388e8caeb8bd26c8f44a34ae11f7f9e62213d';

describe('the Reader (mobile spec 5.6, 6.7)', () => {
  const { blocks, words } = articleBlocks(MD);
  const places: Place[] = [{ y: 0, h: 50 }, { y: 60, h: 100 }, { y: 170, h: 200 }, { y: 380, h: 40 }];

  test('a word becomes a scroll offset, once every block is measured', () => {
    expect(blocks.map((b) => [b.kind, b.firstWord, b.words])).toEqual([['p', 0, 4], ['p', 4, 6], ['img', 10, 0], ['p', 10, 2]]);
    expect(scrollYForWord(blocks, [places[0]], 300, 5, 40)).toBeNull();
    // word 7 is half way into the second paragraph: 300 + 60 + 50 − 40
    expect(scrollYForWord(blocks, places, 300, 7, 40)).toBe(370);
    expect(scrollYForWord(blocks, places, 0, 0, 40)).toBe(0);
    expect(scrollYForWord([], [], 0, 3, 40)).toBe(0);
  });

  test('a scroll offset becomes a word, and the bottom of the page is the last word', () => {
    const view = { height: 800, content: 2000, words };
    expect(wordAtScroll(blocks, places, 300, 370, 40, view)).toBe(7);
    expect(wordAtScroll(blocks, places, 300, 0, 40, view)).toBe(0);
    expect(wordAtScroll(blocks, places, 300, 1200, 40, view)).toBe(words - 1);
    expect(wordAtScroll(blocks, places, 300, 10, 40, { ...view, words: 0 })).toBe(0);
    expect(wordAtScroll(blocks, places, 300, 900, 40, view)).toBe(11);
    // before the page is measured (content 0), or when it fits the view, there is no bottom to have reached
    expect(wordAtScroll(blocks, places, 300, 0, 40, { ...view, content: 0 })).toBe(0);
    expect(wordAtScroll(blocks, places, 300, 0, 40, { ...view, content: 700 })).toBe(0);
  });

  test('the stored size and palette are checked', () => {
    expect(readPrefs('20', 'sepia')).toEqual({ size: 20, palette: 'sepia' });
    expect(readPrefs('30', 'blue')).toEqual({ size: 18, palette: null });
    expect(readPrefs(null, null)).toEqual({ size: 18, palette: null });
    expect(readPrefs('17.5', 'dark')).toEqual({ size: 18, palette: 'dark' });
  });

  test("each palette takes the article's ink and highlight; Dark is its own Night", () => {
    const light = readerColors(H, 'light');
    expect(light).toMatchObject({ bg: '#F7F6F2', text: '#1C1C1F' });
    expect(light.ink).toMatch(/^#[0-9A-F]{6}$/);
    expect(readerColors(H, 'dark').bg).not.toBe('#191919');
    expect(readerColors(null, 'dark')).toMatchObject({ bg: '#191919', ink: '#DFDFDF' });
    expect(readerColors(H, 'sepia').bg).toBe('#F2E9D8');
  });

  test('colour helpers and the wording of counts and dates', () => {
    expect(alpha('#17171A', 0.5)).toBe('#17171A80');
    expect(alpha('#17171A', 2)).toBe('#17171AFF');
    expect(mix('#000000', '#FFFFFF', 0.5)).toBe('#808080');
    // a thousand and up with a comma, as the fine print's "about 2,000 articles" (FD 119)
    expect([say(1), say(9), say(10), say(999), say(1200), say(1_000_000)]).toEqual(['one', 'nine', '10', '999', '1,200', '1,000,000']);
    expect(S.adv.full(1200)).toBe('Your backup space is full, so the text of 1,200 saves is only on this phone. Kefli tries again each day, and deleting saves makes room.');
    expect(S.adv.daily(1000)).toContain('the text of 1,000 saves');
    expect(articles(50 * 1_048_576)).toBe('2,000');
    expect(S.welcome.earlyMany(3)).toBe('You’ve already saved three articles. They’ll be in your library either way.');
    const now = Date.UTC(2026, 9, 7, 12) / 1000;
    expect(savedWhen(now - 60, now)).toBe('Saved today');
    expect(savedWhen(now - 86_400, now)).toBe('Saved yesterday');
    expect(savedWhen(now - 5 * 86_400, now)).toBe('Saved on 2 October');
  });

  test('a tapped character is its word, as the highlight counts words (FD 107)', () => {
    const t = 'Five six  seven, eight';
    expect([0, 3, 4, 5, 7, 8, 9, 10, 17, 21].map((o) => wordAtOffset(t, o, 4))).toEqual([0, 0, 0, 1, 1, 1, 1, 2, 3, 3]);
    // past the end, or a block counting fewer words, stays inside the block
    expect(wordAtOffset(t, 99, 4)).toBe(3);
    expect(wordAtOffset(t, 21, 2)).toBe(1);
    expect(wordAtOffset('  lead', 0, 1)).toBe(0);
    expect(wordAtOffset('', 0, 0)).toBe(0);
  });

  test('a double tap is two taps on one block, close in time and place', () => {
    const a = { block: 2, x: 100, y: 200, at: 1000 };
    expect(isDoubleTap(null, a)).toBe(false);
    expect(isDoubleTap(a, { ...a, at: 1250 })).toBe(true);
    expect(isDoubleTap(a, { ...a, at: 1350 })).toBe(false);
    expect(isDoubleTap(a, { ...a, block: 3, at: 1100 })).toBe(false);
    expect(isDoubleTap(a, { ...a, x: 130, at: 1100 })).toBe(false);
  });
});
