import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { NotALinkError, isItemD, itemD, itemHash, normalise, ownCanonical, withoutUserInfo } from '../src';

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

  test("every case gives the same answer with the phone's URL as the platform's (whatwg-url-minimum, Expo's)", () => {
    // normalise reads URLs with whatwg-url on every engine, never the platform's: the phone's has no Unicode step
    const kept = fixtures.cases.map((c) => ownCanonical(c.url, c.canonical));
    const real = globalThis.URL;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    globalThis.URL = require('whatwg-url-minimum').URL;
    try {
      fixtures.cases.forEach((c, i) => {
        let got: string | null;
        try {
          got = normalise(c.url, c.canonical);
        } catch (e) {
          if (!(e instanceof NotALinkError)) throw e;
          got = null;
        }
        expect([c.name, got, ownCanonical(c.url, c.canonical)]).toEqual([c.name, c.expect, kept[i]]);
      });
    } finally {
      globalThis.URL = real;
    }
  });
});

describe("a page's canonical counts only from its own site (ruling 11)", () => {
  const story = 'https://news.example/2026/10/story';

  test("a page at an amp. or m. host, or a path ending /amp, can't take another site's address and land on its save", () => {
    for (const page of ['https://amp.evil.example/2026/10/story', 'https://m.evil.example/2026/10/story', 'https://evil.example/2026/10/story/amp']) {
      expect(itemHash(page, story)).not.toBe(itemHash(story));
      expect(itemHash(page, story)).toBe(itemHash(page));
    }
    // the site's own AMP page still joins the story's save
    expect(itemHash('https://amp.news.example/2026/10/story', story)).toBe(itemHash(story));
  });

  test('ownCanonical keeps a canonical on the page’s own site, as normalise takes it', () => {
    expect(ownCanonical('https://amp.news.example/2026/10/story', story)).toBe(story);
    expect(ownCanonical('https://m.news.example/a', 'https://www.news.example/a')).toBe('https://www.news.example/a');
    // an ordinary page keeps one on its own host, which normalise reads only for the alternate forms
    expect(ownCanonical('https://news.example/a?ref=x', 'https://news.example/a')).toBe('https://news.example/a');
  });

  test('ownCanonical leaves out one on another site, from any page, as a page naming none', () => {
    expect(ownCanonical('https://amp.evil.example/2026/10/story', story)).toBeNull();
    expect(ownCanonical('https://syndicated.example/a', 'https://news.example/a')).toBeNull();
    expect(ownCanonical('https://m.example.com/a', 'https://example.com@evil.example/a')).toBeNull();
  });

  test('ownCanonical takes nothing that isn’t a link, and never throws', () => {
    const long = `https://${'a'.repeat(2_000)}.example/a`;
    for (const [url, canonical] of [
      ['https://m.example.com/a', null], ['https://m.example.com/a', undefined], ['https://m.example.com/a', ''],
      ['https://m.example.com/a', 'javascript:alert(1)'], ['https://m.example.com/a', 'not a url'], ['https://m.example.com/a', long],
      ['not a url', 'https://example.com/a'], ['file:///etc/passwd', 'file:///etc/passwd'], [long, long],
    ] as const) {
      expect(ownCanonical(url, canonical)).toBeNull();
    }
  });

  test('ownCanonical and normalise agree on every fixture', () => {
    for (const c of fixtures.cases.filter((k) => k.canonical !== undefined && k.expect !== null)) {
      const own = ownCanonical(c.url, c.canonical);
      if (own === null) expect(normalise(c.url, c.canonical)).toBe(normalise(c.url));
      else expect([normalise(c.url), normalise(own)]).toContain(normalise(c.url, c.canonical));
    }
  });
});

describe("an address's user info is no part of its save (ruling 8)", () => {
  test('a page saved with a user name and password and without them is one save, whose hash holds neither', () => {
    const plain = itemHash('https://example.com/private/a');
    for (const u of ['https://user:hunter2@example.com/private/a', 'https://user@example.com/private/a', 'https://:hunter2@example.com/private/a#x']) {
      expect(itemHash(u)).toBe(plain);
      expect(normalise(u)).not.toMatch(/hunter2|user/);
    }
    // through a canonical too
    expect(itemHash('https://m.example.com/private/a', 'https://user:hunter2@example.com/private/a')).toBe(plain);
  });

  test('the canonical a save keeps holds none either, however the page came to name it', () => {
    // a relative canonical takes the user info of the address it is resolved against: on the phone, where the fetch
    // ended, which keeps what was shared
    expect(ownCanonical('https://user:hunter2@m.example.com/a', 'https://user:hunter2@example.com/a')).toBe('https://example.com/a');
    expect(ownCanonical('https://m.example.com/a', 'https://:hunter2@www.example.com/a?b=1#c')).toBe('https://www.example.com/a?b=1#c');
    // one without any is kept exactly as the page gave it
    expect(ownCanonical('https://m.example.com/a', 'https://Example.com/a b')).toBe('https://Example.com/a b');
  });

  test('withoutUserInfo takes off only the user info, as a browser sends an address', () => {
    expect(withoutUserInfo('https://user:pw@example.com/a/?b=2&a=1#f')).toBe('https://example.com/a/?b=2&a=1#f');
    expect(withoutUserInfo('http://user@[2001:db8::1]:8080/a')).toBe('http://[2001:db8::1]:8080/a');
    expect(withoutUserInfo('https://www.bank.example@evil.example/a')).toBe('https://evil.example/a');
  });

  test('withoutUserInfo leaves an address without any, and anything that isn’t a link, exactly as it was', () => {
    for (const u of ['https://Example.com/a b?utm_source=x#f', 'mailto:someone@example.com', 'not a url', 'ftp://u:p@example.com/', `https://u:p@${'a'.repeat(2_000)}.example/`]) {
      expect(withoutUserInfo(u)).toBe(u);
    }
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
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  test('so is one written as a canonical, which is ignored as an unusable canonical is', () => {
    const t = Date.now();
    expect(normalise('https://amp.example.com/a', `https://${cjk}.com/a`)).toBe('https://amp.example.com/a');
    expect(Date.now() - t).toBeLessThan(2_000);
  });

  test('tabs, newlines, backslashes, a missing slash and leading space are read as the URL Standard reads them', () => {
    const long = 'a'.repeat(1021) + '.com';
    for (const u of [`\t https://${long}/`, `https:${long}/`, `https:\\\\${long}/`, `HTTPS://${long}/`, `https://x@y@${long}/`, `https://${long.slice(0, 600)}\n${long.slice(600)}/`]) {
      expect(() => normalise(u)).toThrow(/host too long/);
    }
    expect(normalise(`https://${'a'.repeat(1020)}.com?x=${'q'.repeat(5000)}`)).toBe(`https://${'a'.repeat(1020)}.com/?x=${'q'.repeat(5000)}`);
  });
});
