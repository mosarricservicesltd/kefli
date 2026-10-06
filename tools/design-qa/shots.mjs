// Screenshots prototype states:  node tools/design-qa/shots.mjs <jump>[:dark[:waitMs]] ...
//   SEL=#win PURL=<extension.html file URL> for the extension prototype; OUTD=<folder under out/>
import { launch, sleep, URL_, saveFrame, SP } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
const list = process.argv.slice(2);
const c = await launch(undefined, 1180, +(process.env.WH || 980));
await c.send('Page.enable'); await c.send('Runtime.enable');
await c.send('Page.navigate', { url: URL_ });
await sleep(2500);
const out = path.join(SP, process.env.OUTD || 'shots');
fs.mkdirSync(out, { recursive: true });
const texts = {};
let i = 0;
for (const item of list) {
  const [j, theme = 'light', wait = '1500'] = item.split(':');
  await c.eval(`document.querySelector('[data-theme-set="${theme}"]').click()`);
  await c.eval(`document.querySelector('[data-jump="${j}"]').click()`);
  await sleep(+wait);
  const r = await c.rect(process.env.SEL || '#phone'); const sy = await c.eval('scrollY');
  const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: r.l, y: r.t + sy, width: r.w, height: r.h, scale: 1 } });
  const name = String(++i).padStart(2, '0') + '_' + j + '_' + theme;
  saveFrame(out, name + '.png', shot.data);
  texts[name] = await c.eval(`document.querySelector(${JSON.stringify(process.env.SEL || '#phone')}).innerText.split(/[\\n\\t ]+/).join(' ').slice(0,900)`);
}
fs.writeFileSync(path.join(out, 'texts.json'), JSON.stringify(texts, null, 1));
c.close(); c.proc.kill(); process.exit(0);
