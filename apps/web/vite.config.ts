import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, loadEnv, type Plugin } from 'vite';

// A static site: one HTML file per page, served by the operator's Caddy on the apex domain
// (backend spec section 5). Links and downloads come from .env (see README).
const here = import.meta.dirname;
const page = (p: string) => resolve(here, p);

/**
 * Two build-time passes over every page, so nothing depends on script:
 * - `<!--partial:name-->` is replaced by src/partials/name.html (the nav and the footer).
 * - `<a data-link="NAME" …>…</a>` takes its href from VITE_NAME_URL. A link that is still "#" (or unset)
 *   becomes a plain span marked Soon, so the page never offers a button that goes nowhere.
 */
function site(env: Record<string, string>): Plugin {
  return {
    name: 'kefli-site',
    transformIndexHtml(html) {
      const withPartials = html.replace(/<!--partial:([a-z-]+)-->/g, (_, name: string) =>
        readFileSync(resolve(here, 'src', 'partials', `${name}.html`), 'utf8').trim(),
      );
      return withPartials.replace(
        /<a([^>]*?)\sdata-link="([A-Z_]+)"([^>]*)>([\s\S]*?)<\/a>/g,
        (_, before: string, name: string, after: string, inner: string) => {
          const url = env[`VITE_${name}_URL`];
          const attrs = `${before}${after}`.replace(/\shref="[^"]*"/, '');
          if (url && url !== '#') return `<a${attrs} href="${url}">${inner}</a>`;
          const cls = /class="/.test(attrs) ? attrs.replace(/class="/, 'class="is-soon ') : `${attrs} class="is-soon"`;
          return `<span${cls} aria-disabled="true">${inner}<span class="soon-tag">Soon</span></span>`;
        },
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, here, 'VITE_');
  return {
    plugins: [site(env)],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: {
          index: page('index.html'),
          privacy: page('privacy/index.html'),
          extension: page('extension/index.html'),
          extensionPrivacy: page('extension-privacy/index.html'),
          deleteAccount: page('delete-account/index.html'),
        },
      },
    },
  };
});
