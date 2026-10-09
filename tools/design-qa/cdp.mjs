// Minimal CDP driver for headless Chrome (Node 24: global WebSocket and fetch). Used by the design QA scripts here.
//   CHROME=<path to chrome>   overrides the browser (defaults below for Windows, macOS and Linux)
//   PURL=<url>                 overrides the page (default: the phone prototype in docs/design/mockups)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const OUT = path.join(HERE, 'out');                 // screenshots and logs (git-ignored)
export const SP = OUT;                                      // older scripts call it SP
const CHROME = process.env.CHROME || ({
  win32: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
}[process.platform] || 'google-chrome');
export const URL_ = process.env.PURL || pathToFileURL(path.join(REPO, 'docs', 'design', 'mockups', 'prototype.html')).href;
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch(port = 9333 + Math.floor(Math.random() * 500), w = 1180, h = 980){
  const dir = path.join(os.tmpdir(), 'kefli-qa-chrome-' + port);
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, `--window-size=${w},${h}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 80; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(150); } }
  if (!ver) throw new Error('chrome did not start');
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  const c = await connect(page.webSocketDebuggerUrl);
  c.proc = proc; c.port = port;
  return c;
}

// The message for an exception that Runtime.evaluate reports from the page.
const evalError = d => 'eval: ' + (d.exception?.description || d.text);

export async function connect(wsUrl){
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const handlers = new Map();
  // a reply settles the request it answers; anything else is an event for its handlers
  const settle = m => { const { res, rej } = pend.get(m.id); pend.delete(m.id); if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result); };
  const dispatch = m => (handlers.get(m.method) ?? []).forEach(f => f(m.params));
  ws.onmessage = ev => { const m = JSON.parse(ev.data); (pend.has(m.id) ? settle : dispatch)(m); };
  const c = {
    ws,
    send: (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); }),
    on: (method, f) => { if (!handlers.has(method)) handlers.set(method, []); handlers.get(method).push(f); },
    async eval(expr, awaitPromise = true){
      const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
      if (r.exceptionDetails) throw new Error(evalError(r.exceptionDetails));
      return r.result.value;
    },
    async mouse(type, x, y, extra = {}){ await c.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, pointerType: 'mouse', ...extra }); },
    async tap(x, y, hold = 40){ await c.mouse('mouseMoved', x, y, { buttons: 0 }); await c.mouse('mousePressed', x, y); await sleep(hold); await c.mouse('mouseReleased', x, y); },
    async drag(x0, y0, x1, y1, steps = 10, ms = 160){
      await c.mouse('mouseMoved', x0, y0, { buttons: 0 }); await c.mouse('mousePressed', x0, y0);
      for (let i = 1; i <= steps; i++) { await sleep(ms / steps); await c.mouse('mouseMoved', x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); }
      await c.mouse('mouseReleased', x1, y1);
    },
    async rect(sel){ return c.eval(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find(e => !e.closest('.ghost')); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left, t: r.top, w: r.width, h: r.height }; })()`); },
    async tapSel(sel, hold){ const r = await c.rect(sel); if (!r) throw new Error('no element ' + sel); await c.tap(r.x, r.y, hold); return r; },
    close(){ try { ws.close(); } catch {} },
  };
  return c;
}

// in-page recorder: every animation that starts, with its properties and timing
export const RECORDER = `(() => {
  if (window.__rec) return;
  const seen = new WeakSet(), log = []; window.__rec = log; window.__recT0 = performance.now();
  const desc = el => { if (!el) return '?'; let s = el.tagName ? el.tagName.toLowerCase() : '?'; if (el.id) s += '#' + el.id; if (el.classList && el.classList.length) s += '.' + [...el.classList].slice(0, 3).join('.'); const g = el.closest && el.closest('.ghost'); if (g) s += ' (ghost)'; return s; };
  const props = a => {
    if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) return [a.transitionProperty];
    const set = new Set(); try { a.effect.getKeyframes().forEach(k => Object.keys(k).forEach(p => { if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) set.add(p); })); } catch (e) {}
    return [...set];
  };
  const tick = () => {
    document.getAnimations().forEach(a => {
      if (seen.has(a)) return; seen.add(a);
      const fx = a.effect, t = fx ? fx.getTiming() : {};
      const kind = (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) ? 'transition' : (typeof CSSAnimation !== 'undefined' && a instanceof CSSAnimation) ? 'css' : 'waapi';
      log.push({ at: Math.round(performance.now() - window.__recT0), kind, name: a.animationName || a.transitionProperty || a.id || '', props: props(a), duration: t.duration, delay: Math.round(t.delay || 0), easing: t.easing, iterations: t.iterations, target: desc(fx && fx.target) + (fx && fx.pseudoElement ? fx.pseudoElement : ''), composite: fx && fx.composite });
    });
    requestAnimationFrame(tick);
  };
  tick();
})()`;

export function saveFrame(dir, name, b64){ fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), Buffer.from(b64, 'base64')); }
