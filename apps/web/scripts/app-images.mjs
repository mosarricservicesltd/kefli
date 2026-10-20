// The landing page's four app images (src/media/app-*.webp, so Vite hashes their names; public/media/SOURCES.md): the store screenshots in
// apps/mobile/store/screenshots, scaled to 360 and 720 pixels wide as WebP. Drawn in headless Chrome through
// tools/design-qa/cdp.mjs, whose screenshot can be WebP, since the repository relies on no other image tool.
//   node apps/web/scripts/app-images.mjs
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, sleep } from '../../../tools/design-qa/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, '..', '..', 'mobile', 'store', 'screenshots');
const media = path.join(here, '..', 'src', 'media');
const SOURCES = { save: '3-library.png', read: '4-reader.png', speed: '5-speedread.png', listen: '7-listen.png' };
const WIDTHS = [360, 720];
const RATIO = 2424 / 1080;

const frame = path.join(os.tmpdir(), `kefli-app-image-${process.pid}.html`);
const c = await launch(undefined, 800, 1700);
try {
  for (const [name, file] of Object.entries(SOURCES)) {
    for (const w of WIDTHS) {
      const h = Math.round(w * RATIO);
      const src = pathToFileURL(path.join(shots, file)).href;
      writeFileSync(frame, `<!doctype html><body style="margin:0;background:#000"><img src="${src}" style="display:block;width:${w}px;height:${h}px"></body>`);
      await c.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
      await c.send('Page.navigate', { url: pathToFileURL(frame).href });
      await sleep(400);
      await c.eval(`(async () => { const i = document.querySelector('img'); if (!i.complete) await new Promise((r) => { i.onload = r; i.onerror = r; }); return i.naturalWidth; })()`);
      const shot = await c.send('Page.captureScreenshot', { format: 'webp', quality: 86, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
      const out = path.join(media, `app-${name}-${w}.webp`);
      writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log(`${path.basename(out)}: ${w}×${h} from ${file}`);
    }
  }
} finally {
  c.close();
  c.proc.kill();
  rmSync(frame, { force: true });
}
