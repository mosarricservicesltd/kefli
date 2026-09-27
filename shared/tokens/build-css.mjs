// Generates CSS custom properties from tokens.json for the HTML mockups
// (and later the extension and website).
//
//   node shared/tokens/build-css.mjs
//
// Light values sit on :root; dark values apply under prefers-color-scheme,
// and either can be forced with data-theme="light" | "dark" on any element.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const t = JSON.parse(readFileSync(join(here, 'tokens.json'), 'utf8'));

const colourVars = (set) =>
  Object.entries(set).map(([k, v]) => `  --${k}: ${v};`).join('\n');

const lines = [
  `/* Generated from shared/tokens/tokens.json (v${t.$version}) by build-css.mjs. Do not edit. */`,
  ':root, [data-theme="light"] {',
  colourVars(t.color.light),
  `  --shadow-card: ${t.shadow.card.map((s) => `${s.x}px ${s.y}px ${s.blur}px ${s.color}`).join(', ')};`,
  '  --card-edge: none;',
  '}',
  '[data-theme="dark"] {',
  colourVars(t.color.dark),
  '  --shadow-card: none;',
  `  --card-edge: 1px solid ${t.color.dark.line};`,
  '}',
  '@media (prefers-color-scheme: dark) {',
  '  :root:not([data-theme="light"]) {',
  colourVars(t.color.dark).replace(/^/gm, '  '),
  '    --shadow-card: none;',
  `    --card-edge: 1px solid ${t.color.dark.line};`,
  '  }',
  '}',
  ':root {',
  '  --on-gradient: #FFFFFF;',
  `  --gradient-primary: linear-gradient(${t.gradient.primary.angle}deg, ${t.gradient.primary.from}, ${t.gradient.primary.to});`,
  ...t.type.ui.sizes.map((s) => `  --text-${s}: ${s}px;`),
  `  --reader-size: ${t.type.reader.size}px;`,
  `  --reader-leading: ${t.type.reader.lineHeight};`,
  ...t.space.map((s) => `  --space-${s}: ${s}px;`),
  `  --radius: ${t.radius.container}px;`,
  `  --radius-pill: ${t.radius.pill}px;`,
  `  --radius-sheet: ${t.radius.sheet}px;`,
  "  --font-ui: Inter, Roboto, system-ui, sans-serif;",
  "  --font-reader: 'Noto Serif', Georgia, serif;",
  '}',
  ...Object.entries(t.type.reader.palette).map(([name, c]) =>
    `[data-reader="${name}"] { --reader-bg: ${c.bg}; --reader-text: ${c.text}; --reader-muted: ${c.muted}; --reader-link: ${c.link}; --reader-highlight: ${c.highlight}; }`),
  '',
];

const out = join(repo, 'docs', 'design', 'mockups', 'tokens.css');
writeFileSync(out, lines.join('\n'));
console.log(`wrote ${out}`);
