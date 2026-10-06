// node shotsheet.mjs <out.png> <query string>   e.g. node shotsheet.mjs s1.png "from=0&to=60&pal=cd210"
import { launch, sleep, saveFrame } from '../../../../tools/design-qa/cdp.mjs';
const [out, qs] = process.argv.slice(2);
const c = await launch(undefined, 1060, 900);
await c.send('Page.enable');
await c.send('Emulation.setDeviceMetricsOverride', { width: 1060, height: 900, deviceScaleFactor: 1, mobile: false });
const here = 'file:///' + process.cwd().split(String.fromCharCode(92)).join('/');
await c.send('Page.navigate', { url: here + '/sheet.html?' + qs }); await sleep(1500);
const shot = await c.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
saveFrame(process.cwd() + '/sheets', out, shot.data);   // sheets/ is git-ignored; rerun to regenerate console.log('wrote sheets/' + out);
c.close(); c.proc.kill(); process.exit(0);
