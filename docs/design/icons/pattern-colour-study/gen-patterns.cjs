// Regenerates patterns.json and patterns.js: every distinct depth-1 pattern from the first icon round's 32 seeds
// (docs/design/icons/fingerprint-icons.html) and shelf/icon/1 to shelf/icon/600, in that order, duplicates removed.
// A pattern is a cover's composition, bytes 4 onward of its hash; colour comes from bytes 0 to 3, so the patterns are
// compared with today's colour bytes (2c7601c0) and any colour can be applied later.   node gen-patterns.cjs
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const here = __dirname;
const repo = path.resolve(here, '..', '..', '..', '..');
const C = require(path.join(repo, 'shared', 'cover', 'cover-v1.js'));

const first = fs.readFileSync(path.join(repo, 'docs', 'design', 'icons', 'fingerprint-icons.html'), 'utf8');
const seeds = [...first.matchAll(/\["([^"]+)", '([0-9a-f]{64})'\]/g)].map(m => m[1]);
for (let i = 1; i <= 600; i++) { const s = 'shelf/icon/' + i; if (!seeds.includes(s)) seeds.push(s); }

const seen = new Set(), out = [];
for (const seed of seeds) {
  const hash = crypto.createHash('sha256').update(seed, 'utf8').digest('hex');
  const leaves = C.leaves('2c7601c0' + hash.slice(8), { depth: 1 });
  const sig = JSON.stringify(leaves.map(l => [l.x, l.y, l.s, l.mod, l.rot, l.bg, l.fg]));
  if (seen.has(sig)) continue;
  seen.add(sig);
  out.push({ seed, hash, n: leaves.length, mods: leaves.map(l => l.mod).join('+'), sig });
}
fs.writeFileSync(path.join(here, 'patterns.json'), JSON.stringify(out));
fs.writeFileSync(path.join(here, 'patterns.js'), 'window.PATTERNS=' + JSON.stringify(out.map((p, i) => ({ id: 'P' + String(i + 1).padStart(3, '0'), seed: p.seed, hash: p.hash, n: p.n, mods: p.mods }))) + ';');
console.log(seeds.length + ' seeds, ' + out.length + ' distinct patterns');
