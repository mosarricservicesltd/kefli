import { transformFileSync, transformFromAstSync, transformSync } from '@babel/core';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { constantFoldingPlugin } = require('metro-transform-plugins');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const babelConfig = require('../babel.config.js');

const GATES = join(__dirname, '../src/app/gates.tsx');
/** The plugins babel.config.js gives a build of the variant, KEFLI_VARIANT set as the build sets it. */
function configPlugins(variant: string | undefined): unknown[] {
  const saved = process.env.KEFLI_VARIANT;
  if (variant === undefined) delete process.env.KEFLI_VARIANT;
  else process.env.KEFLI_VARIANT = variant;
  try {
    return (babelConfig({ cache: { using: () => undefined } }) as { plugins: unknown[] }).plugins;
  } finally {
    if (saved === undefined) delete process.env.KEFLI_VARIANT;
    else process.env.KEFLI_VARIANT = saved;
  }
}

/**
 * The route as Metro bundles it in a build that isn't dev: babel-preset-expo with babel.config.js's plugins, then Metro's
 * constant folding, which runs before it collects dependencies (@expo/metro-config's transform worker, transformJS).
 * A require left in the output is a module in the bundle.
 */
function bundled(variant: string | null): string {
  const out = transformFileSync(GATES, {
    babelrc: false,
    configFile: false,
    ast: true,
    caller: { name: 'metro', bundler: 'metro', platform: 'android', isDev: false } as never,
    presets: ['babel-preset-expo'],
    plugins: (variant === null ? [] : configPlugins(variant)) as never[],
  });
  return transformFromAstSync(out!.ast!, '', { babelrc: false, configFile: false, code: true, plugins: [constantFoldingPlugin] })!.code!;
}

describe('the development gates stay out of release bundles (F51)', () => {
  test('a release build folds the check away, so Root and the fixtures behind it are never required', () => {
    const code = bundled('release');
    expect(code).not.toMatch(/require\(["']\.\.\/Root["']\)/);
    expect(code).toContain('Redirect');
  });

  test('the local build keeps them', () => {
    expect(bundled('local')).toMatch(/require\(["']\.\.\/Root["']\)/);
  });

  test('babel.config.js inlines the variant in every build, release when KEFLI_VARIANT isn’t local', () => {
    const literal = (variant: string | undefined) =>
      transformSync('const v = process.env.KEFLI_VARIANT;', { babelrc: false, configFile: false, plugins: [configPlugins(variant)[0] as never] })!.code;
    expect(literal(undefined)).toContain('"release"');
    expect(literal('local')).toContain('"local"');
    expect(literal('anything')).toContain('"release"');
    expect(configPlugins('local')).toHaveLength(1);
    expect(configPlugins(undefined)).toHaveLength(2);
  });

  test('a bundle without the variant inlined keeps them, and the variant the build recorded decides at run time', () => {
    const code = bundled(null);
    expect(code).toMatch(/require\(["']\.\.\/Root["']\)/);
    expect(code).toContain('LOCAL_STACK');
  });
});
