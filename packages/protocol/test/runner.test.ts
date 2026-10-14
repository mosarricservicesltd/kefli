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
  ['a long run of spaces inside a line', 'a' + ' '.repeat(80_000) + 'b \t'],
  ['deep indentation, as a nested list', Array.from({ length: 500 }, (_, i) => ' '.repeat(2000) + `- item ${i} `).join('\n')],
  ['marks at the longest run normalisation takes', 'a' + '̖́'.repeat(128) + ' b'],
  ['no-break space at a line end kept', 'x \ny'],
])('%s', (_name, md) => {
  expect(runnerNormalise(md)).toBe(normaliseMarkdown(md));
});

test('both refuse a run of combining marks past the longest normalisation takes', () => {
  const md = 'a' + '̖́'.repeat(128) + '́ b';
  expect(() => normaliseMarkdown(md)).toThrow(RangeError);
  expect(() => runnerNormalise(md)).toThrow('a run of 257 combining marks');
});

test('the runner normalises a line with a long run of spaces in linear time', () => {
  // the runner's copy runs in the parser WebView, where a page could hold it for hours with /[ \t]+$/
  const started = Date.now();
  runnerNormalise('a' + ' '.repeat(400_000) + 'b');
  expect(Date.now() - started).toBeLessThan(5_000);
});
