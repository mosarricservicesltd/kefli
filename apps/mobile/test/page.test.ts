import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { base64 } from '@scure/base';
import { buildItemEvent, itemHash, LocalSigner, parseItem, type PdfRuns } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import * as blocks from '../src/reader/blocks';
import { FIELD_MAX, fetchPage, isPdf, parsedOutcome, PDF_MAX_BYTES, PDF_MAX_RUNS, renderAnswer, TEXT_MAX_BYTES, toBase64, type PagePorts, type ParserResult } from '../src/services/page';
import { failNotice } from '../src/screens/failNotice';
import { S } from '../src/ui/strings';


const PDFS = join(__dirname, '..', '..', '..', 'shared', 'fixtures', 'pdfs');
const runs = (id: string) => JSON.parse(readFileSync(join(PDFS, `${id}.runs.json`), 'utf8'));
const expected = (id: string) => (JSON.parse(readFileSync(join(PDFS, 'expected.json'), 'utf8')) as { pdfs: { id: string; markdown?: string; title?: string; words?: number }[] }).pdfs.find((p) => p.id === id)!;

const PDF_BYTES = new TextEncoder().encode('%PDF-1.7\n…');

function ports(body: Uint8Array<ArrayBuffer>, headers: Record<string, string>, read: ReturnType<typeof runs>) {
  const calls = { pdf: 0, parse: 0 };
  const p: PagePorts = {
    fetch: (async () => new Response(body, { status: 200, headers })) as unknown as typeof fetch,
    parse: async () => {
      calls.parse++;
      return { ok: false, reason: 'not_readable' };
    },
    pdf: async () => {
      calls.pdf++;
      return read;
    },
  };
  return { p, calls };
}

describe('a linked PDF (contract 4.2, flow decision 103)', () => {
  test('its runs are laid out as the fixture expects, with its title', async () => {
    const { p, calls } = ports(PDF_BYTES, { 'content-type': 'application/pdf' }, runs('report-one-column'));
    const o = await fetchPage(p, 'https://example.gov.uk/report.pdf');
    expect(calls).toEqual({ pdf: 1, parse: 0 });
    if (o.kind !== 'parsed') throw new Error(o.kind);
    const want = expected('report-one-column');
    expect(o.result).toMatchObject({ ok: true, title: want.title, markdown: want.markdown, site: null, hero: null });
    expect(o.words).toBe(want.words);
  });

  test('one served as application/octet-stream is known by its first bytes', async () => {
    const { p, calls } = ports(PDF_BYTES, { 'content-type': 'application/octet-stream' }, runs('slides-landscape'));
    expect((await fetchPage(p, 'https://example.com/download?id=7')).kind).toBe('parsed');
    expect(calls.pdf).toBe(1);
  });

  test('a scan has no text, and a locked file says so', async () => {
    const scan = ports(PDF_BYTES, { 'content-type': 'application/pdf' }, runs('scan-image-only'));
    expect(await fetchPage(scan.p, 'https://example.com/scan.pdf')).toMatchObject({ kind: 'failed', reason: 'pdf_no_text' });
    const locked = ports(PDF_BYTES, { 'content-type': 'application/pdf' }, { ok: false, reason: 'pdf_locked' });
    expect(await fetchPage(locked.p, 'https://example.com/locked.pdf')).toMatchObject({ kind: 'failed', reason: 'pdf_locked' });
    const broken = ports(PDF_BYTES, { 'content-type': 'application/pdf' }, { ok: false, reason: 'error' });
    expect(await fetchPage(broken.p, 'https://example.com/broken.pdf')).toMatchObject({ kind: 'failed', reason: 'not_readable' });
  });

  test('the cap is the PDF one, by the declared length', async () => {
    const big = ports(PDF_BYTES, { 'content-type': 'application/pdf', 'content-length': String(PDF_MAX_BYTES + 1) }, runs('report-one-column'));
    expect(await fetchPage(big.p, 'https://example.com/huge.pdf')).toMatchObject({ kind: 'failed', reason: 'too_large' });
    const fine = ports(PDF_BYTES, { 'content-type': 'application/pdf', 'content-length': String(6 * 1024 * 1024) }, runs('report-one-column'));
    expect((await fetchPage(fine.p, 'https://example.com/six-mb.pdf')).kind).toBe('parsed');
  });

  test('a picture or a film over a page’s 5 MB fails on its declared length, unread; a download may still be a PDF', async () => {
    const six = String(6 * 1024 * 1024);
    for (const type of ['video/mp4', 'image/jpeg', 'application/zip']) {
      // an empty body: read, it would be refused as not_html; too_large is the declared length, before any reading
      const { p } = ports(new Uint8Array(0), { 'content-type': type, 'content-length': six }, runs('report-one-column'));
      expect(await fetchPage(p, 'https://example.com/film')).toMatchObject({ kind: 'failed', reason: 'too_large' });
    }
    for (const type of ['application/octet-stream', 'binary/octet-stream', 'application/force-download']) {
      const { p } = ports(PDF_BYTES, { 'content-type': type, 'content-length': six }, runs('report-one-column'));
      expect((await fetchPage(p, 'https://example.com/report')).kind).toBe('parsed');
    }
  });

  test('without the pdf port, a PDF is still not a page', async () => {
    const { p } = ports(PDF_BYTES, { 'content-type': 'application/pdf' }, runs('report-one-column'));
    delete p.pdf;
    expect(await fetchPage(p, 'https://example.com/a.pdf')).toMatchObject({ kind: 'failed', reason: 'not_html' });
  });

  test('a page is still parsed as a page', async () => {
    const { p, calls } = ports(new TextEncoder().encode('<html><body>hi</body></html>'), { 'content-type': 'text/html' }, runs('report-one-column'));
    await fetchPage(p, 'https://example.com/');
    expect(calls).toEqual({ pdf: 0, parse: 1 });
  });

  test('isPdf reads the type, then the bytes', () => {
    expect(isPdf('application/pdf; qs=0.001', new Uint8Array())).toBe(true);
    expect(isPdf('application/x-pdf', new Uint8Array())).toBe(true);
    expect(isPdf('binary/octet-stream', PDF_BYTES)).toBe(true);
    expect(isPdf('text/html', new TextEncoder().encode('<!doctype html>'))).toBe(false);
  });

  test('the Original screen names what kind of PDF it was', () => {
    expect(failNotice('pdf_no_text')).toBe(S.reader.pdfNoText);
    expect(failNotice('pdf_locked')).toBe(S.reader.pdfLocked);
    expect(failNotice('not_readable')).toBe(S.reader.errorNotice);
    expect(failNotice(null)).toBe(S.reader.errorNotice);
  });

  test('a PDF after a byte order mark or a blank line, served as a download, is known by its header', () => {
    const late = new TextEncoder().encode('﻿\r\n%PDF-1.4\n…');
    expect(isPdf('application/octet-stream', late)).toBe(true);
    expect(isPdf('', late)).toBe(true);
    // further in than a reader looks, it is not
    expect(isPdf('application/octet-stream', new TextEncoder().encode(' '.repeat(1100) + '%PDF-1.4'))).toBe(false);
    // a page that mentions one near its top is still a page
    expect(isPdf('text/html', new TextEncoder().encode('<title>%PDF-1.7 explained</title>'))).toBe(false);
  });
});

const HTML = (s: string) => new Response(new TextEncoder().encode(s), { status: 200, headers: { 'content-type': 'text/html' } });
const ARTICLE = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of an article worth keeping, long enough to read.`).join('\n\n') + '\n';
const parsed = (over: Partial<Extract<ParserResult, { ok: true }>> = {}): ParserResult => ({
  ok: true, title: 'A title', byline: null, site: null, lang: 'en', hero: null, canonical: null, readerable: true, markdown: ARTICLE, ...over,
});
/** Page ports whose fetch answers a page and whose parse gives result, counting parses. */
function parsing(result: ParserResult | (() => ParserResult), res: () => Response = () => HTML('<p>x</p>')) {
  const p: PagePorts = { fetch: (async () => res()) as unknown as typeof fetch, parse: async () => (typeof result === 'function' ? result() : result) };
  return p;
}

describe('what a page hands back is taken only as far as a save can hold it', () => {
  test('Markdown past the most text a save keeps fails as too large, before it is derived', async () => {
    const derive = jest.spyOn(blocks, 'deriveArticle');
    // a page's Markdown can outgrow its HTML: 500 nested lists indent every line in them
    expect(await fetchPage(parsing(parsed({ markdown: 'x'.repeat(TEXT_MAX_BYTES + 1) })), 'https://e.com/a')).toMatchObject({ kind: 'failed', reason: 'too_large' });
    // counted as UTF-8: two bytes a character here
    expect(await fetchPage(parsing(parsed({ markdown: 'é'.repeat(TEXT_MAX_BYTES / 2 + 1) })), 'https://e.com/b')).toMatchObject({ kind: 'failed', reason: 'too_large' });
    expect(derive).not.toHaveBeenCalled();
    derive.mockRestore();
  });

  test('a long real article is kept', async () => {
    const long = Array.from({ length: 6000 }, (_, i) => `Paragraph ${i}: ${'a sentence of a long and real report. '.repeat(4)}`).join('\n\n') + '\n';
    expect(long.length).toBeGreaterThan(900_000);
    const o = await fetchPage(parsing(parsed({ markdown: long })), 'https://e.com/long');
    expect(o).toMatchObject({ kind: 'parsed', words: 6000 * 34 });
  });

  test('a derivation that throws is a page that could not be read, never a throw', async () => {
    const derive = jest.spyOn(blocks, 'deriveArticle').mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    try {
      expect(await fetchPage(parsing(parsed()), 'https://e.com/deep')).toEqual({ kind: 'failed', reason: 'not_readable', finalUrl: 'https://e.com/deep' });
    } finally {
      derive.mockRestore();
    }
  });

  test('a parse refused for its size by the parser says too large', async () => {
    expect(await fetchPage(parsing({ ok: false, reason: 'too_large' }), 'https://e.com/a')).toMatchObject({ kind: 'failed', reason: 'too_large' });
  });

  test('absurd fields are fitted, so the save fits its 16 KB event', async () => {
    const url = 'https://news.example/' + 'p'.repeat(FIELD_MAX.url - 30);
    const hostile = parsed({
      title: 'T'.repeat(10_000), byline: 'B'.repeat(5_000), site: 'S'.repeat(5_000), lang: 'l'.repeat(10_000),
      hero: 'https://e.com/' + 'i'.repeat(5_000), canonical: 'https://e.com/' + 'c'.repeat(5_000),
    });
    const o = await fetchPage(parsing(hostile), url);
    if (o.kind !== 'parsed') throw new Error(o.kind);
    const r = o.result;
    expect([r.title?.length, r.byline?.length, r.site?.length, r.lang, r.hero, r.canonical]).toEqual([FIELD_MAX.title, FIELD_MAX.byline, FIELD_MAX.site, null, null, null]);
    // the item as the outbox writes it, at the longest address kept, signs under the ceiling
    const item = parseItem(JSON.stringify({
      v: 1, url, canonical: r.canonical, title: r.title, site: r.site, byline: r.byline, saved_at: 1_760_000_000, state: 'unread', progress: 0,
      words: o.words, lang: r.lang, text: { sha256: 'ab'.repeat(32), key: 'k'.repeat(44), nonce: 'n'.repeat(16), servers: ['https://blossom.kefli.app', 'https://mirror.example.net'] },
      text_hash: 'cd'.repeat(32), hero: r.hero, source_kind: 'web', audio_pref: null,
    }));
    const signer = new LocalSigner(nodeCrypto.randomBytes(32));
    await expect(buildItemEvent(signer, 'ef'.repeat(32), item, 1_760_000_000, nodeCrypto.randomBytes(32))).resolves.toBeDefined();
  });

  test('a title cut at the most kept never splits a pair of surrogates', async () => {
    const o = await fetchPage(parsing(parsed({ title: 'a'.repeat(FIELD_MAX.title - 1) + '😀'.repeat(10) })), 'https://e.com/t');
    if (o.kind !== 'parsed') throw new Error(o.kind);
    expect(o.result.title).toBe('a'.repeat(FIELD_MAX.title - 1));
  });

  test('a parse whose renderer the system killed waits, as a page that timed out does; a crash is a page not read', async () => {
    expect(await fetchPage(parsing({ ok: false, reason: 'renderer_gone' }), 'https://e.com/a')).toEqual({ kind: 'offline', timedOut: true });
    expect(await fetchPage(parsing({ ok: false, reason: 'error' }), 'https://e.com/a')).toMatchObject({ kind: 'failed', reason: 'not_readable' });
  });

  test('a rendered page too large to hand over fails as too large', async () => {
    const turnedAway = () => new Response('', { status: 403 });
    const p: PagePorts = { ...parsing(parsed(), turnedAway), render: async (url) => ({ url, tooLarge: true }) };
    expect(await fetchPage(p, 'https://cf.example/a')).toMatchObject({ kind: 'failed', reason: 'too_large' });
    expect(renderAnswer({ ok: false, reason: 'too_large', url: 'https://cf.example/a' })).toEqual({ url: 'https://cf.example/a', tooLarge: true });
    expect(renderAnswer({ ok: false, reason: 'timeout' })).toBeNull();
    expect(renderAnswer({ ok: true, url: 'https://cf.example/a', html: '<p>x</p>' })).toEqual({ url: 'https://cf.example/a', html: '<p>x</p>' });
  });

  test('a compressed page that inflates far past the cap is refused as it inflates, from a real server', async () => {
    // 16 KB of gzip that inflates to 16 MB: the cap counts the bytes the fetch hands over, after inflating (Node's
    // fetch here, OkHttp's gzip on the phone, both a stream)
    const bomb = gzipSync(Buffer.concat([Buffer.from('<!doctype html><p>'), Buffer.alloc(16 * 1024 * 1024, 0x20)]), { level: 9 });
    expect(bomb.length).toBeLessThan(40_000);
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(bomb);
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bomb`;
      expect(await fetchPage({ fetch, parse: async () => parsed() }, url)).toMatchObject({ kind: 'failed', reason: 'too_large' });
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  }, 30_000);

  test("the phone's own files are never fetched, under file: or expo/fetch's stand-in for it", async () => {
    let asked = 0;
    const p: PagePorts = { fetch: (async () => (asked++, HTML('<p>x</p>'))) as unknown as typeof fetch, parse: async () => parsed() };
    for (const url of ['file:///data/user/0/app.kefli/files/a.html', 'http://filesystem.local/data/user/0/app.kefli/files/a.html', 'HTTP://FileSystem.Local/sdcard/x.html', 'content://media/x', 'javascript:alert(1)']) {
      expect(await fetchPage(p, url)).toEqual({ kind: 'failed', reason: 'http', finalUrl: url });
    }
    expect(asked).toBe(0);
    // a real site's address that merely contains the words is fetched as any other
    expect((await fetchPage(p, 'https://filesystem.local.example.com/x')).kind).toBe('parsed');
    expect((await fetchPage(p, 'https://example.com/http://filesystem.local/')).kind).toBe('parsed');
  });

  test('a redirect to an address past the longest kept leaves the save at the address asked for', async () => {
    const res = () => {
      const r = HTML('<p>x</p>');
      Object.defineProperty(r, 'url', { value: 'https://e.com/' + 'r'.repeat(70_000) });
      return r;
    };
    expect(await fetchPage(parsing(parsed(), res), 'https://e.com/asked')).toMatchObject({ kind: 'parsed', finalUrl: 'https://e.com/asked' });
  });
});

describe("a page's canonical link is kept only from its own site (contract 4.3, ruling 11)", () => {
  const story = 'https://news.example/2026/10/story';
  /** A page answered at landed, after any redirect, whose parse names canonical. */
  const naming = (canonical: string, landed?: string) => parsing(parsed({ canonical }), () => {
    const r = HTML('<p>x</p>');
    if (landed) Object.defineProperty(r, 'url', { value: landed });
    return r;
  });

  test("a page at an amp. host naming another site's address keeps its own, as its save's hash does", async () => {
    const o = await fetchPage(naming(story), 'https://amp.evil.example/2026/10/story');
    if (o.kind !== 'parsed') throw new Error(o.kind);
    expect(o.result.canonical).toBeNull();
    expect(itemHash(o.finalUrl, o.result.canonical)).toBe(itemHash('https://amp.evil.example/2026/10/story'));
  });

  test('so does one a short link redirected to, and an ordinary page naming another site', async () => {
    const landed = await fetchPage(naming(story, 'https://m.evil.example/2026/10/story'), 'https://short.example/x');
    expect(landed).toMatchObject({ kind: 'parsed', finalUrl: 'https://m.evil.example/2026/10/story', result: { canonical: null } });
    expect(await fetchPage(naming('https://news.example/a'), 'https://syndicated.example/a')).toMatchObject({ result: { canonical: null } });
  });

  test("the site's own AMP page keeps its canonical, and joins the story's save", async () => {
    const o = await fetchPage(naming(story), 'https://amp.news.example/2026/10/story');
    if (o.kind !== 'parsed') throw new Error(o.kind);
    expect(o.result.canonical).toBe(story);
    expect(itemHash(o.finalUrl, o.result.canonical)).toBe(itemHash(story));
  });

  test("a browser's own HTML, taken as a parse, keeps a canonical only from the page's site too", () => {
    const o = parsedOutcome({ ...(parsed() as Extract<ParserResult, { ok: true }>), canonical: story }, 'https://amp.evil.example/2026/10/story');
    expect(o).toMatchObject({ kind: 'parsed', result: { canonical: null } });
  });
});

describe('a PDF is handed over and read only as far as a save can hold it', () => {
  const pdfPorts = (read: ({ ok: true } & PdfRuns) | { ok: false; reason: string }, seen: { body?: string } = {}): PagePorts => ({
    fetch: (async () => new Response(PDF_BYTES, { status: 200, headers: { 'content-type': 'application/pdf' } })) as unknown as typeof fetch,
    parse: async () => ({ ok: false, reason: 'not_readable' }),
    pdf: async (b) => {
      seen.body = b;
      return read;
    },
  });

  test('base64 for the WebView is the standard one, in linear time and memory for a 20 MB file', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = nodeCrypto.randomBytes(n);
      expect(toBase64(bytes)).toBe(base64.encode(bytes));
    }
    const odd = nodeCrypto.randomBytes(3 * 2048 * 3 + 2);
    expect(toBase64(odd)).toBe(Buffer.from(odd).toString('base64'));
    // @scure/base without a built-in toBase64, as on Hermes, took 15 s and 1.4 GB in Node for this
    const big = new Uint8Array(20 * 1024 * 1024).map((_, i) => (i * 2654435761) >>> 24);
    const started = Date.now();
    const s = toBase64(big);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(s).toBe(Buffer.from(big).toString('base64'));
  });

  test('more runs than a save can hold fail as too large, before any layout', async () => {
    const layout = jest.spyOn(blocks, 'deriveArticle');
    const page = { w: 595, h: 842, runs: Array.from({ length: PDF_MAX_RUNS + 1 }, () => ['a', 72, 100, 10, 5, 0] as [string, number, number, number, number, number]) };
    expect(await fetchPage(pdfPorts({ ok: true, title: null, author: null, pages: [page] }), 'https://e.com/glyphs.pdf')).toMatchObject({ kind: 'failed', reason: 'too_large' });
    expect(layout).not.toHaveBeenCalled();
    layout.mockRestore();
  });

  test('text normalisation refuses (a run of stacked marks) is a PDF that could not be read', async () => {
    // prose enough that the layout keeps the block, with one letter carrying 400 marks in it
    const prose = 'Saved articles are read on the train and kept for later. '.repeat(20);
    const zalgo = { w: 595, h: 842, runs: [[prose + 'a' + '̖́'.repeat(200) + ' ' + prose, 72, 100, 10, 400, 0] as [string, number, number, number, number, number]] };
    expect(await fetchPage(pdfPorts({ ok: true, title: null, author: null, pages: [zalgo] }), 'https://e.com/z.pdf')).toMatchObject({ kind: 'failed', reason: 'not_readable' });
  });

  test('a PDF read whose renderer the system killed waits; one the parser stopped for its size is too large', async () => {
    expect(await fetchPage(pdfPorts({ ok: false, reason: 'renderer_gone' }), 'https://e.com/a.pdf')).toEqual({ kind: 'offline', timedOut: true });
    expect(await fetchPage(pdfPorts({ ok: false, reason: 'pdf_too_long' }), 'https://e.com/a.pdf')).toMatchObject({ kind: 'failed', reason: 'too_large' });
    expect(await fetchPage(pdfPorts({ ok: false, reason: 'too_large' }), 'https://e.com/a.pdf')).toMatchObject({ kind: 'failed', reason: 'too_large' });
  });

  test('a PDF whose own title and author run on has them fitted', async () => {
    const r = runs('report-one-column');
    const o = await fetchPage(pdfPorts({ ...r, title: 'T'.repeat(5_000_000), author: 'A'.repeat(5_000_000) }), 'https://e.com/r.pdf');
    if (o.kind !== 'parsed') throw new Error(o.kind);
    expect([o.result.title?.length, o.result.byline?.length]).toEqual([FIELD_MAX.title, FIELD_MAX.byline]);
  });
});
