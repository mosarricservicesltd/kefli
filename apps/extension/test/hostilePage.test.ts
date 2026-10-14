// What a page itself can do to a save: be too large to read in good time, keep its thread busy or never finish loading,
// name a javascript: base for its links, or name another site's address as its own.
import { itemHash } from '../../../packages/protocol/src/normalise';
import { GUARD_SAMPLE_CHARS, keepHtml, linkOnly, orAfter, PAGE_LIMITS, tooLargeToRead, unread, type PageSize, type Parsed } from '../src/captured';
import { baseOf, capture } from '../src/capture';

describe('a page too large to read in good time (PAGE_LIMITS)', () => {
  // measured in Chrome on the pages themselves (the extension's probes): elements, the body’s text less its scripts and
  // styles, the serialised page, and the widest parent’s children and text
  const page = (elements: number, readable: number, chars: number, children: number, text: number): PageSize => ({ elements, readable, chars, children, text });
  test.each([
    ['World War II on Wikipedia (read in 2.8 s)', page(17_011, 402_725, 2_546_421, 464, 36_103)],
    ['War and Peace on Project Gutenberg (7.9 s)', page(14_900, 3_633_872, 3_784_764, 401, 3_633_872)],
    ['Pride and Prejudice, its paragraphs all in the body (2.5 s)', page(4_868, 719_028, 794_145, 2_165, 719_028)],
    ['Moby-Dick, its 2,846 paragraphs all in the body', page(4_493, 1_379_850, 1_431_334, 2_846, 1_379_850)],
    ['a long table, cities of India by population (1.0 s)', page(13_047, 44_037, 1_586_148, 340, 34_522)],
    ['5,000 one-line notes in one article (2.4 s)', page(10_007, 612_800, 751_823, 5_001, 612_800)],
    ['100,000 tiny elements (5.9 s)', page(100_117, 104_370, 1_406_864, 1_000, 1_000)],
    ['10 million characters of an app’s data around a short article (2.6 s)', page(39, 13_090, 10_013_504, 31, 13_090)],
    ['a 20 MB attribute beside a short article (4.4 s)', page(38, 13_090, 20_013_451, 31, 13_090)],
  ])('%s is read', (_name, size) => expect(tooLargeToRead(size)).toBe(false));

  test.each([
    ['the HTML standard on one page (121 s)', page(337_128, 4_653_982, 15_766_693, 10_544, 4_653_982)],
    ['20,000 one-line notes in one article (57 s)', page(40_007, 2_477_800, 3_046_823, 20_001, 2_477_800)],
    ['10 MB of article (52 s)', page(80_940, 8_957_219, 10_000_314, 699, 8_957_219)],
    ['25 MB of article (over two minutes)', page(202_077, 22_380_513, 25_000_477, 1_743, 22_380_513)],
    ['a million elements', page(1_001_017, 1_004_370, 14_027_564, 1_001, 1_004_370)],
    ['40 million characters of an app’s data around a short article', page(39, 13_090, 40_013_504, 31, 13_090)],
  ])('%s is saved unread', (_name, size) => expect(tooLargeToRead(size)).toBe(true));

  test('each limit holds on its own', () => {
    const small = page(1, 1, 1, 1, 1);
    expect(tooLargeToRead(small)).toBe(false);
    expect(tooLargeToRead({ ...small, elements: PAGE_LIMITS.elements + 1 })).toBe(true);
    expect(tooLargeToRead({ ...small, readable: PAGE_LIMITS.readable + 1 })).toBe(true);
    expect(tooLargeToRead({ ...small, chars: PAGE_LIMITS.serialised + 1 })).toBe(true);
    expect(tooLargeToRead({ ...small, children: 20_000, text: 2 * PAGE_LIMITS.widest / 20_000 + 1 })).toBe(true);
    // before the page is serialised, chars is 0
    expect(tooLargeToRead({ ...small, readable: PAGE_LIMITS.readable, chars: 0 })).toBe(false);
  });

  test('a page saved unread keeps its address and title, and the phone fetches its text', () => {
    expect(unread('https://example.com/a', '  The HTML Standard \n')).toEqual({ ...linkOnly('https://example.com/a'), title: 'The HTML Standard' });
    expect(unread('https://example.com/a', '   ').title).toBeNull();
  });
});

describe('the guard on a page that isn’t readerable (contract 4.2)', () => {
  /** keepHtml's answer for a page that isn’t readerable, and how long it took, or what it threw. */
  const guard = (markdown: string) => {
    const started = Date.now();
    try {
      return { kept: keepHtml({ ok: true, readerable: false, markdown }, '<p>x</p>') !== null, ms: Date.now() - started };
    } catch (e) {
      return { threw: String(e) };
    }
  };
  // each of these, counted whole, overflowed the stack or ran for minutes in the page’s own thread
  test.each([
    ['3 MB of prose', 'The quick brown fox jumps over the lazy dog. '.repeat(70_000), true],
    ['16,384 quotes inside quotes', '>'.repeat(16_384), false],
    ['32 KB of * and _', '*_'.repeat(16_384), false],
  ])('%s is judged from its opening, in good time', (_name, markdown, kept) => {
    const r = guard(markdown);
    expect(r).toMatchObject({ kept });
    // counted whole, the * and _ took over a minute here; a busy machine still gets well under
    expect(r.ms).toBeLessThan(30_000);
  }, 60_000);

  test('a page whose opening holds 120 words keeps its text; one whose opening holds none is taken as no article', () => {
    const words = (n: number) => Array.from({ length: n }, () => 'word').join(' ');
    expect(guard(words(120) + '\n\n' + ','.repeat(3_000_000))).toMatchObject({ kept: true });
    // the words come after the opening: the phone fetches this page itself
    expect(guard(','.repeat(GUARD_SAMPLE_CHARS) + '\n\n' + words(500))).toMatchObject({ kept: false });
  });
});

describe('a capture or a shortcut press the page never lets finish', () => {
  test('gives way after its time, and the late answer is let go', async () => {
    const started = Date.now();
    expect(await orAfter(new Promise(() => undefined), 50, null)).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await orAfter(Promise.resolve('read'), 50, null)).toBe('read');
  });
});

describe("a page's canonical link is kept only from its own site (contract 4.3, ruling 11)", () => {
  const ARTICLE = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ') + '\n';
  /** A small page as capture reads it, without a browser: no elements to count, a body of a few words. */
  const page = { getElementsByTagName: () => [], body: { textContent: 'a few words', querySelectorAll: () => [] }, documentElement: { outerHTML: '<html><body><p>a few words</p></body></html>' }, title: 'A page', querySelector: () => null } as unknown as Document;
  /** capture on that page, with the parser bundle's two calls answering as for a page naming canonical. */
  const captured = (href: string, canonical: string | null) => {
    const g = globalThis as unknown as { kefliParse: () => Parsed; kefliArticle: () => { ok: boolean; content?: string } };
    g.kefliParse = () => ({ ok: true, title: 'A story', canonical, readerable: true, markdown: ARTICLE });
    g.kefliArticle = () => ({ ok: true, content: '<p>a few words</p>' });
    return capture(page, href);
  };
  const story = 'https://news.example/2026/10/story';

  test("a page at an amp. host naming another site's address keeps its own, and the save request names none", () => {
    const c = captured('https://amp.evil.example/2026/10/story#top', story);
    expect(c).toMatchObject({ url: 'https://amp.evil.example/2026/10/story', canonical: null, html: '<p>a few words</p>' });
    expect(itemHash(c.url, c.canonical)).not.toBe(itemHash(story));
  });

  test('so does an ordinary page naming another site', () => {
    expect(captured('https://syndicated.example/a', 'https://news.example/a').canonical).toBeNull();
  });

  test("the site's own AMP and mobile pages keep theirs, and join the story's save", () => {
    const amp = captured('https://amp.news.example/2026/10/story', story);
    expect(amp.canonical).toBe(story);
    expect(itemHash(amp.url, amp.canonical)).toBe(itemHash(story));
    expect(captured('https://m.news.example/a', 'https://www.news.example/a').canonical).toBe('https://www.news.example/a');
  });
});

describe('the base fragment links are made absolute against', () => {
  const docWith = (href: string | null) => ({ querySelector: () => (href === null ? null : { getAttribute: () => href }) }) as unknown as Pick<Document, 'querySelector'>;
  const url = 'https://example.com/a/page';
  test.each([
    ['no base', null, url],
    ['a relative base', '../b/', 'https://example.com/b/'],
    ['an absolute base', 'https://cdn.example/x/', 'https://cdn.example/x/'],
    ['a javascript: base', 'javascript:alert(1)', url],
    ['a data: base', 'data:text/html,<p>x</p>', url],
    ['a blank base', '   ', url],
    ['a base that isn’t an address', 'http://[::1', url],
  ])('%s', (_name, href, base) => expect(baseOf(docWith(href), url)).toBe(base));
});
