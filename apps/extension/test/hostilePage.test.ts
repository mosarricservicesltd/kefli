// What a page itself can do to a save: be too large to read in good time, keep its thread busy or never finish loading,
// or name a javascript: base for its links.
import { linkOnly, orAfter, PAGE_LIMITS, tooLargeToRead, unread, type PageSize } from '../src/captured';
import { baseOf } from '../src/capture';

describe('a page too large to read in good time (PAGE_LIMITS)', () => {
  // measured in Chrome on the pages themselves (the extension's probes): elements, serialised characters, widest parent
  const page = (elements: number, chars: number, children: number, text: number): PageSize => ({ elements, chars, children, text });
  test.each([
    ['World War II on Wikipedia (read in 2.8 s)', page(17_011, 2_546_421, 464, 36_103)],
    ['War and Peace on Project Gutenberg (7.9 s)', page(14_900, 3_784_764, 401, 3_633_872)],
    ['Pride and Prejudice, its paragraphs all in the body (2.5 s)', page(4_868, 794_145, 2_165, 719_028)],
    ['a long table, cities of India by population (1.0 s)', page(13_047, 1_586_148, 340, 34_522)],
    ['5,000 one-line notes in one article (2.4 s)', page(10_007, 751_823, 5_001, 612_800)],
    ['100,000 tiny elements (5.9 s)', page(100_117, 1_406_864, 1_000, 1_000)],
  ])('%s is read', (_name, size) => expect(tooLargeToRead(size)).toBe(false));

  test.each([
    ['the HTML standard on one page (121 s)', page(337_128, 15_766_693, 10_544, 4_653_982)],
    ['20,000 one-line notes in one article (57 s)', page(40_007, 3_046_823, 20_001, 2_477_800)],
    ['10 MB of article (52 s)', page(80_940, 10_000_314, 699, 8_957_219)],
    ['25 MB of article (over two minutes)', page(202_077, 25_000_477, 1_743, 22_380_513)],
    ['a million elements', page(1_001_017, 14_027_564, 1_001, 1_004_370)],
  ])('%s is saved unread', (_name, size) => expect(tooLargeToRead(size)).toBe(true));

  test('each limit holds on its own', () => {
    const small = page(1, 1, 1, 1);
    expect(tooLargeToRead({ ...small, elements: PAGE_LIMITS.elements + 1 })).toBe(true);
    expect(tooLargeToRead({ ...small, chars: PAGE_LIMITS.chars + 1 })).toBe(true);
    expect(tooLargeToRead({ ...small, children: 20_000, text: 2 * PAGE_LIMITS.widest / 20_000 + 1 })).toBe(true);
  });

  test('a page saved unread keeps its address and title, and the phone fetches its text', () => {
    expect(unread('https://example.com/a', '  The HTML Standard \n')).toEqual({ ...linkOnly('https://example.com/a'), title: 'The HTML Standard' });
    expect(unread('https://example.com/a', '   ').title).toBeNull();
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
