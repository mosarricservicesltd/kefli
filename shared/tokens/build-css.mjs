// Generates CSS custom properties from tokens.json for the HTML mockups
// (and later the website; the extension and the app bundle their fonts instead of importing them).
//
//   node shared/tokens/build-css.mjs
//
// Light values sit on :root; dark values apply under prefers-color-scheme,
// and either can be forced with data-theme="light" | "dark" on any element.
// Reading palettes apply with data-reader="<id>" (the Aa sheet's ids: light, sepia, dark).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const t = JSON.parse(readFileSync(join(here, 'tokens.json'), 'utf8'));

const shadow = (list) =>
  list.map((s) => `${s.x}px ${s.y}px ${s.blur}px ${s.spread ? `${s.spread}px ` : ''}${s.color}`).join(', ');

// Everything that changes with the theme, in the order the roles are listed in tokens.json.
const themeVars = (name) => [
  ...Object.entries(t.color[name]).map(([k, v]) => `--${k}: ${v};`),
  `--card-edge: 1px solid ${t.color[name].line};`,
  `--shadow-float: ${shadow(t.shadow.float[name])};`,
  `--scrim: ${t.scrim[name]};`,
  `--cover-edge: ${t.cover.edge[name]};`,
  ...Object.entries(t.cover.grey[name]).map(([k, v]) => `--cover-grey-${k}: ${v};`),
];
const block = (selector, vars, indent = '') =>
  [`${indent}${selector} {`, ...vars.map((v) => `${indent}  ${v}`), `${indent}}`];

const ty = t.type;
const rf = t.shadow.float.reader;
const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const ms = (m) => `${m.duration}ms ${m.easing}`;
const pct = (o) => `${Math.round(o * 100)}%`;

// Motion (docs/design/motion-spec.md, flow decision 73). A timing token is "<duration> <easing>", ready for a transition
// or animation shorthand; delays, phases and press layers are separate. Names are the spec's where it gives one, otherwise
// the token's path. motion.instant has no property (no transition), and the first-run scaffold uses ShelfCover.css.
// The Reanimated values are in each token's use text in tokens.json.
const mo = t.motion;
const motionVars = [
  `--motion-enter: ${ms(mo.enter)};`,
  `--motion-exit: ${ms(mo.exit)};`,
  `--motion-quick-in: ${ms(mo.quick.in)};`,
  `--motion-quick-out: ${ms(mo.quick.out)};`,
  `--motion-reflow: ${ms(mo.reflow)};`,
  `--motion-press-delay: ${mo.press.listDelay}ms;`,
  `--motion-press-layer: ${pct(mo.press.layer.page.opacity)};`,
  `--motion-press-layer-fill: ${pct(mo.press.layer.fill.opacity)};`,
  `--motion-press-layer-reader: ${pct(mo.press.layer.reader.opacity)};`,
  `--motion-mark: ${ms(mo.mark)};`,
  `/* motion.release is the spring from rest as linear(), for the prototypes; the app uses the spring itself */`,
  `--motion-release: ${ms(mo.release)};`,
  `--motion-draw: ${ms(mo.draw)};`,
  `--motion-draw-stagger: ${mo.draw.stagger}ms;`,
  `--motion-catchup: ${ms(mo.catchUp)};`,
  `--motion-catchup-delay: ${mo.catchUp.delay}ms;`,
  `--motion-catchup-finish: ${ms(mo.catchUp.finish)};`,
  `--motion-catchup-finish-delay: ${mo.catchUp.finish.delay}ms;`,
  ...['toast', 'share', 'extension'].map(
    (k) => `--motion-countdown-${k}: ${ms({ duration: mo.countdown[k], easing: mo.countdown.easing })};`,
  ),
  `--motion-ambient-delay: ${mo.ambient.delay}ms;`,
  `--motion-ambient-breathe: ${ms(mo.ambient.breathe)};`,
  `--motion-ambient-breathe-phase: ${mo.ambient.breathe.phase}ms;`,
  ...['pulse', 'sweep', 'scan', 'eq'].map((k) => `--motion-ambient-${k}: ${ms(mo.ambient[k])};`),
];

const staticVars = [
  `--font-ui: ${ty.ui.stack};`,
  `--font-display: ${ty.display.stack};`,
  `--font-display-stretch: ${ty.display.stretch};`,
  `--font-display-weight: ${ty.display.weight};`,
  `--font-display-tracking: ${ty.display.letterSpacing};`,
  `--font-article-title: ${ty.articleTitle.stack};`,
  `--font-article-title-stretch: ${ty.articleTitle.stretch};`,
  `--font-article-title-weight: ${ty.articleTitle.weight};`,
  `--font-article-title-tracking: ${ty.articleTitle.letterSpacing};`,
  `--font-mono: ${ty.mono.stack};`,
  `--font-mono-weight: ${ty.mono.weight};`,
  `--font-mono-tracking: ${ty.mono.letterSpacing};`,
  `--font-reader: ${ty.reader.stack};`,
  ...ty.ui.sizes.map((s) => `--text-${s}: ${s}px;`),
  `--leading-ui: ${ty.ui.lineHeight};`,
  `--leading-display: ${ty.display.lineHeight};`,
  `--leading-article-title: ${ty.articleTitle.lineHeight};`,
  ...Object.entries(ty.ui.weights).map(([k, v]) => `--weight-${kebab(k)}: ${v};`),
  `--reader-size: ${ty.reader.size}px;`,
  `--reader-leading: ${ty.reader.lineHeight};`,
  // Literata's optical sizes are fixed (tokens 1.0.1): set font-variation-settings: 'opsz' from these, not font-optical-sizing: auto.
  `--reader-opsz: ${ty.reader.opticalSize};`,
  ...Object.entries(ty.reader.weights).map(([k, v]) => `--reader-weight-${kebab(k)}: ${v};`),
  `--reader-word-size: ${ty.reader.word.size}px;`,
  `--reader-word-leading: ${ty.reader.word.lineHeight};`,
  `--reader-word-opsz: ${ty.reader.word.opticalSize};`,
  ...Object.entries(ty.reader.word.weights).map(([k, v]) => `--reader-word-weight-${kebab(k)}: ${v};`),
  ...t.space.map((s) => `--space-${s}: ${s}px;`),
  `--gap-card: ${t.gap.card}px;`,
  `--radius: ${t.radius.container}px;`,
  `--radius-image: ${t.radius.image}px;`,
  `--radius-control: ${t.radius.control}px;`,
  `--radius-button: ${t.radius.button}px;`,
  `--radius-sheet: ${t.radius.sheet}px;`,
  `--radius-pill: ${t.radius.pill}px;`,
  `--focus-width: ${t.focus.width}px;`,
  `--focus-offset: ${t.focus.offset}px;`,
  `--icon-stroke: ${t.icons.stroke};`,
  ...motionVars,
];

// Reader palettes. The cover module overrides --reader-bg, --reader-text and --reader-muted for Night, and --reader-ink and
// --reader-highlight for every palette, per article, on the [data-reader] element. Roles that equal the palette's text or page
// (the fill rule: fill and focus are the text, on-fill is the page) are emitted as references, so they follow that tint.
// --reader-float resolves against the same element's --reader-muted for the same reason.
const readerValue = (p, k) =>
  k !== 'text' && p[k] === p.text ? 'var(--reader-text)' : k !== 'bg' && p[k] === p.bg ? 'var(--reader-bg)' : p[k];
const readerVars = (p) => [
  ...['bg', 'text', 'muted', 'link', 'ink', 'highlight', 'fill', 'on-fill', 'focus'].map((k) => `--reader-${k}: ${readerValue(p, k)};`),
  `--reader-float: 0px 0px 0px 1px color-mix(in srgb, var(--reader-muted) ${Math.round(rf.ringMix * 100)}%, transparent), ${shadow([rf.shadow])};`,
];

const lines = [
  `/* Generated from shared/tokens/tokens.json (v${t.$version}, ${t.style}) by build-css.mjs. Do not edit. */`,
  `/* Web fonts for the mockups and the website only; the app and the extension bundle the font files. */`,
  `@import url('${t.fonts.web}');`,
  ...block(':root, [data-theme="light"]', themeVars('light')),
  ...block('[data-theme="dark"]', themeVars('dark')),
  '@media (prefers-color-scheme: dark) {',
  ...block(':root:not([data-theme="light"])', themeVars('dark'), '  '),
  '}',
  ...block(':root', staticVars),
  ...ty.reader.themes.flatMap((name) => {
    const p = ty.reader.palette[name];
    return block(`[data-reader="${p.id}"]`, [`/* ${name}, labelled ${p.label} */`, ...readerVars(p)]);
  }),
  '',
];

const out = join(repo, 'docs', 'design', 'mockups', 'tokens.css');
writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out}`);

// The website serves its own font files, so a visit asks no third party for anything: the same tokens,
// with the Google Fonts import swapped for apps/web's fonts.css (made by apps/web/scripts/fonts.mjs).
const webLines = lines.map((l) =>
  l.startsWith('@import') ? `@import './fonts.css';`
  : l.startsWith('/* Web fonts for') ? `/* The website's copy: the fonts are self-hosted from shared/fonts/src (apps/web/scripts/fonts.mjs). */`
  : l);
const webOut = join(repo, 'apps', 'web', 'src', 'styles', 'tokens.css');
writeFileSync(webOut, webLines.join('\n'));
console.log(`wrote ${webOut}`);
