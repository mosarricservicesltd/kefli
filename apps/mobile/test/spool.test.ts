// The share's spool as kefli-share writes it (mobile spec 8.5), before any JavaScript runs. Node can't run the
// Kotlin: these read its source, standing in for the check on the phone listed in HANDOVER.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const kt = readFileSync(join(__dirname, '..', 'modules', 'kefli-share', 'android', 'src', 'main', 'java', 'app', 'kefli', 'share', 'Spool.kt'), 'utf8');

/** A function of the Spool object, from its name to the line before the next member (indented two spaces). */
function member(name: string): string {
  const at = kt.indexOf(`fun ${name}(`);
  if (at === -1) throw new Error(`no fun ${name} in Spool.kt`);
  const [first, ...rest] = kt.slice(at).split('\n');
  const body: string[] = [first];
  for (const line of rest) {
    if (line.startsWith('  }')) body.push(line);
    if (line !== '' && !line.startsWith('    ')) break;
    body.push(line);
  }
  return body.join('\n');
}

describe("the share's spool (8.5)", () => {
  test('the text and subject are read as text whether the sender passes a String or styled text', () => {
    // getStringExtra reads a CharSequence as null, so a share of styled text said That wasn't a link
    expect(kt).not.toContain('.getStringExtra(');
    expect(member('textExtra')).toContain('intent.getCharSequenceExtra(name)?.toString()');
    const write = member('write');
    expect(write).toContain('textExtra(intent, Intent.EXTRA_TEXT)');
    expect(write).toContain('textExtra(intent, Intent.EXTRA_SUBJECT)');
  });
});
