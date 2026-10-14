import { requireNativeModule } from 'expo-modules-core';
import type { PdfRuns } from '@kefli/protocol';

/** mobile spec 8.2. The markdown is normalised (contract 4.2); the guard is the caller's. */
export type Parsed =
  | { ok: true; title: string | null; byline: string | null; site: string | null; lang: string | null; hero: string | null; canonical: string | null; readerable: boolean; markdown: string }
  | { ok: false; reason: 'no_webview' | 'not_readable' | 'error'; message?: string };

/** A page loaded once in a browser engine (8.2): its rendered HTML and final address, or why not. */
export type Rendered = { ok: true; url: string; html: string } | { ok: false; reason: 'no_webview' | 'timeout' };

/** A PDF's text runs (contract 4.2, PDFs), for pdfMarkdown to lay out, or why there are none. */
export type PdfRead = ({ ok: true } & PdfRuns) | { ok: false; reason: 'no_webview' | 'pdf_locked' | 'pdf_too_long' | 'error'; message?: string };

const native = requireNativeModule<{
  parse(b: string, ct: string, url: string): Promise<string>;
  markdown(html: string, url: string): Promise<string>;
  render(url: string): Promise<string>;
  pdf(b: string): Promise<string>;
  holdJar(on: boolean): void;
}>('KefliParser');

export const KefliParser = {
  async parse(bodyBase64: string, contentType: string, url: string): Promise<Parsed> {
    return JSON.parse(await native.parse(bodyBase64, contentType, url));
  },
  async markdown(contentHtml: string, url: string): Promise<Parsed> {
    return JSON.parse(await native.markdown(contentHtml, url));
  },
  async pdf(bodyBase64: string): Promise<PdfRead> {
    return JSON.parse(await native.pdf(bodyBase64));
  },
  async render(url: string): Promise<Rendered> {
    return JSON.parse(await native.render(url));
  },
  /** An Original view opened or closed: while one is open, a render leaves the shared cookie jar to it (F27). */
  holdJar(on: boolean): void {
    native.holdJar(on);
  },
};
