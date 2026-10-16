// A page's title, site and byline as shown and as handed to the voice's media session (reader/clip).
import { SESSION_CHARS, TITLE_CHARS, clip } from '../src/reader/clip';

describe("a page's title, as long as it likes (mobile spec 5.4)", () => {
  test('a real title is shown whole', () => {
    expect(clip('The quiet return of reading later — Example', TITLE_CHARS)).toBe('The quiet return of reading later — Example');
    expect(clip('', SESSION_CHARS)).toBe('');
  });

  test('a megabyte of title is cut, with an ellipsis, under the media session’s one Binder transaction', () => {
    const title = 'Breaking '.repeat(120_000);
    const shown = clip(title, SESSION_CHARS);
    expect(shown).toHaveLength(SESSION_CHARS);
    expect(shown.endsWith('…')).toBe(true);
    expect(title.startsWith(shown.slice(0, -1))).toBe(true);
    expect(clip(title, TITLE_CHARS)).toHaveLength(TITLE_CHARS);
  });

  test('never inside a surrogate pair', () => {
    const emoji = '📚'.repeat(1_000);
    for (const max of [9, 10, 11, SESSION_CHARS]) {
      const s = clip(emoji, max);
      expect(s.length).toBeLessThanOrEqual(max);
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s)).toBe(false);
    }
  });
});
