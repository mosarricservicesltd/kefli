// Builds icon-study.html from study.tpl.html: inlines cover v1 (shared/cover), the 18 patterns' seeds, hashes and marks
// (study-data.json) and the judges' notes (notes.json).   node build-study.cjs
const fs = require('fs');
const path = require('path');
const here = __dirname;
const repo = path.resolve(here, '..', '..', '..', '..');

const data = JSON.parse(fs.readFileSync(path.join(here, 'study-data.json'), 'utf8'));
const NAMES = {
  P012: 'Bands', P021: 'Bands, turned', P315: 'Hill', P446: 'Hill and sky', P120: 'Cap', P022: 'Half from the side',
  P028: 'Ring', P415: 'Diagonal', P196: 'Spine', P560: 'Moon', P430: 'Star', P314: 'Wave', P303: 'S curve', P096: 'Sash',
  P150: 'Dog-ear', P205: 'Quarters', P339: 'Corner', P063: 'Split',
};
const ORDER = Object.keys(NAMES);
const missing = ORDER.filter(id => !data[id]);
if (missing.length) { console.error('missing marks for', missing.join(' ')); process.exit(1); }

// the judges' notes, rewritten in plain words: [{ id, lens, text }] (notes.json)
const notes = {};
JSON.parse(fs.readFileSync(path.join(here, 'notes.json'), 'utf8')).forEach(n => { (notes[n.id] = notes[n.id] || []).push([n.lens, n.text]); });
// a reviewer's caution where a pattern has a flaw the judges didn't mention
const CAUTION = {
  P150: ['At launcher size', 'A sliver at 12 o’clock touches the top of the bookmark in every palette: on light grounds it reads as a stalk on the outline, and on dark grounds it makes the bookmark look taller on one side.'],
  P196: ['At launcher size', 'Two hairline wedges meet at 9 o’clock, with a hairline at the top, and read as a crack at 48 px.'],
  P303: ['At launcher size', 'On dark grounds the bar’s left half lies on the ground, so part of the bar fades whichever bar is drawn.'],
};
const meta = ORDER.map(id => ({ id, name: NAMES[id], notes: (notes[id] || []).concat(CAUTION[id] ? [CAUTION[id]] : []) }));
const noNotes = meta.filter(m => !m.notes.length).map(m => m.id);
if (noNotes.length) { console.error('no judge notes for', noNotes.join(' ')); process.exit(1); }

const coverJs = fs.readFileSync(path.join(repo, 'shared', 'cover', 'cover-v1.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
let html = fs.readFileSync(path.join(here, 'study.tpl.html'), 'utf8');
html = html.replace('/*COVER_JS*/', () => coverJs)
  .replace('/*DATA*/', () => 'const DATA = ' + JSON.stringify(Object.fromEntries(ORDER.map(id => [id, data[id]]))) + ';')
  .replace('/*PATMETA*/', () => JSON.stringify(meta));
fs.writeFileSync(path.join(here, 'icon-study.html'), html);
const _preview = '<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><style>:root{color-scheme:light}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style>\n' + html + '\n</html>\n';
console.log('wrote icon-study.html', (html.length / 1024).toFixed(0) + ' KB');
