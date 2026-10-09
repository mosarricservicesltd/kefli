#!/usr/bin/env node
/*
 * Cover v1 check: node shared/cover/test.cjs [--exhaustive]
 *
 * 1. Source rules: no Math.pow, **, sin, cos, exp, random, Date, locale or Intl in the code; every
 *    numeric literal has 17 significant digits or fewer; loads as a classic script and under require.
 * 2. Golden fixtures (fixtures.json): every recorded value is reproduced exactly.
 * 3. The board: the generator inside docs/design/study/fingerprint.html is loaded into a Node vm and its
 *    own functions are compared with the module for every fixture hash and 1,000 more. Palettes, leaves,
 *    lineInk, highlight and night must be equal. The SVG deliberately differs by the seam rule of 4 October
 *    2026 (README, Drawing), so the module's SVG must equal the board's SVG passed through seamRule()
 *    below, which restates that rule on the board's markup and changes nothing else.
 * 4. --exhaustive: every possible palette (2^16 hues x 4 schemes x 2 grounds = 524,288), every Night hue
 *    (0-360) and the luminance of all 16,777,216 colours, module against board. About two minutes.
 * 5. The served copy docs/design/mockups/cover-v1.js, if present, matches the source.
 * Exits 1 on any mismatch.
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), crypto = require('crypto');

const DIR = __dirname, ROOT = path.resolve(DIR, '..', '..');
const SRC = fs.readFileSync(path.join(DIR, 'cover-v1.js'), 'utf8');
const C = require('./cover-v1.js');
const F = JSON.parse(fs.readFileSync(path.join(DIR, 'fixtures.json'), 'utf8'));
const BOARD = path.join(ROOT, 'docs', 'design', 'study', 'fingerprint.html');
const MIRROR = path.join(ROOT, 'docs', 'design', 'mockups', 'cover-v1.js');
const EXHAUSTIVE = process.argv.includes('--exhaustive');

let checks = 0, failures = 0;
function fail(what, expected, got) {
  failures++;
  if (failures <= 30) console.error('FAIL ' + what + '\n  expected ' + JSON.stringify(expected) + '\n  got      ' + JSON.stringify(got));
}
function eq(what, expected, got) {
  checks++;
  if (JSON.stringify(expected) !== JSON.stringify(got)) fail(what, expected, got);
}
function ok(what, cond) { checks++; if (!cond) fail(what, true, false); }
const sha = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const section = name => console.log('-- ' + name);

/* The winter rule (README, Palette; flow decision 99), restated on the board's generator source: the other way
   the module differs from the board. The hue from bytes 0 and 1 is mapped into 150-320 degrees instead of round
   the wheel; the secondary hues are placed inside that range (analogous and complement's +26 folded back at its
   ends; complement's opposite at half the range, triad at a third and two thirds, split at 0.42 and 0.58, wrapped
   round it); every chroma is 0.7 of the board's. Everything else in the board's source is kept. */
function winterRule(gen) {
  const swaps = [
    ['const hue = ((b(0) << 8) | b(1)) / 65536 * 360;', 'const hue = 150 + ((b(0) << 8) | b(1)) / 65536 * 170;'],
    ['const h1 = hue + o1, h2 = hue + o2;', 'const [h1, h2] = winterHues(hue, scheme);'],
    ['oklch(sigL(hue), 0.175, hue)', 'oklch(sigL(hue), 0.1225, hue)'],
    ['{ ground: oklch(0.255, 0.045, h2), deep: oklch(0.93, 0.035, h1), soft: oklch(0.60, 0.12, h1), signal }',
     '{ ground: oklch(0.255, 0.0315, h2), deep: oklch(0.93, 0.0245, h1), soft: oklch(0.60, 0.084, h1), signal }'],
    ['{ ground: oklch(0.945, 0.028, h2), deep: oklch(0.33, 0.085, h1), soft: oklch(0.81, 0.095, h1), signal }',
     '{ ground: oklch(0.945, 0.0196, h2), deep: oklch(0.33, 0.0595, h1), soft: oklch(0.81, 0.0665, h1), signal }'],
    ['  const cache = new Map();\n  function palette(hash){', [
      '  const winterHues = (hue, scheme) => {',
      '    const lo = 150, hi = 320, w = 170;',
      '    const wrap = h => lo + (((h - lo) % w) + w) % w;',
      '    const fold = h => { let x = h; for (let i = 0; i < 4; i++) { if (x > hi) x = 2 * hi - x; if (x < lo) x = 2 * lo - x; } return x; };',
      "    if (scheme === 'analogous') return [fold(hue + 38), fold(hue - 34)];",
      "    if (scheme === 'complement') return [wrap(hue + w / 2), fold(hue + 26)];",
      "    if (scheme === 'triad') return [wrap(hue + w / 3), wrap(hue + 2 * w / 3)];",
      '    return [wrap(hue + 0.42 * w), wrap(hue + 0.58 * w)];',
      '  };',
      '  const cache = new Map();',
      '  function palette(hash){'].join('\n')],
  ];
  for (const [from, to] of swaps) {
    if (gen.split(from).length !== 2) throw new Error('winter rule: the board no longer reads ' + JSON.stringify(from.slice(0, 40)));
    gen = gen.replace(from, () => to);
  }
  return gen;
}

/* The seam rule (README, Drawing), restated on the board's SVG markup: the one way the module's SVG differs
   from the board's. Each leaf's square, which the board draws only for a background that isn't the ground,
   is drawn for every leaf (2 px oversize, as the board's are); each quarter, half, diag and bands module is
   followed, inside its rotated group, by strips 2 px either side of the cell's top and left sides (before
   rotation) along the stretches it touches. Everything else in the string is kept. Returns [svg, leaves seen]. */
function seamRule(svg) {
  const ground = svg.match(/^<svg [^>]*>(?:<title>[^<]*<\/title>)?<g ><rect width="\d+" height="\d+" fill="(#[0-9A-F]{6})"\/>/)[1];
  const top = (a, b) => 'M' + a + ' -2H' + b + 'V2H' + a + 'Z', left = (a, b) => 'M-2 ' + a + 'H2V' + b + 'H-2Z';
  const strips = body => {
    let m;
    if ((m = body.match(/^<path fill="(#[0-9A-F]{6})" d="M0 0H(\d+)A\2 \2 0 0 1 0 \2Z"\/><path fill="(#[0-9A-F]{6})" d="M0 0H([\d.]+)A\4 \4 0 0 1 0 \4Z"\/><path fill="\1" d="M0 0H([\d.]+)A\5 \5 0 0 1 0 \5Z"\/>$/))) {
      const [, fg, s, bg, t2, t1] = m;                       // bands: outer and inner thirds in the fill, the middle third in the background
      return '<path fill="' + fg + '" d="' + top(0, t1) + top(t2, s) + left(0, t1) + left(t2, s) + '"/><path fill="' + bg + '" d="' + top(t1, t2) + left(t1, t2) + '"/>';
    }
    if ((m = body.match(/^<path fill="(#[0-9A-F]{6})" d="M0 0H(\d+)A\2 \2 0 0 1 0 \2Z"\/>$/))) return '<path fill="' + m[1] + '" d="' + top(0, m[2]) + left(0, m[2]) + '"/>';   // quarter
    if ((m = body.match(/^<path fill="(#[0-9A-F]{6})" d="M0 0H(\d+)A(\d+) \3 0 0 1 0 0Z"\/>$/))) return '<path fill="' + m[1] + '" d="' + top(0, m[2]) + '"/>';            // half
    if ((m = body.match(/^<path fill="(#[0-9A-F]{6})" d="M0 0H(\d+)L0 \2Z"\/>$/))) {                                                                                      // diag, cut along its diagonal
      const s = Number(m[2]);
      return '<path fill="' + m[1] + '" d="M0 -2H' + s + 'V0L' + (s - 2) + ' 2H0ZM-2 0H2V' + (s - 2) + 'L0 ' + s + 'H-2Z"/>';
    }
    if (/^(<circle [^>]*\/>)*(<path fill="#[0-9A-F]{6}" d="M\d+ 0A[^"]*"\/>)?$/.test(body)) return '';                                                                    // disc, ring, dot, lens, solid
    throw new Error('seamRule: unknown module markup ' + body);
  };
  let leaves = 0;
  const out = svg.replace(/(<g transform="translate\(\d+ \d+\)">(?:<g class="lf" style="--i:\d+">)?)(<rect fill="#[0-9A-F]{6}" width="(\d+)" height="\3"\/>)?<g transform="rotate\((\d+) (\d+) \5\)">(.*?)<\/g>/g,
    (m, open, rect, w, rot, c, body) => {
      leaves++;
      return open + (rect || '<rect fill="' + ground + '" width="' + (2 * c + 2) + '" height="' + (2 * c + 2) + '"/>') +
        '<g transform="rotate(' + rot + ' ' + c + ' ' + c + ')">' + body + strips(body) + '</g>';
    });
  return [out, leaves];
}

/* ---------- 1. source rules ---------- */
section('source rules');
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/.*$/gm, '$1');
for (const [name, re] of [
  ['Math.pow', /Math\.pow\b/], ['** operator', /\*\*/], ['Math.sin/cos/tan', /Math\.(sin|cos|tan)\b/], ['Math.exp/log', /Math\.(exp|expm1|log\w*)\b/],
  ['Math.cbrt/sqrt/hypot/atan', /Math\.(cbrt|sqrt|hypot|atan2?|asin|acos)\b/], ['Math.random', /Math\.random\b/], ['Date', /\bDate\b/],
  ['locale', /toLocale|localeCompare|\bIntl\b/], ['performance', /\bperformance\b/]]) ok('no ' + name + ' in cover-v1.js', !re.test(code));
const nums = code.replace(/'[^'\n]*'|"[^"\n]*"/g, '""').match(/(?<![\w.$])(\d+\.\d*|\.\d+|\d+)(e[+-]?\d+)?(?![\w.])/gi) || [];
const longest = nums.reduce((m, n) => Math.max(m, n.replace(/e.*$/i, '').replace(/\D/g, '').replace(/^0+/, '').length), 0);
ok('every numeric literal has 17 significant digits or fewer (longest ' + longest + ')', longest <= 17);
eq('version', 'cover-v1', C.version);
eq('exports', ['contrast', 'css', 'grey', 'highlight', 'leaves', 'lineInk', 'luminance', 'mix', 'motion', 'night', 'palette', 'svg', 'version'], Object.keys(C).sort());
const sandbox = {};
vm.runInNewContext(SRC, sandbox);
ok('classic script defines ShelfCover', sandbox.ShelfCover && sandbox.ShelfCover.version === 'cover-v1');
eq('classic script output equals require output', C.svg(F.cases[0].hash), sandbox.ShelfCover.svg(F.cases[0].hash));
const throws = f => { try { f(); return false; } catch (e) { return true; } };
ok('rejects a short hash', throws(() => C.palette('abc')));
ok('rejects depth 4', throws(() => C.svg(F.cases[0].hash, { depth: 4 })));
ok('rejects a bad grey', throws(() => C.svg(F.cases[0].hash, { grey: 'mid' })));
ok('rejects a bad colour', throws(() => C.lineInk(F.cases[0].hash, 'white')));

/* ---------- 2. golden fixtures ---------- */
section('fixtures');
eq('fixture version', C.version, F.version);
ok('at least 50 cases', F.cases.length >= 50);
const leafOut = l => ({ x: l.x, y: l.y, s: l.s, d: l.d, mod: l.mod, rot: l.rot, bg: l.bg, fg: l.fg });
function compute(h) {
  const P = C.palette(h), N = C.night(h), out = {};
  out.palette = { ground: P.ground, deep: P.deep, soft: P.soft, signal: P.signal, hue: P.hue, scheme: P.scheme, dark: P.dark };
  out.leaves = { 1: C.leaves(h, { depth: 1 }).map(leafOut), 2: C.leaves(h, { depth: 2 }).map(leafOut), 3: C.leaves(h, { depth: 3 }).map(leafOut) };
  out.svg = { size64depth2: C.svg(h, F.svg.variants.size64depth2), sha256: {} };
  for (const k of Object.keys(F.svg.variants)) out.svg.sha256[k] = sha(C.svg(h, F.svg.variants[k]));
  out.lineInk = {};
  for (const k of Object.keys(F.surfaces)) out.lineInk[k] = C.lineInk(h, F.surfaces[k].bg, F.surfaces[k].text);
  out.lineInk.readerNight = N.line;
  out.highlight = {};
  for (const k of Object.keys(F.reading)) if (typeof F.reading[k] === 'object') out.highlight[k] = C.highlight(h, F.reading[k]);
  out.highlight.night = N.hl;
  out.night = { bg: N.bg, text: N.text, muted: N.muted, line: N.line, hl: N.hl };
  return out;
}
const byId = {};
for (const c of F.cases) {
  byId[c.id] = c;
  const got = compute(c.hash);
  for (const k of ['palette', 'leaves', 'svg', 'lineInk', 'highlight', 'night']) {
    if (k === 'leaves') for (const d of ['1', '2', '3']) eq(c.id + ' leaves depth ' + d, c.leaves[d], got.leaves[d]);
    else if (k === 'svg') { eq(c.id + ' svg size64depth2', c.svg.size64depth2, got.svg.size64depth2); eq(c.id + ' svg sha256', c.svg.sha256, got.svg.sha256); }
    else eq(c.id + ' ' + k, c[k], got[k]);
  }
  if (c.input != null) eq(c.id + ' hash is sha256 of input', c.hash, sha(c.input));
  // the two-argument lineInk uses the chrome's own text colour
  eq(c.id + ' lineInk default text on paper', c.lineInk.paper, C.lineInk(c.hash, F.surfaces.paper.bg));
  eq(c.id + ' lineInk default text on graphite', c.lineInk.graphite, C.lineInk(c.hash, F.surfaces.graphite.bg));
  eq(c.id + ' highlight array form', c.highlight.paper, C.highlight(c.hash, [F.reading.paper.bg, F.reading.paper.text]));
  eq(c.id + ' highlight three-argument form', c.highlight.sepia, C.highlight(c.hash, F.reading.sepia.bg, F.reading.sepia.text));
  eq(c.id + ' size only adds width and height', C.svg(c.hash).replace('<svg ', '<svg width="64" height="64" '), C.svg(c.hash, { size: 64 }));
}
if (byId['edge-upper-case'] && byId['seed-1']) for (const k of ['palette', 'leaves', 'svg', 'lineInk', 'highlight', 'night'])
  eq('upper-case hash equals seed-1: ' + k, byId['seed-1'][k], byId['edge-upper-case'][k]);
console.log('   ' + F.cases.length + ' cases');

/* ---------- 3. the board ---------- */
section('board equivalence');
if (!fs.existsSync(BOARD)) { fail('board not found at ' + BOARD, 'present', 'missing'); }
else {
  const html = fs.readFileSync(BOARD, 'utf8');
  const a = html.indexOf('/*GEN-START*/'), b = html.indexOf('/*GEN-END*/');
  const GEN = winterRule(html.slice(a, b));
  const FP = vm.runInNewContext(GEN + '\n;FP', { TextEncoder, URL });
  ok('the winter rule changes the board\'s palette (it is the stated difference)', vm.runInNewContext(html.slice(a, b) + '\n;FP', { TextEncoder, URL }).palette(F.cases[0].hash.toLowerCase()).ground !== FP.palette(F.cases[0].hash.toLowerCase()).ground);
  const greySrc = html.match(/const GREY = (\{[\s\S]*?\n\});/);
  const BGREY = vm.runInNewContext('(' + greySrc[1] + ')');
  eq('grey tables equal the board', JSON.parse(JSON.stringify(BGREY)), JSON.parse(JSON.stringify(C.grey)));
  // the board's sample addresses: its sha256 table against Node's, through its normalise
  const samples = [...html.matchAll(/(\w):\{k:'\w', src:'([^']+)'[^}]*?url:'([^']+)', hash:'([0-9a-f]{64})'/g)];
  ok('board has 8 sample articles', samples.length === 8);
  for (const m of samples) eq('board sample ' + m[1] + ' hash = sha256(normalise(url))', m[4], sha(FP.normalise(m[3])));
  const shelfUrl = html.match(/const SHELF_URL = '([^']+)'/)[1], shelfHash = html.match(/const SHELF_HASH = '([0-9a-f]{64})'/)[1];
  eq('board Shelf hash', shelfHash, sha(FP.normalise(shelfUrl)));
  const sampleHashes = samples.map(m => m[4]).concat([shelfHash]);
  for (const h of sampleHashes) ok('board sample ' + h.slice(0, 8) + ' is a fixture', F.cases.some(c => c.hash === h));

  const flat = roots => roots.reduce((o, r) => o.concat(r), []);
  // the module's SVG is the board's through the seam rule, with every leaf accounted for
  let ruleLeaves = 0, ruleBoardDiffers = 0;
  function svgVsBoard(what, boardSvg, moduleSvg, nLeaves) {
    const [ruled, n] = seamRule(boardSvg);
    eq(what + ' (board SVG through the seam rule)', ruled, moduleSvg);
    eq(what + ' leaves redrawn by the seam rule', nLeaves, n);
    ruleLeaves += n; if (ruled !== boardSvg) ruleBoardDiffers++;
  }
  function againstBoard(h, label) {
    const P = C.palette(h), B = FP.palette(h);
    for (const k of ['ground', 'deep', 'soft', 'signal', 'hue', 'scheme', 'dark']) eq(label + ' palette.' + k, B[k], P[k]);
    for (let d = 0; d <= 3; d++) {
      eq(label + ' leaves depth ' + d, flat(FP.layout(h, 1, d)), C.leaves(h, { depth: d }));
      svgVsBoard(label + ' svg depth ' + d, FP.svg(h, { maxDepth: d }), C.svg(h, { depth: d }), C.leaves(h, { depth: d }).length);
    }
    eq(label + ' leaves cols 3', flat(FP.layout(h, 3, 3)), C.leaves(h, { cols: 3 }));
    const n1 = C.leaves(h).length, n3 = C.leaves(h, { cols: 3 }).length;
    svgVsBoard(label + ' svg', FP.svg(h), C.svg(h), n1);
    svgVsBoard(label + ' svg draw', FP.svg(h, { draw: true }), C.svg(h, { draw: true }), n1);
    svgVsBoard(label + ' svg cols 3', FP.svg(h, { cols: 3 }), C.svg(h, { cols: 3 }), n3);
    svgVsBoard(label + ' svg cols 3 draw', FP.svg(h, { cols: 3, draw: true }), C.svg(h, { cols: 3, draw: true }), n3);
    svgVsBoard(label + ' svg grey light', FP.svg(h, { palette: BGREY.light }), C.svg(h, { grey: 'light' }), n1);
    svgVsBoard(label + ' svg grey dark', FP.svg(h, { palette: BGREY.dark }), C.svg(h, { grey: 'dark' }), n1);
    for (const k of Object.keys(F.surfaces)) eq(label + ' lineInk ' + k, FP.lineInk(h, F.surfaces[k].bg, F.surfaces[k].text), C.lineInk(h, F.surfaces[k].bg, F.surfaces[k].text));
    for (const k of Object.keys(F.reading)) if (typeof F.reading[k] === 'object') eq(label + ' highlight ' + k, FP.highlight(h, F.reading[k].bg, F.reading[k].text), C.highlight(h, F.reading[k]));
    eq(label + ' night', FP.night(h), C.night(h));
  }
  for (const c of F.cases) againstBoard(c.hash.toLowerCase(), c.id);
  for (let i = 0; i < 1000; i++) againstBoard(sha('shelf-cover-check-' + i), 'check-' + i);
  console.log('   board samples ' + sampleHashes.length + ', fixture hashes ' + F.cases.length + ', further hashes 1000');
  console.log('   SVGs equal to the board\'s through the seam rule: ' + ruleLeaves + ' leaves redrawn; the rule changed ' + ruleBoardDiffers + ' of the board\'s SVGs');
  ok('the seam rule changes the board\'s SVG (it is the stated difference)', ruleBoardDiffers > 0);

  if (EXHAUSTIVE) {
    section('exhaustive (about two minutes)');
    const t0 = Date.now(), h2 = n => (n < 16 ? '0' : '') + n.toString(16), tail = '0'.repeat(56);
    let fresh = FP, pal = 0;
    for (let hue = 0; hue < 65536; hue++) {
      if ((hue & 4095) === 0) fresh = vm.runInNewContext(GEN + '\n;FP', { TextEncoder, URL }); // the board caches every palette
      // byte 3 = 79 (the last dark ground) and 80 (the first light one): every palette input, both sides of the boundary
      for (let s = 0; s < 4; s++) for (const g of ['4f', '50']) {
        const h = h2(hue >> 8) + h2(hue & 255) + h2(s) + g + tail, P = C.palette(h), B = fresh.palette(h); pal++; checks++;
        if (P.ground !== B.ground || P.deep !== B.deep || P.soft !== B.soft || P.signal !== B.signal || P.hue !== B.hue || P.dark !== B.dark || P.scheme !== B.scheme) fail('exhaustive palette ' + h.slice(0, 8), B, P);
      }
    }
    console.log('   palettes ' + pal + ' (every input: 65,536 hues x 4 schemes x dark and light)');
    for (let hue = 150; hue <= 320; hue++) {
      // Night takes the palette's hue in whole degrees, 150 to 320 under the winter rule: find bytes 0-1 that round to it
      let hh = -1;
      for (let v = Math.max(0, Math.floor((hue - 150.5) * 65536 / 170)); v < 65536 && hh < 0; v++) if (Math.round(150 + v / 65536 * 170) === hue) hh = v;
      const h = h2(hh >> 8) + h2(hh & 255) + '0000' + tail;
      eq('exhaustive night hue ' + hue, FP.night(h), C.night(h));
    }
    console.log('   Night hues 150-320');
    let lumN = 0;
    for (let r = 0; r < 256; r++) for (let g = 0; g < 256; g++) {
      const pre = '#' + h2(r).toUpperCase() + h2(g).toUpperCase();
      for (let bb = 0; bb < 256; bb++) { const hex = pre + h2(bb).toUpperCase(); lumN++; if (C.luminance(hex) !== FP.lum(hex)) fail('exhaustive luminance ' + hex, FP.lum(hex), C.luminance(hex)); }
    }
    checks += lumN;
    console.log('   luminance of ' + lumN + ' colours');
    console.log('   ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s');
  }
}

/* ---------- 5. the served copy ---------- */
section('served copy');
if (fs.existsSync(MIRROR)) {
  const m = fs.readFileSync(MIRROR, 'utf8'), body = m.slice(m.indexOf('\n') + 1);
  ok('docs/design/mockups/cover-v1.js is generated from the source (run node shared/cover/build.mjs)', /generated/i.test(m.slice(0, m.indexOf('\n'))) && body === SRC);
} else console.log('   not built yet (node shared/cover/build.mjs)');

console.log((failures ? 'FAILED ' + failures + ' of ' : 'PASS ') + checks + ' checks' + (EXHAUSTIVE ? ' (exhaustive)' : ''));
process.exit(failures ? 1 : 0);
