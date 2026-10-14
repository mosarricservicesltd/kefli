// The app's icons are the prototype's (mobile spec 6.3): Lucide's paths at the token stroke, copied as signed off.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ICONS } from '../src/ui/icons';

const PROTOTYPE = readFileSync(join(__dirname, '../../../docs/design/mockups/prototype.html'), 'utf8');

/** The prototype's const I: each icon's name and its markup. */
const prototypeIcons = () => Object.fromEntries([...PROTOTYPE.matchAll(/^ {2}(\w+):'([^']*)'/gm)].map((m) => [m[1], m[2]]));

describe('icons', () => {
  test('every icon the app draws is the prototype’s own markup', () => {
    const drawn = prototypeIcons();
    for (const [name, markup] of Object.entries(ICONS)) expect([name, drawn[name]]).toEqual([name, markup]);
  });

  test('Backup space’s row has Lucide’s hard drive (FD 117)', () => {
    expect(ICONS.harddrive).toBe(
      '<line x1="22" x2="2" y1="12" y2="12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><line x1="6" x2="6.01" y1="16" y2="16"/><line x1="10" x2="10.01" y1="16" y2="16"/>',
    );
    expect(PROTOTYPE).toContain("ic('harddrive', 20)");
  });
});
