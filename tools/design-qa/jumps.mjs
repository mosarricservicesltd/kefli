// Clicks every data-jump state in a prototype, in light and dark, and reports script errors, console errors and any
// animation of a property other than transform or opacity (the motion rule).   node tools/design-qa/jumps.mjs
// The phone prototype's jumps must also leave a screen in its viewport; a prototype with no #phone (the extension's,
// through PURL) skips that check.
import { launch, sleep, URL_, RECORDER } from './cdp.mjs';

const c = await launch();
const errors = [];
c.on('Runtime.exceptionThrown', p => errors.push({ k: 'exception', t: p.exceptionDetails.exception ? p.exceptionDetails.exception.description : p.exceptionDetails.text, cur: c.cur }));
c.on('Runtime.consoleAPICalled', p => { if (p.type === 'error' || p.type === 'warning' || p.type === 'assert') errors.push({ k: 'console.' + p.type, t: p.args.map(a => a.value || a.description).join(' '), cur: c.cur }); });
c.on('Log.entryAdded', p => { if (p.entry.level === 'error') errors.push({ k: 'log', t: p.entry.text + ' ' + (p.entry.url || ''), cur: c.cur }); });
await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Page.enable');
await c.send('Page.navigate', { url: URL_ });
await sleep(2500);
await c.eval(RECORDER);
const jumps = await c.eval(`[...document.querySelectorAll('[data-jump]')].map(b => b.dataset.jump)`);
console.log('jumps', jumps.length);
const bad = [];
const phone = await c.eval(`!!document.getElementById('phone')`);
for (const theme of ['light', 'dark']) {
  await c.eval(`document.querySelector('[data-theme-set="${theme}"]').click()`);
  for (const j of jumps) {
    c.cur = theme + ':' + j;
    await c.eval(`document.querySelector('[data-jump="${j}"]').click()`);
    await sleep(j.startsWith('restoring') || j.includes('arrive') ? 1600 : 260);
    if (!phone) continue;
    const st = await c.eval(`(() => { const s = document.querySelector('#vp > .screen'); return { screen: !!s, n: document.querySelectorAll('#vp *').length, theme: document.getElementById('phone').dataset.theme }; })()`);
    if (!st.screen && !j.startsWith('share')) bad.push(c.cur + ' no screen');
  }
}
await sleep(2000);
const rec = await c.eval('window.__rec');
const offProps = rec.filter(r => r.props.some(p => !['transform', 'opacity'].includes(p)));
console.log('animations recorded', rec.length);
console.log('non transform/opacity', JSON.stringify(offProps.slice(0, 20), null, 1));
const names = {}; rec.forEach(r => { const k = r.kind + ':' + r.name + ':' + r.props.join('+') + ':' + r.duration + ':' + r.easing; names[k] = (names[k] || 0) + 1; });
console.log(JSON.stringify(names, null, 1));
console.log('errors', errors.length, JSON.stringify(errors.slice(0, 30), null, 1));
console.log('bad', bad);
c.close(); c.proc.kill();
process.exit(0);
