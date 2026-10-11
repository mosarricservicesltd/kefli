// A PDF's text runs, with where each sits on its page (contract 4.2, PDFs): what the vendored pdf.js reads from
// the document, before any layout. The phone's parser WebView and the fixture builder both run this file, on the
// same pdf.js, so the runs match; packages/protocol's pdfMarkdown turns them into Markdown on Hermes.
//
//   pdfRuns(pdfjs, bytes)  the module namespace of pdf.min.mjs (with globalThis.pdfjsWorker set to the worker's,
//                          so it parses on this thread) and the file's bytes, to
//                          {ok: true, title, author, pages: [{w, h, runs: [[text, x, y, size, width, angle], ...]}]}
//                          or {ok: false, reason: 'pdf_locked' | 'pdf_too_long' | 'error', message?}
//
// Coordinates are the page's viewport at scale 1 with its /Rotate applied: x right and y down from the top left,
// y at the baseline, in points, rounded to hundredths so the output is the same wherever it runs.

export const PDF_MAX_PAGES = 400;

const r2 = (n) => Math.round(n * 100) / 100;

function orNull(s) {
  return typeof s === 'string' && s.trim() !== '' ? s.trim() : null;
}

async function pageRuns(pdfjs, page) {
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const runs = [];
  for (const item of content.items) {
    if (typeof item.str !== 'string' || item.str === '') continue;
    const t = pdfjs.Util.transform(viewport.transform, item.transform);
    const size = Math.hypot(t[2], t[3]);
    const angle = Math.round((Math.atan2(t[1], t[0]) * 180) / Math.PI);
    runs.push([item.str, r2(t[4]), r2(t[5]), r2(size), r2(item.width), angle]);
  }
  return { w: r2(viewport.width), h: r2(viewport.height), runs };
}

export async function pdfRuns(pdfjs, bytes) {
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0 }).promise;
  } catch (e) {
    if (e && e.name === 'PasswordException') return { ok: false, reason: 'pdf_locked' };
    return { ok: false, reason: 'error', message: String(e && e.message ? e.message : e) };
  }
  try {
    if (doc.numPages > PDF_MAX_PAGES) return { ok: false, reason: 'pdf_too_long' };
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta && meta.info) || {};
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      pages.push(await pageRuns(pdfjs, page));
      page.cleanup();
    }
    return { ok: true, title: orNull(info.Title), author: orNull(info.Author), pages };
  } catch (e) {
    return { ok: false, reason: 'error', message: String(e && e.message ? e.message : e) };
  } finally {
    doc.destroy();
  }
}
