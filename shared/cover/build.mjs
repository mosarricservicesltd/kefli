// Copies the cover module to the served mockups so the prototypes can load it with
// <script src="cover-v1.js">. Run from anywhere: node shared/cover/build.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const source = join(here, 'cover-v1.js');
const target = join(root, 'docs', 'design', 'mockups', 'cover-v1.js');

const src = readFileSync(source, 'utf8');
if (!src.includes("const VERSION = 'cover-v1';")) throw new Error('cover-v1.js does not declare cover-v1');
const header = '/* Generated from shared/cover/cover-v1.js by shared/cover/build.mjs. Do not edit: cover v1 is frozen, and a change ships as cover-v2. */\n';
writeFileSync(target, header + src);
console.log('wrote ' + relative(root, target).split('\\').join('/') + ' (' + (header.length + src.length) + ' bytes)');
