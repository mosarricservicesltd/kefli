// Loads the built extension into headless Chrome for checks (extension spec 8), since branded Chrome no longer takes
// --load-extension: the DevTools protocol's Extensions.loadUnpacked, allowed by --enable-unsafe-extension-debugging.
//
//   node apps/extension/scripts/chrome.mjs options [out.png]     the options page, screenshotted
//
// Exports open(), which returns { browser, page(url), id, close } for other scripts.
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, sleep } from '../../../tools/design-qa/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist', 'dev-chrome');

export async function open({ dist = DIST, w = 1100, h = 900 } = {}) {
  const port = 9900 + Math.floor(Math.random() * 90);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kefli-ext-'));
  const proc = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, `--window-size=${w},${h}`,
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 80 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(150); } }
  if (!ver) throw new Error('chrome did not start');
  const browser = await connect(ver.webSocketDebuggerUrl);
  const { id } = await browser.send('Extensions.loadUnpacked', { path: dist });
  async function page(url) {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.id === targetId);
    const c = await connect(t.webSocketDebuggerUrl);
    const errors = [];
    c.on('Runtime.exceptionThrown', (e) => errors.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
    c.on('Runtime.consoleAPICalled', (e) => e.type === 'error' && errors.push(e.args.map((a) => a.value ?? a.description).join(' ')));
    await c.send('Runtime.enable');
    await c.send('Page.enable');
    await c.send('Page.navigate', { url });
    c.errors = errors;
    c.shot = async (file) => writeFileSync(file, Buffer.from((await c.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    return c;
  }
  return { browser, id, port, page, close: () => { browser.ws.close(); proc.kill(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const what = process.argv[2] ?? 'options';
  const ext = await open();
  const p = await ext.page(`chrome-extension://${ext.id}/${what}.html`);
  await sleep(Number(process.env.WAIT ?? 3000));
  const out = process.argv[3] ?? path.join(os.tmpdir(), `kefli-${what}.png`);
  await p.shot(out);
  console.log(`extension ${ext.id}; ${out}; errors: ${JSON.stringify(p.errors)}`);
  ext.close();
  process.exit(0);
}
