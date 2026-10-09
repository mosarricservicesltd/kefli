// The live list on the desktop: shared/fixtures/live-urls.json through the app's own fetchPage and X check, with
// desktop Chrome running the parser bundle in place of the phone's WebView. Run it before the phone's gate, to see
// which outcomes have moved upstream.
//   npx tsx apps/mobile/scripts/live-urls.ts

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error: plain ES modules without types
import { launch } from '../../../tools/design-qa/cdp.mjs';
// @ts-expect-error: plain ES modules without types
import { kefliBundle } from '../../../shared/vendor/build-parser-bundle.mjs';
import { runLive, type LiveUrl } from '../src/gates/live';

async function main() {
  const list = JSON.parse(readFileSync(join(__dirname, '../../../shared/fixtures/live-urls.json'), 'utf8')).urls as LiveUrl[];
  const chrome = await launch();
  try {
    await chrome.eval(kefliBundle());
    const parse = (b: string, ct: string, url: string) => chrome.eval(`kefliParse(${JSON.stringify(b)}, ${JSON.stringify(ct)}, ${JSON.stringify(url)})`);
    const results = await runLive({ fetch, parse }, { fetch }, list, () => performance.now());
    for (const r of results) console.log(`${r.pass ? 'pass' : 'FAIL'} ${r.kind}: ${r.got}${r.pass ? '' : ` (expected ${r.expect})`} ${r.detail} — ${r.url}`);
    console.log(`${results.filter((r) => r.pass).length}/${results.length} as expected`);
  } finally {
    chrome.close();
    chrome.proc.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
