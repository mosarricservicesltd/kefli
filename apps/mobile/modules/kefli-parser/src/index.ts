import { requireNativeModule } from 'expo-modules-core';

/** mobile spec 8.2. The markdown is normalised (contract 4.2); the guard is the caller's. */
export type Parsed =
  | { ok: true; title: string | null; byline: string | null; site: string | null; lang: string | null; hero: string | null; canonical: string | null; readerable: boolean; markdown: string }
  | { ok: false; reason: 'no_webview' | 'not_readable' | 'error'; message?: string };

/** A page loaded once in a browser engine (8.2): its rendered HTML and final address, or why not. */
export type Rendered = { ok: true; url: string; html: string } | { ok: false; reason: 'no_webview' | 'timeout' };

const native = requireNativeModule<{
  parse(b: string, ct: string, url: string): Promise<string>;
  markdown(html: string, url: string): Promise<string>;
  render(url: string): Promise<string>;
}>('KefliParser');

export const KefliParser = {
  async parse(bodyBase64: string, contentType: string, url: string): Promise<Parsed> {
    return JSON.parse(await native.parse(bodyBase64, contentType, url));
  },
  async markdown(contentHtml: string, url: string): Promise<Parsed> {
    return JSON.parse(await native.markdown(contentHtml, url));
  },
  async render(url: string): Promise<Rendered> {
    return JSON.parse(await native.render(url));
  },
};
