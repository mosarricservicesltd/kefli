// The parser runner (shared/vendor/parser-runner.js) normalises Markdown in the browser engine, and
// packages/protocol hashes it on the phone: the two rules must be the same (contract 4.2).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { normaliseMarkdown } from '../src';

const runner = readFileSync(join(__dirname, '../../../shared/vendor/parser-runner.js'), 'utf8');
const window: Record<string, unknown> = {};
runInNewContext(runner, { window });
const runnerNormalise = window.kefliNormaliseMarkdown as (md: string) => string;

test.each([
  ['plain', 'one\ntwo'],
  ['CRLF and trailing space', '# T  \r\n\r\n\r\nPara \t\r\nnext\n\n\n\n'],
  ['NFC', 'café and Å'],
  ['lone CR and line separators kept', 'a \rb c  d  '],
  ['empty', ''],
  ['only newlines', '\n\n\n\n'],
  ['no-break space at a line end kept', 'x \ny'],
])('%s', (_name, md) => {
  expect(runnerNormalise(md)).toBe(normaliseMarkdown(md));
});
