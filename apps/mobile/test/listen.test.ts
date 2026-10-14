import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { LISTEN_CUED, clearCued, listenRows, playFrom, readyRow, recordPlayed, setCued } from '../src/data/listen';
import { commitDelete, deleteItem, setArchived } from '../src/data/library';
import { getSetting } from '../src/data/settings';
import { cardInView, cardOnScreen, meter, ruler, sentenceOf } from '../src/voice/clock';
import { memoryDb } from './sqlite';

const PK = 'ab'.repeat(32);
const h = (n: number) => n.toString(16).padStart(64, '0');

describe('Listen (mobile spec 5.7)', () => {
  test('the list: Unread with text, newest first, without deleted or archived articles (FD 111)', () => {
    const db = memoryDb();
    migrate(db);
    ensureIdentityRow(db, 1, PK, 'new', true);
    for (const [n, text] of [[1, 'cached'], [2, 'cached'], [3, 'remote'], [4, 'failed'], [5, 'cached']] as const) {
      db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'u', ?, 'unread', ?, 's')", PK, h(n), n, text);
    }
    expect(listenRows(db, PK).map((r) => r.hash)).toEqual([h(5), h(2), h(1)]);
    setArchived(db, 10, PK, h(2), true);
    deleteItem(db, 11, PK, h(5));
    expect(listenRows(db, PK).map((r) => r.hash)).toEqual([h(1)]);
  });

  test('the ready card: the last played still in Unread, else the top of Unread (FD 111)', () => {
    const db = memoryDb();
    migrate(db);
    ensureIdentityRow(db, 1, PK, 'new', true);
    expect(readyRow(db, PK)).toBeNull();
    for (const n of [1, 2, 3]) db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'u', ?, 'unread', 'cached', 's')", PK, h(n), n);
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(3) }, last: false });
    recordPlayed(db, PK, h(1), 10);
    recordPlayed(db, PK, h(2), 20);
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(2) }, last: true });
    // archived: skipped for the next most recent still in Unread
    setArchived(db, 30, PK, h(2), true);
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(1) }, last: true });
    const d = deleteItem(db, 40, PK, h(1));
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(3) }, last: false });
    commitDelete(db, PK, h(1), d.held);
    expect(db.get('SELECT COUNT(*) AS n FROM listen_history')).toEqual({ n: 1 });
  });

  test('a row put in the card comes first while it can still play, else the card falls back (FD 115)', () => {
    const db = memoryDb();
    migrate(db);
    ensureIdentityRow(db, 1, PK, 'new', true);
    const OTHER = 'cd'.repeat(32);
    ensureIdentityRow(db, 1, OTHER, 'new', false);
    for (const n of [1, 2, 3, 4]) db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'u', ?, 'unread', 'cached', 's')", PK, h(n), n);
    db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'u', 5, 'unread', 'remote', 's')", PK, h(5));
    db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, 'u', 6, 'unread', 'cached', 's')", OTHER, h(6));
    recordPlayed(db, PK, h(2), 20);
    // chosen: first, labelled Up next, ahead of the last played
    setCued(db, h(1));
    expect(getSetting(db, LISTEN_CUED)).toBe(h(1));
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(1) }, last: false });
    // archived, deleted or without text: the card falls back to the last played
    setArchived(db, 30, PK, h(1), true);
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(2) }, last: true });
    setCued(db, h(3));
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(3) }, last: false });
    deleteItem(db, 40, PK, h(3));
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(2) }, last: true });
    setCued(db, h(5));
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(2) }, last: true });
    // another library's article is never held
    setCued(db, h(6));
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(2) }, last: true });
    // anything playing clears the choice
    setCued(db, h(4));
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(4) }, last: false });
    clearCued(db);
    expect(getSetting(db, LISTEN_CUED)).toBeNull();
    expect(readyRow(db, PK)).toMatchObject({ row: { hash: h(2) }, last: true });
    clearCued(db);
    expect(getSetting(db, LISTEN_CUED)).toBeNull();
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
    // the share in view, which a row's body checks before scrolling back to the card (FD 115)
    expect(cardInView(card, 0, 1000)).toBe(1);
    expect(cardInView(card, 350, 1000)).toBeCloseTo(0.5);
    expect(cardInView(card, 700, 1000)).toBe(0);
    expect(cardInView({ y: 0, h: 0 }, 500, 1000)).toBe(1);
  });
});
