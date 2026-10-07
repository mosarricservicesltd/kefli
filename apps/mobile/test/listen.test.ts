import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { playFrom, playedRows, recordPlayed } from '../src/data/listen';
import { commitDelete, deleteItem } from '../src/data/library';
import { cardOnScreen, meter, ruler, sentenceOf } from '../src/voice/clock';
import { memoryDb } from './sqlite';

const PK = 'ab'.repeat(32);
const h = (n: number) => n.toString(16).padStart(64, '0');

describe('Listen (mobile spec 5.7)', () => {
  test('Played: most recently started first, without deleted articles', () => {
    const db = memoryDb();
    migrate(db);
    ensureIdentityRow(db, 1, PK, 'new', true);
    for (const n of [1, 2, 3]) db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'u', 1, 'unread', 'cached', 's')", PK, h(n));
    recordPlayed(db, PK, h(1), 10);
    recordPlayed(db, PK, h(2), 20);
    recordPlayed(db, PK, h(1), 30);
    expect(playedRows(db, PK).map((r) => r.hash)).toEqual([h(1), h(2)]);
    const d = deleteItem(db, 40, PK, h(1));
    expect(playedRows(db, PK).map((r) => r.hash)).toEqual([h(2)]);
    commitDelete(db, PK, h(1), d.held);
    expect(db.get('SELECT COUNT(*) AS n FROM listen_history')).toEqual({ n: 1 });
  });

  test('an article plays from its place, or from the top once heard through', () => {
    expect(playFrom({ words: 100, position_word: 40 })).toBe(40);
    expect(playFrom({ words: 100, position_word: 99 })).toBe(0);
    expect(playFrom({ words: null, position_word: 0 })).toBe(0);
  });

  test('the ruler: minutes and quarter ticks, widening for long articles', () => {
    const short = ruler(96);
    expect(short.numbers.map((x) => x.label)).toEqual(['0', '1']);
    expect(short.ticks.filter((t) => t.major).length).toBe(2);
    expect(short.ticks.length).toBe(7);
    const long = ruler(3 * 3600);
    expect(long.numbers.map((x) => x.label)).toEqual(['0', '30', '60', '90', '120', '150', '180']);
    expect(long.numbers.every((x) => x.at >= 0 && 1 >= x.at)).toBe(true);
    expect(ruler(0)).toEqual({ numbers: [], ticks: [] });
  });

  test('the word meter: the spoken sentence, lit to the spoken word', () => {
    expect(sentenceOf([0, 5, 12, 20], 13)).toBe(2);
    expect(sentenceOf([0, 5, 12, 20], 0)).toBe(0);
    expect(sentenceOf([0, 5, 12, 20], 99)).toBe(3);
    expect(meter(12, 8, 14, true)).toEqual({ marks: 8, lit: 3 });
    expect(meter(12, 8, 14, false)).toEqual({ marks: 8, lit: 0 });
  });

  test("the mini takes over below 40% of the card in view, and hands back above 60%", () => {
    const card = { y: 100, h: 500 };
    expect(cardOnScreen(true, card, 0, 1000)).toBe(true);
    expect(cardOnScreen(true, card, 350, 1000)).toBe(true); // half in view: stays
    expect(cardOnScreen(true, card, 450, 1000)).toBe(false); // 30%
    expect(cardOnScreen(false, card, 350, 1000)).toBe(false); // half: stays off
    expect(cardOnScreen(false, card, 250, 1000)).toBe(true); // 70%
    expect(cardOnScreen(false, { y: 0, h: 0 }, 0, 1000)).toBe(false);
  });
});
