// Google Play takes phone screenshots at 16:9 or 9:16 only (docs/store/google-play.md), and the Pixel 10a's are
// 1080 × 2424. This fits each one, whole, onto a 1080 × 1920 canvas in the screenshot's own edge colour (its top-left
// pixel: paper in light, graphite in dark), so nothing is cropped and the bands match the screen's own ground. Drawn
// in headless Chrome through tools/design-qa/cdp.mjs, the one image tool this repository relies on.
//   node apps/mobile/scripts/play-screenshots.mjs        apps/mobile/store/screenshots/*.png → apps/mobile/store/play/
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch, sleep } from '../../../tools/design-qa/cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const from = path.join(here, '..', 'store', 'screenshots');
const to = path.join(here, '..', 'store', 'play');
const W = 1080, H = 1920;
mkdirSync(to, { recursive: true });

const frame = path.join(os.tmpdir(), `kefli-play-frame-${process.pid}.html`);
const c = await launch(undefined, W, H);
try {
  await c.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  for (const name of readdirSync(from).filter((f) => f.endsWith('.png')).sort()) {
    const src = pathToFileURL(path.join(from, name)).href;
    const html = `<!doctype html><body style="margin:0;width:${W}px;height:${H}px;display:grid;place-items:center;overflow:hidden">
      <img id="s" src="${src}" style="max-width:${W}px;max-height:${H}px;image-rendering:auto"></body>`;
    // a file: page, since a data: page is its own origin and may not load a file: image
    writeFileSync(frame, html);
    await c.send('Page.navigate', { url: pathToFileURL(frame).href });
    await sleep(400);
    const ground = await c.eval(`(async () => {
      const img = document.getElementById('s');
      if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
      const cv = document.createElement('canvas'); cv.width = cv.height = 1;
      const px = cv.getContext('2d'); px.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
      const [r, g, b] = px.getImageData(0, 0, 1, 1).data;
      document.body.style.background = 'rgb(' + r + ',' + g + ',' + b + ')';
      return { r, g, b, w: img.naturalWidth, h: img.naturalHeight, dw: img.clientWidth, dh: img.clientHeight };
    })()`);
    await sleep(200);
    const shot = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    writeFileSync(path.join(to, name), Buffer.from(shot.data, 'base64'));
    console.log(`${name}: ${ground.w}×${ground.h} → ${ground.dw}×${ground.dh} on ${W}×${H}, ground rgb(${ground.r},${ground.g},${ground.b})`);
  }
} finally {
  c.close();
  c.proc.kill();
  rmSync(frame, { force: true });
}
