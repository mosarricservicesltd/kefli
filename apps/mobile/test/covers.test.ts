import { migrate } from '../src/data/schema';
import { coverDraws, drawMs, drawing, markDrawn } from '../src/data/covers';
import { splitCover } from '../src/ui/coverLeaves';
import { ShelfCover } from '../src/ui/cover';
import { memoryDb } from './sqlite';

const A = '9f40a2ca59c109dd3b5c4f5c3c88fd84ff5579309ebdec62e3294eebb5d4fbd4';
const B = '34331f690e10f4e9184b0c53e40388e8caeb8bd26c8f44a34ae11f7f9e62213d';

describe('covers drawing in (mobile spec 6.4, signature 1)', () => {
  test("a cover splits into the module's own leaves, each growing from its centre", () => {
    const c = splitCover(A);
    expect(c.leaves).toHaveLength(ShelfCover.leaves(A).length);
    expect(c.ground).toMatch(/^<svg viewBox="0 0 800 800".*<rect width="800" height="800" fill="#[0-9A-F]{6}"\/><\/svg>$/);
    expect(c.leaves[0]).toMatchObject({ cx: 50, cy: 50 });
    expect(c.leaves[1]).toMatchObject({ cx: 150, cy: 50 });
    expect(c.leaves.every((l) => l.svg.startsWith('<svg') && !l.svg.includes('class="lf"'))).toBe(true);
    // one big leaf covering the whole cover grows from its middle
    expect(splitCover(B).leaves).toEqual([expect.objectContaining({ cx: 400, cy: 400 })]);
    // the leaves hold every shape of the drawing
    const shapes = (s: string) => (s.match(/<(rect|path|circle)\b/g) ?? []).length;
    const all = ShelfCover.svg(A, { draw: true, depth: 3 });
    expect(shapes(c.ground) + c.leaves.reduce((n, l) => n + shapes(l.svg), 0)).toBe(shapes(all));
    expect(splitCover(A, 3).width).toBe(2400);
  });

  test('a cover draws once per surface, from when it lands in front of you', () => {
    const db = memoryDb();
    migrate(db);
    markDrawn(db, [A], 'list');
    const first = coverDraws(db, [A, B], 'list', 5000, true);
    expect([...first]).toEqual([[A, 0], [B, 5000]]);
    // a later render carries the same start, so an interrupted draw carries on
    expect(coverDraws(db, [B], 'list', 9000, true).get(B)).toBe(5000);
    // off screen, a new save is simply there, drawn
    expect(coverDraws(db, [B], 'sheet', 9000, false).get(B)).toBe(0);
    expect(coverDraws(db, [], 'list', 1, true).size).toBe(0);
  });

  test('how long a draw takes, and whether it still runs', () => {
    expect(drawMs(1)).toBe(520);
    expect(drawMs(22)).toBe(520 + 21 * 34);
    expect(drawing(5000, 5500, 520)).toBe(true);
    expect(drawing(5000, 5600, 520)).toBe(false);
    expect(drawing(0, 1, 520)).toBe(false);
  });
});
