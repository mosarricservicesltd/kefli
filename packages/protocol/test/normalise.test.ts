import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NotALinkError, isItemD, itemD, itemHash, normalise } from '../src';

type Case = { name: string; url: string; canonical?: string; expect: string | null };
const fixtures: { cases: Case[] } = JSON.parse(
  readFileSync(join(__dirname, '../../../shared/normalise.fixtures.json'), 'utf8'),
);

describe('normalise fixtures (C§4.3)', () => {
  test.each(fixtures.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    if (c.expect === null) {
      expect(() => normalise(c.url, c.canonical)).toThrow(NotALinkError);
    } else {
      expect(normalise(c.url, c.canonical)).toBe(c.expect);
    }
  });

  test('normalising is idempotent', () => {
    for (const c of fixtures.cases) if (c.expect !== null) expect(normalise(c.expect)).toBe(c.expect);
  });
});

describe('the d tag', () => {
  test('is shelf/item/ and the SHA-256 of the normalised URL', () => {
    const want = createHash('sha256').update('https://xn--bcher-kva.example/a', 'utf8').digest('hex');
    expect(itemHash('https://Bücher.example/a/#x')).toBe(want);
    expect(itemD('https://Bücher.example/a/#x')).toBe(`shelf/item/${want}`);
  });

  test('tells saves from other shelf records', () => {
    expect(isItemD(itemD('https://example.com/'))).toBe(true);
    expect(isItemD('shelf/devices')).toBe(false);
    expect(isItemD(`shelf/item/${'A'.repeat(64)}`)).toBe(false);
  });
});
