import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchPage, isPdf, PDF_MAX_BYTES, type PagePorts } from '../src/services/page';
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
});
