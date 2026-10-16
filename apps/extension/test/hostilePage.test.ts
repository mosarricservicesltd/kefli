// What a page itself can do to a save: be too large to read in good time, keep its thread busy or never finish loading,
// name a javascript: base for its links, or name another site's address as its own, or one longer than the phone keeps.
import { hexToBytes } from '@noble/hashes/utils.js';
import { itemHash } from '../../../packages/protocol/src/normalise';
import { CANONICAL_MAX, type SaveRequest } from '../../../packages/protocol/src/pairing';
import { LocalSigner } from '../../../packages/protocol/src/signer';
import { unwrap } from '../../../packages/protocol/src/wrap';
import {
  ADDRESS_UNWRAPPABLE, FIELD_MAX, fitted, fromParse, GUARD_SAMPLE_CHARS, keepHtml, linkOnly, orAfter, PAGE_LIMITS, pageUrl, tooLargeToRead, unread, type PageSize, type Parsed,
} from '../src/captured';
import { baseOf, capture } from '../src/capture';
import { webCrypto } from '../src/crypto';
import { AddressTooLongError, prepare, type SaveContext } from '../src/save';

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
  // counted whole, the first two overflowed the stack until the projection kept a stack of its own, and the parse still
  // takes the last two a minute or more in the page’s own thread
  test.each([
    ['3 MB of prose', 'The quick brown fox jumps over the lazy dog. '.repeat(70_000), true],
    ['16,384 quotes inside quotes', '>'.repeat(16_384), false],
    ['32 KB of * and _', '*_'.repeat(16_384), false],
    // the parse's dearest for its length, as Turndown leaves it in a pre whose lines open with a space: on each line,
    // lists nested each inside the one before. Counted whole, these 1,000 lines took 158 s; 2,040 deep in the opening
    // alone took 1.5 s here, and past this bound in a full parallel run on a busy machine, so the lines are 300 deep
    ['1,000 lines of lists nested 300 deep', ` ${'- '.repeat(300)}x\n`.repeat(1_000), false],
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

const ARTICLE = Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ') + '\n';
/** A small page as capture reads it, without a browser: no elements to count, a body of a few words. */
const page = { getElementsByTagName: () => [], body: { textContent: 'a few words', querySelectorAll: () => [] }, documentElement: { outerHTML: '<html><body><p>a few words</p></body></html>' }, title: 'A page', querySelector: () => null } as unknown as Document;
/** capture on that page, with the parser bundle's two calls answering as for a page naming canonical, and any details given. */
const captured = (href: string, canonical: string | null, details: Partial<Parsed> = {}) => {
  const g = globalThis as unknown as { kefliParse: () => Parsed; kefliArticle: () => { ok: boolean; content?: string } };
  g.kefliParse = () => ({ ok: true, title: 'A story', canonical, readerable: true, markdown: ARTICLE, ...details });
  g.kefliArticle = () => ({ ok: true, content: '<p>a few words</p>' });
  return capture(page, href);
};
const story = 'https://news.example/2026/10/story';
const user = new LocalSigner(hexToBytes('11'.repeat(32)));
const NOW = 1_791_600_000;
/** What the background's save has, for the request a capture makes. */
const ctx: SaveContext = {
  device: new LocalSigner(hexToBytes('22'.repeat(32))), crypto: webCrypto, now: NOW,
  defaults: { v: 1, operator: { relay: 'wss://relay.example', blossom: 'https://blossom.example', api: 'https://api.example' }, relays: [], mirrors: [] },
  pairing: { v: 1, user_pubkey: user.pubkey(), write_relays: [], blossom_servers: [], token: 'ab'.repeat(32), label: 'Chrome on a Mac', paired_at: NOW },
};

describe("a page's canonical link is kept only from its own site (contract 4.3, ruling 11)", () => {
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

  test('a canonical the page wrote with a user name and password goes to the phone without them', () => {
    const c = captured('https://amp.news.example/2026/10/story', 'https://user:hunter2@news.example/2026/10/story');
    expect(c.canonical).toBe(story);
  });
});

describe('a canonical longer than the phone keeps is left out (CANONICAL_MAX)', () => {
  const amp = 'https://amp.news.example/2026/10/story';
  /** The story's address, n characters long. */
  const storyOf = (n: number) => `${story}?q=${'x'.repeat(n - story.length - 3)}`;

  test('past 2,048 characters, as the phone leaves out its own parse’s and a browser’s; one of 2,048 is kept', () => {
    expect(storyOf(CANONICAL_MAX + 1)).toHaveLength(2_049);
    expect(captured(amp, storyOf(CANONICAL_MAX + 1)).canonical).toBeNull();
    expect(captured(amp, storyOf(CANONICAL_MAX)).canonical).toBe(storyOf(CANONICAL_MAX));
  });

  test('measured as the parse read it, before a user name and password come out, as the phone’s own parse measures it', () => {
    const c = captured(amp, `https://reader:${'p'.repeat(CANONICAL_MAX)}@news.example/2026/10/story`);
    expect(c.canonical).toBeNull();
    // the save is the page's own, as the same page shared from the phone is
    expect(itemHash(c.url, c.canonical)).toBe(itemHash(amp));
  });

  test("so the wrap keeps the page's details: one of 2,500 took the title, site, byline, language and picture with it", async () => {
    const hero = `https://cdn.example/${'h'.repeat(500)}.jpg`;
    const c = captured(amp, storyOf(2_500), { site: 'News', byline: 'A writer', lang: 'en', hero });
    const { pending } = await prepare(c, ctx);
    const req = JSON.parse((await unwrap(user, pending.wrap)).rumor.content) as SaveRequest;
    expect(req).toMatchObject({ url: amp, canonical: null, title: 'A story', site: 'News', byline: 'A writer', lang: 'en', hero });
    expect(req.html).not.toBeNull();
    expect(pending.hash).toBe(itemHash(amp));
  });
});

describe("a capture's fields are cut to the phone's limits before the wrap (FIELD_MAX, decision 119)", () => {
  const amp = 'https://amp.news.example/2026/10/story';
  const hero = 'https://cdn.example/h.jpg';
  /** The request as the phone reads it from the wrap. */
  const sent = async (details: Partial<Parsed>) => JSON.parse((await unwrap(user, (await prepare(captured(amp, story, details), ctx)).pending.wrap)).rumor.content) as SaveRequest;

  test('a 1,000-character title arrives cut to 300, with the picture, byline, site, language and text intact', async () => {
    const req = await sent({ title: 'T'.repeat(1_000), site: 'News', byline: 'A writer', lang: 'en', hero });
    expect(req.title).toBe('T'.repeat(FIELD_MAX.title));
    expect(req).toMatchObject({ url: amp, canonical: story, site: 'News', byline: 'A writer', lang: 'en', hero });
    expect(req.html).not.toBeNull();
  });

  test('a byline and a site are cut at theirs; a language tag or a picture address past its length is left out', async () => {
    const req = await sent({ title: 'A story', site: 's'.repeat(101), byline: 'b'.repeat(201), lang: 'x'.repeat(36), hero: `https://cdn.example/${'h'.repeat(FIELD_MAX.hero)}.jpg` });
    expect(req).toMatchObject({ title: 'A story', site: 's'.repeat(FIELD_MAX.site), byline: 'b'.repeat(FIELD_MAX.byline), lang: null, hero: null });
    const kept = await sent({ title: 'A story', lang: 'x'.repeat(FIELD_MAX.lang), hero: `https://cdn.example/${'h'.repeat(FIELD_MAX.hero - 24)}.jpg` });
    expect(kept.lang).toHaveLength(FIELD_MAX.lang);
    expect(kept.hero).toHaveLength(FIELD_MAX.hero);
  });

  test('a cut never lands inside a surrogate pair, and trailing spaces go with the cut, as the phone cuts', () => {
    const title = `${'t'.repeat(FIELD_MAX.title - 5)}    😀`;
    expect(fitted({ ...linkOnly(amp), title }).title).toBe('t'.repeat(FIELD_MAX.title - 5));
    const pair = `${'t'.repeat(FIELD_MAX.title - 1)}😀`;
    expect(fitted({ ...linkOnly(amp), title: pair }).title).toBe('t'.repeat(FIELD_MAX.title - 1));
    expect(fitted({ ...linkOnly(amp), title: ' '.repeat(FIELD_MAX.title + 1) }).title).toBeNull();
    expect(fitted(linkOnly(amp))).toEqual(linkOnly(amp));
  });
});

describe('what a capture keeps of the parse (fromParse)', () => {
  const amp = 'https://amp.news.example/2026/10/story';
  const hero = 'https://cdn.example/h.jpg';

  test('what the parse found, and its canonical as the phone keeps one', () => {
    const parsed: Parsed = { ok: true, title: 'A story', byline: 'A writer', site: 'News', lang: 'en', hero, canonical: story };
    expect(fromParse(amp, parsed, 'A page', '<p>x</p>')).toEqual({ url: amp, canonical: story, hero, title: 'A story', site: 'News', byline: 'A writer', lang: 'en', html: '<p>x</p>' });
    expect(fromParse(amp, { ...parsed, canonical: `${story}?q=${'x'.repeat(CANONICAL_MAX)}` }, 'A page', null).canonical).toBeNull();
    expect(fromParse(amp, { ...parsed, canonical: 'https://evil.example/2026/10/story' }, 'A page', null).canonical).toBeNull();
  });

  test('a page the parse couldn’t read keeps its canonical, picture and own title, and nothing it didn’t find', () => {
    expect(fromParse(amp, { ok: false, canonical: story, hero }, '  A page \n', null))
      .toEqual({ url: amp, canonical: story, hero, title: 'A page', site: null, byline: null, lang: null, html: null });
    expect(fromParse(amp, { ok: true, title: null }, '   ', null)).toEqual(linkOnly(amp));
  });
});

describe('a page at an address no save request could carry (ADDRESS_UNWRAPPABLE, F39)', () => {
  test('isn’t read: its address and title go to the background, which refuses the save at once', async () => {
    const href = `https://news.example/2026/10/story?q=${'x'.repeat(ADDRESS_UNWRAPPABLE)}`;
    const c = captured(href, story);
    // read, it was 'A story', with its canonical and its text: the whole page through the parser for a save then refused
    expect(c).toEqual(unread(pageUrl(href), 'A page'));
    await expect(prepare(c, ctx)).rejects.toBeInstanceOf(AddressTooLongError);
  });

  test('one a character shorter is read as any page is', () => {
    const href = `https://news.example/?q=${'x'.repeat(ADDRESS_UNWRAPPABLE - 25)}`;
    expect(href).toHaveLength(ADDRESS_UNWRAPPABLE - 1);
    expect(captured(href, story)).toMatchObject({ title: 'A story', canonical: story, html: '<p>a few words</p>' });
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
