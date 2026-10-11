# Citation markers in speech, and text from linked PDFs

Exploration, 11 October 2026. Two features Richard asked to look at: stop the voice reading Wikipedia's `[1]` markers, and give a saved PDF link its text. Both were then built the same day as recommended here (flow decisions 102 and 103, contract 1.6); the PDF layout grew rules beyond this note's (maths, chart labels, section numbers), which `packages/protocol/src/pdf.ts` and its fixtures record.

## 1. Citation markers and reference lists

### What happens now

Readability keeps Wikipedia's `<sup class="reference">` links and Turndown writes them as ordinary links, `[\[1\]](https://en.wikipedia.org/wiki/Bookmark_\(digital\)#cite_note-1)`. The spoken projection (contract 4.2, `packages/protocol/src/projection.ts`) keeps link text, so the voice says "First Browser War, bracket one, bracket". The English fixture has 15 of them, Simple English 47, Greek 52, Japanese 23 (as `[原 1]`).

The bigger cost is at the end. The reference list survives the parse, each entry starting with a `↑` link to `#cite_ref-…`, and the voice reads every one ("Archived from the original on August 3, 2017. Retrieved July 3, 2009."). Across the fixtures that is roughly:

| Fixture | Spoken words | Inline markers | Reference entries | Share of words in references |
|---|---|---|---|---|
| wikipedia-simple | 2,035 | 47 | 43 | about 38% |
| wikipedia-el | 7,009 | 52 | 47 | about 22% |
| wikipedia-fr | 448 | 3 | 3 | about 11% |
| wikipedia-en | 1,289 | 15 | 14 | about 26% |
| wikipedia-de | 429 | 5 | 4 | about 12% |

(Counted from `shared/fixtures/expected.json` with a regex, so approximate.)

### Why the rule has to look at the link target

A rule on the text alone ("drop anything in square brackets") breaks real content. The Greek article writes its IPA in brackets, `[eliniˈka]`, `[/b/]`, and those link to a help page. The citation markers in every language link to the same page's `#cite_note-…` fragment, and the reference entries' back-links to `#cite_ref-…`. That target is the reliable signal, and it is MediaWiki's, so it covers every Wikipedia language, Wikisource, Fandom and any other MediaWiki site.

### Where the change goes: the spoken projection

Two places could drop them.

- **In the parse** (a Turndown rule or a DOM pass before Readability). The reader would lose the markers too, `text_hash` changes for every Wikipedia save, the twenty page fixtures regenerate, and saves already made keep their markers.
- **In the spoken projection** (recommended). The stored Markdown stays as parsed, so `text_hash`, the blob and the extension are untouched, and every save already in a library is read cleanly the next time its derived data is rebuilt (`DERIVED_VERSION` in `apps/mobile/src/services/textFiles.ts` already handles that). The reader still shows the markers, which is right for reading: they are how you check a claim.

The proposed rule, for contract 4.2:

1. A link whose target's fragment starts with `cite_note-` is not spoken (the inline markers).
2. A list item whose first child is a link whose fragment starts with `cite_ref-` is not spoken, nor is anything nested in it (the reference list).
3. A link to `Wikipedia:Citation_needed` is not spoken. Other languages have their own page names for it; none appears in the fixtures, so the list starts with English and grows from a live sample.

Optional, worth deciding now: generic footnotes outside Wikipedia. Substack, Ghost and WordPress footnote plugins write a bare number linking to `#footnote-1`, `#fn1` or `#fnref1`, which after Turndown reads as "word1". A fourth rule, "a link whose whole text is one to three digits and whose fragment starts with `fn`, `footnote` or `note`", would catch most of them. It wants a couple of fixtures before it goes in.

### What it costs

- `words` is counted from the projection, so it falls for any affected save. Synced items keep their old `words` until they are next republished, and `progress` is a fraction of `words`, so a Wikipedia article reopened on a second phone could land a few per cent early until then. Republishing `words` with the next progress write closes that. Worth one line in the contract.
- The page fixtures' `spoken` and `words` regenerate; `markdown` and `text_hash` don't.
- Contract bump (4.2 and a changelog entry), with the rule mirrored in `projection.ts`. The extension only uses the projection for the guard's 120-word count, so a Wikipedia article can't newly fail it.
- No new screens. The flow map needs only a note on the Listen behaviour.

Effort: about a day including fixtures and tests.

## 2. Text from a linked PDF

### What happens now

`refusal()` in `apps/mobile/src/services/page.ts` turns away anything that isn't `text/html` or `application/xhtml+xml` as `not_html`, so a PDF link saves with `text` null and opens the original. The old Android spec's honest-failure copy was "This is a PDF", which v1 does not parse. The extension saves a PDF open in the browser's viewer as URL-only (flow decisions 59 and 100), so the phone does the fetch either way.

### Trying it

pdf.js (`pdfjs-dist`, Mozilla, Apache-2.0) extracts the text layer, with positions and font sizes, and runs in a browser engine, so it can sit in the same hidden WebView as the parser. I ran a rough extractor (lines by baseline, paragraphs by vertical gap, headings by font size, running headers and page numbers dropped, end-of-line hyphens joined) on two documents:

- **Bitcoin whitepaper** (9 pages, one column). Clean: title, author, abstract and numbered sections, paragraphs joined correctly, 3,500 words. Ready to read aloud as it came out.
- **"Attention Is All You Need"** (arXiv, 15 pages, maths and tables). The prose is good. Around it: arXiv's rotated margin stamp and the licence note came out as headings, the author grid ran together ("Ashish VaswaniNoam Shazeer…"), equations became "T QK Attention(Q, K, V ) = softmax( √)V (1) dk", Table 2 became a run of numbers, and a figure's labels ended the article as word salad.

So reports, essays, whitepapers and policy papers work well; academic papers are listenable in the body and noisy at the edges.

### Recommended approach

On the phone, in the parser WebView, with pdf.js vendored and pinned beside Readability in `shared/vendor/` (`VERSIONS.md`). The server never sees the document, which keeps the privacy story intact; a server-side extractor would not.

1. **Fetch.** Accept `application/pdf` (and a `.pdf` address served as `application/octet-stream`). Raise the cap for PDFs only; 5 MB is too small for many reports. 25 MB seems right, with a separate timeout.
2. **Extract** to Markdown: headings from font size, paragraphs from gaps, running headers and footers removed (same text at the same height on half the pages or more), lone page numbers removed, hyphens joined. Title from the document's metadata, else its largest text on page one; byline from metadata Author. No hero; the Fingerprint cover covers it.
3. **Leave out what can't be spoken**: lines that are mostly digits or symbols, very short lines in a row (table cells, figure labels), and text rotated off the page's axis (pdf.js gives the transform). This is where most of the arXiv noise goes.
4. **The same pipeline after that**: normalise, `text_hash`, encrypted blob, mirrored. The reader and voice need nothing new.
5. **Honest failures**: a PDF with no text layer (a scan) gets "This PDF is a scan, so there's no text to read" and opens the original; no OCR in v1. Encrypted PDFs the same. The guard's 120-word floor still applies.

### Open questions for Richard

- **Is a PDF a page?** Contract 4.2 defines the text as Readability's output. A PDF path is a second, pinned parser with its own fixtures (four or five PDFs: a one-column report, a two-column paper, a scan, a protected file, a slide deck). Contract bump, and the flow map gains the scan failure state.
- **Two-column papers.** pdf.js gives items in content-stream order, which is usually column by column, and was in this test. When it isn't, lines interleave. A column-detection pass is a few days' extra work; I'd ship without it and see what users save.
- **The extension.** It could parse a PDF open in Firefox's or Chrome's viewer itself, but the viewer's content scripts are restricted on both, so the phone fetch stays the path. No change there.
- **Bundle size.** pdf.js's legacy build plus worker is about 1.8 MB minified in the APK. Loading it only for a PDF job keeps the parser WebView's start-up as it is.

Effort: a working version for one-column documents in two to three days; the tidy-up for papers (rotation, tables, figures) another two to three; fixtures and the contract change a day.

## Suggested order

Citations first: smaller, no new screens, and it improves every Wikipedia save already in a library. PDFs after, once the contract wording for a second parser is agreed.
