import { transformSync } from '@babel/core';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stripConsole } = require('../babel.config.js');

const strip = (code: string) => transformSync(code, { plugins: [stripConsole], babelrc: false, configFile: false })!.code;

describe('release builds strip console below warn (mobile spec 7.1)', () => {
  test('log, info, debug and trace go; warn and error stay', () => {
    const out = strip("console.log('[kefli-save]', title); console.info(1); console.debug(2); console.trace(); console.warn('w'); console.error('e');");
    expect(out).not.toMatch(/console\.(log|info|debug|trace)/);
    expect(out).toContain("console.warn('w')");
    expect(out).toContain("console.error('e')");
  });

  test('a log used as a value becomes undefined; other objects are untouched', () => {
    expect(strip('const x = console.log(1); logger.log(2);')).toBe('const x = undefined;\nlogger.log(2);');
  });
});
