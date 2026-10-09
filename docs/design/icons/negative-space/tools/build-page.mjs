// node docs/design/icons/negative-space/tools/build-page.mjs
// Reads page.json (which candidates, in what order and groups, and the page's texts), every listed candidate's
// files and notes, and today's icon from shared/brand/src, and writes study.html from tools/page.tpl.html.
import fs from 'node:fs';
import path from 'node:path';
import { STUDY } from './lib.mjs';

const REPO = path.resolve(STUDY, '..', '..', '..', '..');
const read = p => fs.readFileSync(p, 'utf8');
const strip = svg => svg.replace(/<!--[\s\S]*?-->/g, '').replace(/\s*\n\s*/g, ' ').trim();
const page = JSON.parse(read(process.env.PAGE ? path.resolve(process.env.PAGE) : path.join(STUDY, 'page.json')));

const FILES = { mark: 'mark.svg', c48: 'cut-48.svg', c32: 'cut-32.svg', c16: 'cut-16.svg', glyph: 'glyph-24.svg' };
const EXTRA = { ext16: 'ext-16.svg', ext32: 'ext-32.svg' };
const ids = page.groups.flatMap(g => g.ids);
const triedIds = page.tried ? page.tried.items.map(t => t.id) : [];
const load = id => {
  const dir = path.join(STUDY, 'candidates', id);
  const svg = {};
  for (const [k, f] of Object.entries(FILES)) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) throw new Error(`${id}: missing ${f}`);
    svg[k] = strip(read(p));
  }
  for (const [k, f] of Object.entries(EXTRA)) { const p = path.join(dir, f); if (fs.existsSync(p)) svg[k] = strip(read(p)); }
  const meta = JSON.parse(read(path.join(dir, 'meta.json')));
  const notesPath = path.join(dir, 'notes.json');
  const notes = fs.existsSync(notesPath) ? JSON.parse(read(notesPath)) : {};
  for (const k of ['title', 'idea', 'built', 'small', 'risks']) if (!meta[k]) throw new Error(`${id}: meta.json has no ${k}`);
  return { id, ...meta, notes, svg };
};
const cands = ids.map(load);
const tried = triedIds.map(load);

const today = strip(read(path.join(REPO, 'shared', 'brand', 'src', 'full.svg')));
const cover = strip(read(path.join(REPO, 'shared', 'brand', 'src', 'background.svg')));
// the fine-tuning studies: each item's master and construction overlay, and its 48 and 32 px cuts where asked for
const opt = p => (fs.existsSync(p) ? strip(read(p)) : null);
const studies = (page.studies || []).map(st => ({ ...st, items: st.items.map(it => {
  const dir = path.join(STUDY, 'candidates', it.id);
  return { ...it, mark: strip(read(path.join(dir, 'mark.svg'))), overlay: opt(path.join(dir, 'overlay.svg')),
    c48: st.cuts ? strip(read(path.join(dir, 'cut-48.svg'))) : null, c32: st.cuts ? strip(read(path.join(dir, 'cut-32.svg'))) : null };
}) }));
const data = { page, cands, tried, today, cover, studies };
const json = JSON.stringify(data).replace(/</g, '\\u003c');
const tpl = read(path.join(STUDY, 'tools', 'page.tpl.html'));
if (!tpl.includes('/*DATA*/null')) throw new Error('template has no /*DATA*/null slot');
const out = tpl.replace('/*DATA*/null', () => json);
fs.writeFileSync(path.join(STUDY, 'study.html'), out);
console.log(`wrote study.html: ${cands.length} options, ${tried.length} from round one, ${(out.length / 1024).toFixed(1)} KB`);
