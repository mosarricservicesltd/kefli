// Generates packages/tokens/src from tokens.json for the app (mobile spec 6.2).
//
//   node shared/tokens/build-ts.mjs           write the files
//   node shared/tokens/build-ts.mjs --check   exit 1 if the committed files are stale (CI)
//
// index.ts is plain data with no dependencies: colours for both themes, type roles that name font
// families rather than weights (the app bundles one static cut per family, mobile spec 6.3), space,
// radii, cover greys and motion as numbers and Bézier tuples. reanimated.ts turns the motion into
// Reanimated configs, so only code that imports it needs react-native-reanimated.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const outDir = join(repo, 'packages', 'tokens', 'src');
const t = JSON.parse(readFileSync(join(here, 'tokens.json'), 'utf8'));
const ty = t.type;
const mo = t.motion;

const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const camelKeys = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [camel(k), v]));
const em = (s) => {
  const m = /^(-?[\d.]+)em$/.exec(s);
  if (!m) throw new Error(`expected an em value, got ${s}`);
  return Number(m[1]);
};
const round = (n) => Math.round(n * 1000) / 1000;

// Easing as a cubic Bézier tuple, or 'linear'. CSS keywords are given their spec curves.
const bezier = (e) => {
  if (e === 'linear') return 'linear';
  if (e === 'ease-in-out') return [0.42, 0, 0.58, 1];
  const m = /^cubic-bezier\(([^)]+)\)$/.exec(e);
  if (!m) throw new Error(`unknown easing ${e}`);
  return m[1].split(',').map(Number);
};
const timing = (m) => ({ duration: m.duration, easing: bezier(m.easing) });

// One static cut per family (mobile spec 6.3). None of the three OFL licences reserves a font name,
// so the cuts keep their families' names.
const W = ty.ui.weights;
const fontFamily = {
  ui: Object.fromEntries(Object.entries(W).map(([role, w]) => [role, `Archivo-${w}`])),
  articleTitle: `Archivo-${ty.articleTitle.weight}`,
  display: `ArchivoExpanded-${ty.display.weight}`,
  mono: `MartianMono-${ty.mono.weight}`,
  reader: {
    regular: `Literata-${ty.reader.opticalSize}-${ty.reader.weights.regular}`,
    italic: `Literata-${ty.reader.opticalSize}-${ty.reader.italicWeights[0]}-Italic`,
    bold: `Literata-${ty.reader.opticalSize}-${ty.reader.weights.bold}`,
  },
  readerWord: {
    regular: `Literata-${ty.reader.word.opticalSize}-${ty.reader.word.weights.regular}`,
    focus: `Literata-${ty.reader.word.opticalSize}-${ty.reader.word.weights.focus}`,
  },
};
// The cuts the font build must produce: family name to the variable-font axes it pins. An axis not named
// stays at the font's default (Martian Mono's width is 112.5, as the prototype draws it).
const fontCuts = {
  ...Object.fromEntries(Object.values(W).map((w) => [`Archivo-${w}`, { source: 'Archivo', wght: w, wdth: 100 }])),
  [`Archivo-${ty.articleTitle.weight}`]: { source: 'Archivo', wght: ty.articleTitle.weight, wdth: 100 },
  [fontFamily.display]: { source: 'Archivo', wght: ty.display.weight, wdth: parseFloat(ty.display.stretch) },
  [fontFamily.mono]: { source: 'Martian Mono', wght: ty.mono.weight },
  [fontFamily.reader.regular]: { source: 'Literata', wght: ty.reader.weights.regular, opsz: ty.reader.opticalSize },
  [fontFamily.reader.italic]: { source: 'Literata Italic', wght: ty.reader.italicWeights[0], opsz: ty.reader.opticalSize },
  [fontFamily.reader.bold]: { source: 'Literata', wght: ty.reader.weights.bold, opsz: ty.reader.opticalSize },
  [fontFamily.readerWord.regular]: { source: 'Literata', wght: ty.reader.word.weights.regular, opsz: ty.reader.word.opticalSize },
  [fontFamily.readerWord.focus]: { source: 'Literata', wght: ty.reader.word.weights.focus, opsz: ty.reader.word.opticalSize },
};

// React Native takes line height and letter spacing in px, so roles carry them resolved for their size.
const role = (family, size, lineHeight, letterSpacing = 0) => ({
  fontFamily: family,
  fontSize: size,
  lineHeight: round(size * lineHeight),
  letterSpacing: round(size * letterSpacing),
});

const shadow = (list) =>
  list.map((s) => `${s.x}px ${s.y}px ${s.blur}px ${s.spread ? `${s.spread}px ` : ''}${s.color}`).join(', ');
const theme = (name) => ({
  ...camelKeys(t.color[name]),
  scrim: t.scrim[name],
  shadowFloat: shadow(t.shadow.float[name]),
  coverEdge: t.cover.edge[name],
  coverGrey: t.cover.grey[name],
});

const data = {
  version: t.$version,
  colors: { light: theme('light'), dark: theme('dark') },
  reader: {
    themes: ty.reader.themes,
    palette: Object.fromEntries(ty.reader.themes.map((n) => [n, camelKeys(ty.reader.palette[n])])),
    nightTint: ty.reader.night.tint,
    floatRingMix: t.shadow.float.reader.ringMix,
    floatShadow: shadow([t.shadow.float.reader.shadow]),
    size: ty.reader.size,
    sizeRange: ty.reader.sizeRange,
    lineHeight: ty.reader.lineHeight,
  },
  article: t.article,
  fontFamily,
  fontCuts,
  type: {
    ui: {
      sizes: ty.ui.sizes,
      lineHeight: ty.ui.lineHeight,
    },
    display: Object.fromEntries(
      ty.ui.sizes.filter((s) => s >= 28).map((s) => [s, role(fontFamily.display, s, ty.display.lineHeight, em(ty.display.letterSpacing))]),
    ),
    articleTitle: role(fontFamily.articleTitle, ty.articleTitle.size, ty.articleTitle.lineHeight, em(ty.articleTitle.letterSpacing)),
    mono: role(fontFamily.mono, ty.mono.size, ty.ui.lineHeight, em(ty.mono.letterSpacing)),
    readerWord: role(fontFamily.readerWord.regular, ty.reader.word.size, ty.reader.word.lineHeight),
  },
  space: Object.fromEntries(t.space.map((s) => [s, s])),
  gap: t.gap,
  radius: t.radius,
  focus: { width: t.focus.width, offset: t.focus.offset },
  icons: { stroke: t.icons.stroke, customDigitStroke: t.icons.customDigitStroke },
  motion: {
    enter: timing(mo.enter),
    exit: timing(mo.exit),
    quickIn: timing(mo.quick.in),
    quickOut: timing(mo.quick.out),
    reflow: timing(mo.reflow),
    press: { listDelay: mo.press.listDelay, out: timing(mo.quick.out), layer: {
      page: mo.press.layer.page.opacity, fill: mo.press.layer.fill.opacity, reader: mo.press.layer.reader.opacity,
    } },
    mark: { ...timing(mo.mark), fromScale: mo.mark.fromScale, fromOpacity: mo.mark.fromOpacity },
    release: mo.release.spring,
    draw: { ...timing(mo.draw), stagger: mo.draw.stagger },
    catchUp: { ...timing(mo.catchUp), delay: mo.catchUp.delay, threshold: mo.catchUp.threshold,
      finish: { ...timing(mo.catchUp.finish), delay: mo.catchUp.finish.delay } },
    countdown: { toast: mo.countdown.toast, share: mo.countdown.share, extension: mo.countdown.extension },
    ambient: {
      delay: mo.ambient.delay,
      breathe: { ...timing(mo.ambient.breathe), opacity: mo.ambient.breathe.opacity, phase: mo.ambient.breathe.phase },
      pulse: { ...timing(mo.ambient.pulse), opacity: mo.ambient.pulse.opacity },
      sweep: { ...timing(mo.ambient.sweep), segment: mo.ambient.sweep.segment },
      scan: { ...timing(mo.ambient.scan) },
      eq: { ...timing(mo.ambient.eq) },
    },
    launch: { hold: mo.launch.hold, in: { ...timing(mo.launch.in), delay: mo.launch.in.delay }, out: timing(mo.launch.out) },
  },
};

const header = `// Generated from shared/tokens/tokens.json (v${t.$version}, ${t.style}) by shared/tokens/build-ts.mjs. Do not edit.\n`;
const lit = (v) => JSON.stringify(v, null, 2);

const index = `${header}
export const version = ${lit(data.version)} as const;

/** Chrome colours per app theme, plus the scrim, the float shadow (a boxShadow string) and the cover greys. */
export const colors = ${lit(data.colors)} as const;
export type ThemeName = keyof typeof colors;
export type ThemeColors = (typeof colors)[ThemeName];

/** Reading palettes for the Aa sheet. Night is tinted per article by ShelfCover.night(); these are its zero-chroma values. */
export const reader = ${lit(data.reader)} as const;

/** Article ink and spoken-word highlight rules, applied by ShelfCover.lineInk() and highlight(). */
export const article = ${lit(data.article)} as const;

/** One expo-font family per static cut. Use these with fontWeight left unset, so Android never synthesises a weight. */
export const fontFamily = ${lit(data.fontFamily)} as const;

/** The cuts the font build makes from the variable faces (fontTools varLib.instancer), keyed by family. */
export const fontCuts = ${lit(data.fontCuts)} as const;

/** UI text: the family for a weight role at one of the scale's sizes, with line height and spacing in px. */
export type UiWeight = keyof typeof fontFamily.ui;
export type UiSize = (typeof type.ui.sizes)[number];
export function uiText(size: UiSize, weight: UiWeight) {
  return { fontFamily: fontFamily.ui[weight], fontSize: size, lineHeight: size * type.ui.lineHeight, letterSpacing: 0 };
}

/** Reader body text at the Aa sheet's size (reader.sizeRange); the cut stays at its fixed optical size. */
export function readerText(size: number = reader.size, face: keyof typeof fontFamily.reader = 'regular') {
  return { fontFamily: fontFamily.reader[face], fontSize: size, lineHeight: size * reader.lineHeight, letterSpacing: 0 };
}

export const type = ${lit(data.type)} as const;

export const space = ${lit(data.space)} as const;
export const gap = ${lit(data.gap)} as const;
export const radius = ${lit(data.radius)} as const;
export const focus = ${lit(data.focus)} as const;
export const icons = ${lit(data.icons)} as const;

/** Motion (docs/design/motion-spec.md). Easings are cubic Bézier tuples or 'linear'; release is the one spring. */
export const motion = ${lit(data.motion)} as const;
`;

const reanimated = `${header}
// Motion as Reanimated configs. Each token's use text in tokens.json says where it applies and what
// reduced motion does; this module only turns the numbers into configs.

import { Easing } from 'react-native-reanimated';
import type { WithSpringConfig, WithTimingConfig } from 'react-native-reanimated';
import { motion } from './index';

type Timing = { readonly duration: number; readonly easing: 'linear' | readonly number[] };

export function easing(e: Timing['easing']) {
  if (e === 'linear') return Easing.linear;
  const [x1, y1, x2, y2] = e;
  return Easing.bezier(x1, y1, x2, y2);
}

export function timing(m: Timing): WithTimingConfig {
  return { duration: m.duration, easing: easing(m.easing) };
}

export const enter = timing(motion.enter);
export const exit = timing(motion.exit);
export const quickIn = timing(motion.quickIn);
export const quickOut = timing(motion.quickOut);
export const reflow = timing(motion.reflow);
export const pressOut = timing(motion.press.out);
export const mark = timing(motion.mark);
export const catchUp = timing(motion.catchUp);
export const catchUpFinish = timing(motion.catchUp.finish);
export const launchIn = timing(motion.launch.in);
export const launchOut = timing(motion.launch.out);

/** The release spring; pass the gesture's velocity alongside it. */
export const release: WithSpringConfig = { ...motion.release };

/** Ambient loops: breathe, pulse and eq go there and back within one CSS cycle, so each leg is half of it. */
export const ambient = {
  breathe: timing({ ...motion.ambient.breathe, duration: motion.ambient.breathe.duration / 2 }),
  pulse: timing({ ...motion.ambient.pulse, duration: motion.ambient.pulse.duration / 2 }),
  eq: timing({ ...motion.ambient.eq, duration: motion.ambient.eq.duration / 2 }),
  scan: timing(motion.ambient.scan),
  sweep: timing(motion.ambient.sweep),
};
`;

const files = { 'index.ts': index, 'reanimated.ts': reanimated };
// The font build (shared/fonts/cut-fonts.py) reads the same list.
const cutsPath = join(repo, 'shared', 'fonts', 'cuts.json');
const cutsBody = `${JSON.stringify({ $generated: header.trim().replace(/^\/\/ /, ''), cuts: fontCuts }, null, 2)}\n`;
const check = process.argv.includes('--check');
let stale = 0;
mkdirSync(outDir, { recursive: true });
const outputs = [...Object.entries(files).map(([name, body]) => [join(outDir, name), body]), [cutsPath, cutsBody]];
for (const [path, body] of outputs) {
  if (check) {
    let current = '';
    try { current = readFileSync(path, 'utf8'); } catch {}
    if (current !== body) { console.error(`stale: ${relative(repo, path)}`); stale++; }
  } else {
    writeFileSync(path, body);
    console.log(`wrote ${relative(repo, path)}`);
  }
}
if (check) {
  if (stale) { console.error('run: node shared/tokens/build-ts.mjs'); process.exit(1); }
  console.log(`packages/tokens is current with tokens ${t.$version}`);
}
