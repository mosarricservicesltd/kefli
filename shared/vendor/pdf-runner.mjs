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
/**
 * The most text runs, and characters in them, a file gives before it is too long to keep (packages/protocol's caller,
 * page.ts, holds the same): 2,500 runs a page over the 400 pages, as a file setting a glyph at a time gives, and twice
 * the most text a save keeps. Runs are read as pdf.js streams them, so a page of millions stops at the line rather
 * than being built whole in the WebView's memory, and handed over the bridge.
 */
export const PDF_MAX_RUNS = 1_000_000;
export const PDF_MAX_CHARS = 10_000_000;
/** A title or author longer than this is no title: left out, as an empty one is. */
const META_MAX = 4096;

const r2 = (n) => Math.round(n * 100) / 100;

function orNull(s) {
  return typeof s === 'string' && s.trim() !== '' && s.length <= META_MAX ? s.trim() : null;
}

/** A page's runs, counted into budget as they come; null once the budget is spent, the rest of the page unread. */
async function pageRuns(pdfjs, page, budget) {
  const viewport = page.getViewport({ scale: 1 });
  const reader = page.streamTextContent().getReader();
  const runs = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    for (const item of value.items) {
      if (typeof item.str !== 'string' || item.str === '') continue;
      budget.runs += 1;
      budget.chars += item.str.length;
      if (budget.runs > PDF_MAX_RUNS || budget.chars > PDF_MAX_CHARS) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      const t = pdfjs.Util.transform(viewport.transform, item.transform);
      const size = Math.hypot(t[2], t[3]);
      const angle = Math.round((Math.atan2(t[1], t[0]) * 180) / Math.PI);
      runs.push([item.str, r2(t[4]), r2(t[5]), r2(size), r2(item.width), angle]);
    }
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
    const budget = { runs: 0, chars: 0 };
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const read = await pageRuns(pdfjs, page, budget);
      page.cleanup();
      if (!read) return { ok: false, reason: 'pdf_too_long' };
      pages.push(read);
    }
    return { ok: true, title: orNull(info.Title), author: orNull(info.Author), pages };
  } catch (e) {
    return { ok: false, reason: 'error', message: String(e && e.message ? e.message : e) };
  } finally {
    doc.destroy();
  }
}
