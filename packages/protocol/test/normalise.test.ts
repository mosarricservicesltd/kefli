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
  test('is kefli/item/ and the SHA-256 of the normalised URL', () => {
    const want = createHash('sha256').update('https://xn--bcher-kva.example/a', 'utf8').digest('hex');
    expect(itemHash('https://Bücher.example/a/#x')).toBe(want);
    expect(itemD('https://Bücher.example/a/#x')).toBe(`kefli/item/${want}`);
  });

  test('tells saves from other kefli records', () => {
    expect(isItemD(itemD('https://example.com/'))).toBe(true);
    expect(isItemD('kefli/devices')).toBe(false);
    expect(isItemD(`kefli/item/${'A'.repeat(64)}`)).toBe(false);
  });
});

describe('agreement with the cover fixtures', () => {
  // shared/cover/fixtures.json was written before normalise existed; its board samples hash the normalised URL.
  const cover: { cases: { id: string; kind: string; input?: string; hash: string }[] } = JSON.parse(
    readFileSync(join(__dirname, '../../../shared/cover/fixtures.json'), 'utf8'),
  );
  const samples = cover.cases.filter((c) => c.kind === 'board-sample');

  test('there are board samples to check', () => expect(samples.length).toBeGreaterThanOrEqual(8));
  test.each(samples.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    expect(itemHash(c.input!)).toBe(c.hash);
  });
});
