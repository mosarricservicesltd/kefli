// Cover v1's golden fixtures (shared/cover/fixtures.json) in the app's own test run: every case's palette, Night
// palette, line inks and highlights, as the app reads them through ui/cover. shared/cover/test.cjs checks far more
// (the board, every palette input); this keeps the module the app bundles inside the same suite and its coverage.
import { ShelfCover } from '../src/ui/cover';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const F = require('../../../shared/cover/fixtures.json');

type Case = { id: string; hash: string; palette: Record<string, unknown>; night: Record<string, string>; lineInk: Record<string, string>; highlight: Record<string, string> };
type Surface = { bg: string; text: string };

describe('cover v1 fixtures (shared/cover/fixtures.json)', () => {
  test.each((F.cases as Case[]).map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const P = ShelfCover.palette(c.hash) as unknown as Record<string, unknown>;
    expect({ ground: P.ground, deep: P.deep, soft: P.soft, signal: P.signal, hue: P.hue, scheme: P.scheme, dark: P.dark }).toEqual(c.palette);
    expect(ShelfCover.night(c.hash)).toEqual(c.night);
    for (const [k, s] of Object.entries(F.surfaces as Record<string, Surface>)) expect([k, ShelfCover.lineInk(c.hash, s.bg, s.text)]).toEqual([k, c.lineInk[k]]);
    for (const [k, r] of Object.entries(F.reading as Record<string, Surface | string>)) {
      if (typeof r === 'object') expect([k, ShelfCover.highlight(c.hash, r)]).toEqual([k, c.highlight[k]]);
    }
  });
});
