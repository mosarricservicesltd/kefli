import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PAGE } from '../src/services/sync';

// The inbox reads its wraps PAGE at a time and takes a whole answer of fewer as the whole window (services/inbox.ts
// readWindow), so the operator's strfry must answer a filter with at least PAGE events: with a lower maxFilterLimit, a
// full answer would read as the window's end and the browser saves beneath it would be passed over. test.sh checks the
// deployed relay; this holds the template and PAGE together on every push, so a change on either side fails here.

const TEMPLATE = join(__dirname, '../../../server/deploy/ansible/roles/strfry/templates/strfry.conf.j2');

/** The line without its comment: from the first # outside a quoted string. */
function uncommented(line: string): string {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    if (line[i] === '#' && !quoted) return line.slice(0, i);
  }
  return line;
}

/**
 * Each setting of a strfry config, by its whole dotted name, as strfry reads the file (taocpp's config): a block's
 * name opens it on its own line, a lone } closes it, and a key may be dotted itself.
 */
function settings(conf: string): Map<string, string> {
  const out = new Map<string, string>();
  const at: string[] = [];
  for (const raw of conf.split('\n')) {
    const line = uncommented(raw).trim();
    const open = /^([\w.]+)\s*=?\s*\{$/.exec(line);
    const set = /^([\w.]+)\s*=\s*(.+)$/.exec(line);
    if (open) at.push(open[1]);
    else if (line === '}') at.pop();
    else if (set) out.set([...at, set[1]].join('.'), set[2].trim());
  }
  return out;
}

describe("the operator relay answers the inbox's PAGE (strfry.conf.j2)", () => {
  test('relay.maxFilterLimit is set in the relay block, to PAGE or more', () => {
    const limit = settings(readFileSync(TEMPLATE, 'utf8')).get('relay.maxFilterLimit');
    expect(limit).toMatch(/^\d+$/);
    expect(Number(limit)).toBeGreaterThanOrEqual(PAGE);
  });

  test('the setting is read only where strfry reads it: in the relay block itself, and not from a comment', () => {
    const read = (conf: string) => settings(conf).get('relay.maxFilterLimit');
    expect(read('relay {\n    maxFilterLimit = 500\n}\n')).toBe('500');
    expect(read('relay.maxFilterLimit = 500\n')).toBe('500');
    // strfry passes over a key in another block, a nested one included, without a word
    expect(read('events {\n    maxFilterLimit = 500\n}\nrelay {\n}\n')).toBeUndefined();
    expect(read('relay {\n    auth {\n        maxFilterLimit = 500\n    }\n}\n')).toBeUndefined();
    expect(read('relay {\n    # maxFilterLimit = 500\n    bind = "127.0.0.1"\n}\n')).toBeUndefined();
    expect(read('relay {\n    serviceUrl = "wss://relay.{{ kefli_domain }}" # a brace in a string\n    maxFilterLimit = 300 # fewer\n}\n')).toBe('300');
  });
});
