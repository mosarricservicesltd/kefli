// node docs/design/icons/negative-space/tools/shot.mjs <page.html> <out.png> [width=1280] [light|dark] [hash] [dpr=1]
// Full-page screenshot of a local page in headless Chrome, in the given colour scheme. Prints console errors.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launch, sleep } from '../../../../../tools/design-qa/cdp.mjs';

const [file, out, w = '1280', scheme = 'light', hash = '', dpr = '1'] = process.argv.slice(2);
if (!file || !out) { console.error('usage: node shot.mjs <page.html> <out.png> [width] [light|dark] [hash] [dpr]'); process.exit(1); }
const width = +w, scale = +dpr;
const c = await launch(undefined, width, 900);
const errors = [];
c.on('Runtime.exceptionThrown', p => errors.push('exception: ' + (p.exceptionDetails.exception && p.exceptionDetails.exception.description || p.exceptionDetails.text)));
c.on('Runtime.consoleAPICalled', p => { if (p.type === 'error' || p.type === 'warning') errors.push(p.type + ': ' + p.args.map(a => a.value || a.description).join(' ')); });
c.on('Log.entryAdded', p => { if (p.entry.level === 'error') errors.push('log: ' + p.entry.text + (p.entry.url ? ' ' + p.entry.url : '')); });
try {
  await c.send('Page.enable'); await c.send('Runtime.enable'); await c.send('Log.enable');
  await c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
  await c.send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: scale, mobile: false });
  await c.send('Page.navigate', { url: pathToFileURL(path.resolve(file)).href + (hash ? '#' + hash : '') });
  await sleep(2500);
  // FLAT=1 unpins the sticky panel so a full-page shot shows all of it
  if (process.env.FLAT) await c.eval(`(() => { const s = document.createElement('style'); s.textContent = '.panel{position:static!important;max-height:none!important;overflow:visible!important}'; document.head.appendChild(s); return 1; })()`, false);
  const h = await c.eval('Math.ceil(document.documentElement.scrollHeight)', false);
  await c.send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: scale, mobile: false });
  await sleep(400);
  const overflow = await c.eval(`(() => { const W = document.documentElement.clientWidth, bad = [];
    for (const el of document.querySelectorAll('body *')) { const r = el.getBoundingClientRect();
      if (r.right > W + 1 && !el.closest('.lrow')) bad.push((el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + [...el.classList].join('.')) + ' ' + Math.round(r.right)); }
    return bad.slice(0, 12); })()`, false);
  const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(path.resolve(out), `${width}x${h}`, scheme);
  if (overflow.length) console.log('overflow:', overflow.join(', '));
  if (errors.length) console.log('errors:\n' + errors.join('\n'));
} finally {
  c.close(); try { c.proc.kill(); } catch {}
}
process.exit(0);
