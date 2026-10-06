// Contact sheet of screenshots in out/<OUTD>:  node tools/design-qa/sheet.mjs <from> <to> [scale] [cols] [tag]
import { launch, sleep, SP, saveFrame } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
const [from, to, scale = '0.62', cols = '5', tag = 'a'] = process.argv.slice(2);
const dir = path.join(SP, process.env.OUTD || 'shots');
const all = fs.readdirSync(dir).filter(f => f.endsWith('.png') && !f.startsWith('sheet')).sort().slice(+from, +to);
const c = await launch();
await c.send('Runtime.enable');
const fwd = s => s.split(String.fromCharCode(92)).join('/');
fs.mkdirSync(SP, { recursive: true }); fs.writeFileSync(path.join(SP, 'blank.html'), '<!doctype html><title>sheet</title>');
await c.send('Page.navigate', { url: 'file:///' + fwd(SP) + '/blank.html' });
await sleep(600);
const urls = all.map(f => 'file:///' + fwd(path.join(dir, f)));
const png = await c.eval(`(async () => {
  const load = u => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = u; });
  const imgs = await Promise.all(${JSON.stringify(urls)}.map(load));
  const s = ${+scale}, w = Math.round(imgs[0].width * s), h = Math.round(imgs[0].height * s), cols = Math.min(${+cols}, imgs.length), rows = Math.ceil(imgs.length / cols);
  const cv = document.createElement('canvas'); cv.width = cols * (w + 8) + 8; cv.height = rows * (h + 26) + 8;
  const x = cv.getContext('2d'); x.fillStyle = '#888'; x.fillRect(0, 0, cv.width, cv.height); x.font = '13px monospace'; x.fillStyle = '#000';
  imgs.forEach((im, i) => { const c0 = i % cols, r0 = Math.floor(i / cols); const X = 8 + c0 * (w + 8), Y = 8 + r0 * (h + 26); x.drawImage(im, X, Y + 20, w, h); x.fillText(${JSON.stringify(all)}[i].replace('.png',''), X, Y + 14); });
  return cv.toDataURL('image/png').split(',')[1];
})()`);
saveFrame(dir, 'sheet-' + tag + '.png', png);
console.log('ok', all.length);
c.close(); c.proc.kill(); process.exit(0);
