import { ITEM_MAX_DEPTH, ItemVersionError, jsonDepth, parseItem, progressAt, serialiseItem, wordReached } from '../src';

const base = {
  v: 1, url: 'https://example.com/a', canonical: null, title: 'A', site: 'example.com', byline: null,
  saved_at: 1757000000, state: 'unread', progress: 0.5, words: 2450, lang: 'en', text: null, text_hash: null,
  hero: null, source_kind: 'web', audio_pref: null,
};

describe('item JSON (C§4.1, C§10)', () => {
  test('unknown fields survive a round trip', () => {
    const parsed = parseItem(JSON.stringify({ ...base, later_field: { x: 1 } }));
    expect(parsed.extra).toEqual({ later_field: { x: 1 } });
    parsed.item.state = 'archived';
    expect(JSON.parse(serialiseItem(parsed))).toEqual({ ...base, state: 'archived', later_field: { x: 1 } });
  });

  test('refuses to write a version it does not understand', () => {
    const parsed = parseItem(JSON.stringify({ ...base, v: 2 }));
    expect(() => serialiseItem(parsed)).toThrow(ItemVersionError);
  });

  test('refuses JSON that is not an item', () => {
    expect(() => parseItem('[]')).toThrow(TypeError);
    expect(() => parseItem('{"v":1}')).toThrow(TypeError);
  });

  test('an item nested deeper than ITEM_MAX_DEPTH is refused before it is parsed; brackets inside strings don’t count', () => {
    const nest = (n: number) => `${'['.repeat(n)}${']'.repeat(n)}`;
    // the item object is one level, so a field nested 31 more is the deepest taken
    expect(parseItem(JSON.stringify({ ...base }).replace(/}$/, `,"later":${nest(31)}}`)).extra.later).toBeDefined();
    for (const n of [32, 4_500, 20_000]) {
      expect(() => parseItem(JSON.stringify({ ...base }).replace(/}$/, `,"later":${nest(n)}}`))).toThrow('nests too deep');
    }
    expect(jsonDepth(JSON.stringify({ title: '[[[{{{', byline: 'a \\" [[[', x: [{}] }))).toBe(3);
    expect(ITEM_MAX_DEPTH).toBe(32);
  });

  test('progress and the word reached', () => {
    expect(wordReached({ progress: 0.5, words: 2450 })).toBe(1225);
    expect(wordReached({ progress: 'x' as unknown as number, words: 100 })).toBe(0);
    expect(wordReached({ progress: 0.5, words: null })).toBe(0);
    expect(progressAt(1225, 2450)).toBe(0.5);
    expect(progressAt(3000, 2450)).toBe(1);
    expect(progressAt(10, 0)).toBe(0);
  });
});
