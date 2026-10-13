import { transformFileSync, transformFromAstSync, type PluginObj, type types } from '@babel/core';
import { join } from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { constantFoldingPlugin } = require('metro-transform-plugins');

const GATES = join(__dirname, '../src/app/gates.tsx');

/** What babel.config.js does for the variant: process.env.KEFLI_VARIANT becomes the build's own, as a literal. */
const inlineVariant = (variant: string) => ({ types: t }: { types: typeof types }): PluginObj => ({
  visitor: {
    MemberExpression(path) {
      if (path.matchesPattern('process.env.KEFLI_VARIANT')) path.replaceWith(t.stringLiteral(variant));
    },
  },
});

/**
 * The route as Metro bundles it in a build that isn't dev: babel-preset-expo with the variant inlined, then Metro's
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
    plugins: variant === null ? [] : [inlineVariant(variant)],
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

  test('a bundle without the variant inlined keeps them, and the variant the build recorded decides at run time', () => {
    const code = bundled(null);
    expect(code).toMatch(/require\(["']\.\.\/Root["']\)/);
    expect(code).toContain('LOCAL_STACK');
  });
});
