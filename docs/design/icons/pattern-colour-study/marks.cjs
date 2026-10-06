// Writes study-data.json: for each shortlisted pattern and colour, the mark markrule.cjs chooses ('1'/'0' for the
// bookmark's ink outline, then for the paper bar, then '!' when part of the mark still fades).
//   NODE_PATH=<folder with @resvg/resvg-js@2>/node_modules node marks.cjs [P012]   (one pattern per run keeps memory low)
const { choose } = require('./markrule.cjs');
const fs = require('fs');
const P = JSON.parse(fs.readFileSync('patterns.json', 'utf8'));
const byId = id => P[+id.slice(1) - 1];
const ALL = ['P012','P021','P315','P446','P120','P022','P028','P415','P196','P560','P430','P314','P303','P096','P150','P205','P339','P063'];
const PATS = process.argv[2] ? [process.argv[2]] : ALL;
const COLS = { cl063:'2c7601c0', cd030:'1555010c', cd090:'4000010c', cd135:'6000010c', cd210:'9555010c', cd255:'b555010c', cd285:'caab010c', cd345:'f555010c', cl000:'000001c0', cl030:'155501c0', cl150:'6aab01c0', cl210:'955501c0', cl255:'b55501c0', cl300:'d55501c0', greyl:null, greyd:null };
const out = {};
for (const id of PATS) { const p = byId(id); out[id] = { seed: p.seed, hash: p.hash, n: p.n, mods: p.mods, m: {} };
  for (const [cid, cb] of Object.entries(COLS)) {
    const h = (cb || '2c7601c0') + p.hash.slice(8);
    const r = choose(h, cid === 'greyl' ? { grey: 'light' } : cid === 'greyd' ? { grey: 'dark' } : {});
    out[id].m[cid] = (r.outline ? '1' : '0') + (r.paperBar ? '1' : '0') + (r.fade ? '!' : '');
  } }
const f='study-data.json'; const prev = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f,'utf8')) : {}; Object.assign(prev, out); fs.writeFileSync(f, JSON.stringify(prev));
const tally = {}; Object.values(out).forEach(o => Object.values(o.m).forEach(v => tally[v] = (tally[v] || 0) + 1));
console.log('pairs', Object.keys(out).length * Object.keys(COLS).length, 'mark kinds', JSON.stringify(tally));

