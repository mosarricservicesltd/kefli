// The shared normaliser as the extension builds it, on the browser's own URL (src/urlRecord.ts), against every case in
// shared/normalise.fixtures.json, run in headless Chrome. A save's hash is the sha256 of normalise's answer, and its d tag
// is keyed from that hash (contract 1.10), so the extension and the phone must agree on every case, or the same page
// would be two saves.
//
//   node apps/extension/scripts/normalise.mjs
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launch } from '../../../tools/design-qa/cdp.mjs';
import { platformUrl } from '../build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '..', '..', '..');
const F = JSON.parse(readFileSync(path.join(repo, 'shared', 'normalise.fixtures.json'), 'utf8'));

const out = await build({
  stdin: { contents: "import { normalise } from './shared/normalise';\nglobalThis.kefliNormalise = (u, c) => { try { return normalise(u, c); } catch { return null; } };", resolveDir: repo, loader: 'ts' },
  bundle: true, format: 'iife', write: false, plugins: [platformUrl], logLevel: 'warning',
});
const c = await launch();
const version = await c.eval('navigator.userAgent');
await c.eval(out.outputFiles[0].text);
let bad = 0;
for (const k of F.cases) {
  const got = await c.eval(`kefliNormalise(${JSON.stringify(k.url)}, ${JSON.stringify(k.canonical ?? null)})`);
  if (got !== k.expect) {
    bad++;
    console.log(`✗ ${k.name}: ${JSON.stringify(got)} ≠ ${JSON.stringify(k.expect)}`);
  }
}
c.close();
c.proc.kill();
console.log(`${version.match(/Chrome\/[\d.]+/)?.[0] ?? version}: ${bad ? `${bad} of ${F.cases.length} differ` : `all ${F.cases.length} cases match`}`);
process.exit(bad ? 1 : 0);
