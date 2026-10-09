// Copies the brand's web outputs (favicons, app icons, the social card, the web manifest) from
// shared/brand/out/web, where build-icons.cjs makes them, into public/. Runs before dev and build;
// the copies are git-ignored, so the brand folder stays the only source.

import { copyFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, '..', '..', '..', 'shared', 'brand', 'out', 'web');
const to = join(here, '..', 'public');
for (const f of readdirSync(from)) copyFileSync(join(from, f), join(to, f));
// The nav's and footer's mark beside the name: the 28 px cut, as the extension's options page uses it.
copyFileSync(join(from, '..', 'extension', 'options-logo-28.svg'), join(to, 'mark-28.svg'));
// The large mark beside "Said KEF-lee": the full artwork on its 108 dp canvas.
copyFileSync(join(from, '..', '..', 'src', 'full.svg'), join(to, 'mark-full.svg'));
console.log(`brand: copied ${readdirSync(from).length + 2} files into public/`);
