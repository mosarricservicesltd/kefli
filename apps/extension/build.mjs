// Builds the extension (extension spec 2 and 11): one codebase, a Chrome and a Firefox build per flavour.
//
//   node build.mjs dev              dist/dev-chrome and dist/dev-firefox, against the local stack
//   node build.mjs beta             dist/beta-chrome and dist/beta-firefox, against KEFLI_DEFAULTS_URL (https)
//   node build.mjs dev --watch      rebuild on change (then press reload on the extension's card)
//
// Never minified (spec 12). The parser is the phone's own bundle (shared/vendor), so a page reads the same here as
// in the app's WebView; the cover is cover-v1.js, unmodified.
import { context } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kefliBundle } from '../../shared/vendor/build-parser-bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));

// Fixed public keys, so an unpacked build has the same ID on every machine (spec 11); the private halves were
// never kept, since nothing is ever signed with them for Chrome's store.
const CHROME_KEY = {
  dev: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmfq0dwlbWTe7qdD+KoNlJrojk8RMNc5Eb5UgHvSY/Yp6qEw0ZjDRNVjyw7Xcy/5XngoSlxo8i2dScA22Sb0Fn0xfbseDrv9xZ9T3/f+GcijwBVuELFrHSewjcNEhJySdn/B7kGsBajZqmENgDuxZG9pxvpxEU/PFd0b+tLk4O7lNQTuQYUHLTxHX6lIJue0d6OxtnIYbabu/PbuiYhJPqX1Z2Yuz/k8+Xs+/B15H+GLG8Y5GbIfa6/sZBMS+FN45FJYAG16PLoymMc2LGmGkScnvjLcp0qhsATLD9z1JnIV/S/+DlOZ7GDjSl7opH9I/Bj4kZdxQ/CwQeHjEXrLAtQIDAQAB',
  beta: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAsdwVO/fq9qNZnpjkJCMXNE6+pL/cGESshCJ+fSVJO/w4H/rMkT4IrhmL97scMU0H6zeFmJRr7MBfpm+nRJhbCyuYEGgtilYQQSZjfqKPnNJgr854ZxQxdMuDIR5+nHuOllH/CeIumaHitXQxVZHx4L17kUUqunzrlXNQOsOjkeig8YM8uA7eRYI9ZpLdsPMqIgLiVfU24LByMO5sw7YuoXIp2w4j7luqHljZp+HyfLI59DzWdCO+0pTfw6hXDL/vYILmOmZu1VHtz+pbgQ0CRg4Bfmw6BV2P0dbkTMl22vJzL1TR4Xbq4whHhMaDiWYDjKRrd9EyOwSE/K24fTlJIwIDAQAB',
};
const GECKO_ID = { dev: 'dev@extension.kefli.app', beta: 'beta@extension.kefli.app' };

const direct = process.argv[1] === fileURLToPath(import.meta.url);
const flavour = direct ? (process.argv[2] ?? 'dev') : 'dev';
if (!(flavour in CHROME_KEY)) throw new Error(`unknown flavour ${flavour}: dev or beta`);
const defaultsUrl = flavour === 'dev' ? 'http://localhost:8447/defaults.json' : process.env.KEFLI_DEFAULTS_URL;
if (!defaultsUrl || (flavour !== 'dev' && !defaultsUrl.startsWith('https://'))) throw new Error('set KEFLI_DEFAULTS_URL to the operator\'s https defaults.json');

function manifest(browser) {
  const m = {
    manifest_version: 3,
    name: flavour === 'dev' ? 'Kefli (dev)' : 'Kefli',
    version: pkg.version,
    description: 'Save the page you are reading to Kefli on your phone.',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    action: { default_title: 'Save to Kefli', default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png' } },
    commands: { 'save-page': { suggested_key: { default: 'Alt+Shift+S' }, description: 'Save this page to Kefli' } },
    permissions: ['activeTab', 'scripting', 'storage', 'alarms', 'contextMenus'],
    options_ui: { page: 'options.html', open_in_tab: true },
  };
  if (browser === 'chrome') return { ...m, key: CHROME_KEY[flavour], minimum_chrome_version: '116', background: { service_worker: 'bg.js' } };
  // Firefox takes the toolbar button's SVGs at 16 and 32, and puts the button in the navbar (mockup build notes)
  const svg = { 16: 'icons/icon-16.svg', 32: 'icons/icon-32.svg' };
  return {
    ...m,
    icons: { ...m.icons, ...svg },
    action: { ...m.action, default_icon: svg, default_area: 'navbar' },
    background: { scripts: ['bg.js'] },
    // Firefox's default policy for extension pages adds upgrade-insecure-requests, which would turn the dev build's
    // ws://localhost and http://localhost into wss and https; the dev build states the policy without it
    ...(flavour === 'dev' ? { content_security_policy: { extension_pages: "script-src 'self'" } } : {}),
    browser_specific_settings: { gecko: { id: GECKO_ID[flavour], strict_min_version: '121.0', data_collection_permissions: { required: ['none'] } } },
  };
}

const ENTRIES = ['bg', 'options', 'capture', 'toast', 'saved'];

/**
 * The shared normaliser takes its URL record from whatwg-url, for Hermes; in a browser the platform's URL is the same
 * Standard, so the extension gets src/urlRecord.ts in its place and leaves out whatwg-url, tr46 and @exodus/bytes (about
 * 800 KB a bundle). test/urlRecord.test.ts and scripts/normalise.mjs hold it to shared/normalise.fixtures.json.
 */
export const platformUrl = {
  name: 'platform-url',
  setup(b) {
    b.onResolve({ filter: /^whatwg-url\/lib\/url-state-machine$/ }, () => ({ path: join(here, 'src', 'urlRecord.ts') }));
  },
};
// The board's static cuts for the options page and the popup (mockup build notes, Fonts); the toast stays system-ui.
const FONTS = ['Archivo-400', 'Archivo-500', 'Archivo-600', 'ArchivoExpanded-750'];

async function build(browser) {
  const out = join(here, 'dist', `${flavour}-${browser}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, 'icons'), { recursive: true });
  const ctx = await context({
    entryPoints: Object.fromEntries(ENTRIES.map((e) => [e, join(here, 'src', `${e}.ts`)])),
    outdir: out,
    bundle: true,
    format: 'iife',
    target: browser === 'chrome' ? 'chrome116' : 'firefox121',
    minify: false,
    legalComments: 'inline',
    define: { KEFLI_DEFAULTS_URL: JSON.stringify(defaultsUrl), KEFLI_FLAVOUR: JSON.stringify(flavour), KEFLI_BROWSER: JSON.stringify(browser) },
    loader: { '.svg': 'text' },
    plugins: [platformUrl],
    logLevel: 'warning',
  });
  await ctx.rebuild();
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest(browser), null, 2) + '\n');
  writeFileSync(join(out, 'parser.js'), kefliBundle());
  // the generated tokens without the mockups' remote font import (the extension bundles its fonts)
  writeFileSync(join(out, 'tokens.css'), readFileSync(join(repo, 'docs', 'design', 'mockups', 'tokens.css'), 'utf8').replace(/^@import url\([^)]*\);\n/m, ''));
  for (const css of ['options.css', 'saved.css']) cpSync(join(here, 'src', css), join(out, css));
  for (const page of ['options.html', 'saved.html']) cpSync(join(here, 'src', page), join(out, page));
  for (const n of [16, 32, 48, 128]) cpSync(join(repo, 'shared', 'brand', 'out', 'extension', `icon-${n}.png`), join(out, 'icons', `icon-${n}.png`));
  cpSync(join(repo, 'shared', 'brand', 'out', 'extension', 'options-logo-28.svg'), join(out, 'icons', 'logo-28.svg'));
  mkdirSync(join(out, 'fonts'));
  for (const f of FONTS) cpSync(join(repo, 'shared', 'fonts', 'out', `${f}.ttf`), join(out, 'fonts', `${f}.ttf`));
  for (const n of [16, 32]) cpSync(join(repo, 'shared', 'brand', 'out', 'extension', `icon-${n}.svg`), join(out, 'icons', `icon-${n}.svg`));
  console.log(`built ${out}`);
  return ctx;
}

if (direct) {
  const contexts = [await build('chrome'), await build('firefox')];
  if (process.argv.includes('--watch')) {
    await Promise.all(contexts.map((c) => c.watch()));
    console.log('watching');
  } else await Promise.all(contexts.map((c) => c.dispose()));
}
