// Go's cover profile as LCOV, appended to Jest's coverage/lcov.info, so the code gate reads the Go server's coverage in
// the same report as the TypeScript (it takes the freshest report it finds).
//   node tools/go-lcov.mjs server/api/coverage.out >> coverage/lcov.info
import { readFileSync } from 'node:fs';

const MODULE = 'github.com/richardminton-glitch/Kefli/server/api/';
const lines = new Map(); // file -> Map(line -> hits)
for (const row of readFileSync(process.argv[2], 'utf8').split('\n').slice(1)) {
  const m = /^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/.exec(row);
  if (!m) continue;
  const file = m[1].startsWith(MODULE) ? `server/api/${m[1].slice(MODULE.length)}` : m[1];
  const hits = lines.get(file) ?? new Map();
  for (let n = Number(m[2]); n <= Number(m[3]); n++) hits.set(n, Math.max(hits.get(n) ?? 0, Number(m[4])));
  lines.set(file, hits);
}
let out = '';
for (const [file, hits] of lines) {
  out += `SF:${file}\n`;
  for (const [n, h] of [...hits].sort((a, b) => a[0] - b[0])) out += `DA:${n},${h}\n`;
  out += 'end_of_record\n';
}
process.stdout.write(out);
