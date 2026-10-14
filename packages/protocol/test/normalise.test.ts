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

describe('hostile hosts (ruling 10)', () => {
  // 20,000 different CJK characters in one label: UTS-46's Punycode step is quadratic in them, and took about 3 s here
  // and minutes on the phone, every time a spooled share holding it was picked up.
  const cjk = Array.from({ length: 20_000 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');

  test('a host written too long is refused before it is parsed', () => {
    const t = Date.now();
    expect(() => normalise(`https://${cjk}.com/a`)).toThrow(/host too long/);
    expect(() => itemHash(`https://${cjk}.com/a`)).toThrow(NotALinkError);
    expect(Date.now() - t).toBeLessThan(500);
  });

  test('so is one written as a canonical, which is ignored as an unusable canonical is', () => {
    const t = Date.now();
    expect(normalise('https://amp.example.com/a', `https://${cjk}.com/a`)).toBe('https://amp.example.com/a');
    expect(Date.now() - t).toBeLessThan(500);
  });

  test('tabs, newlines, backslashes, a missing slash and leading space are read as the URL Standard reads them', () => {
    const long = 'a'.repeat(1021) + '.com';
    for (const u of [`\t https://${long}/`, `https:${long}/`, `https:\\\\${long}/`, `HTTPS://${long}/`, `https://x@y@${long}/`, `https://${long.slice(0, 600)}\n${long.slice(600)}/`]) {
      expect(() => normalise(u)).toThrow(/host too long/);
    }
    expect(normalise(`https://${'a'.repeat(1020)}.com?x=${'q'.repeat(5000)}`)).toBe(`https://${'a'.repeat(1020)}.com/?x=${'q'.repeat(5000)}`);
  });
});
