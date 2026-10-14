// The Kotlin the native modules' tests read: Node can't run it, so those tests check its source, standing in for
// the checks on the phone listed in HANDOVER.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A Kotlin file of one of the app's modules (modules/<module>), in its package app.kefli.<pkg>. */
export function kotlinSource(module: string, pkg: string, file: string): string {
  return readFileSync(join(__dirname, '..', 'modules', module, 'android', 'src', 'main', 'java', 'app', 'kefli', pkg, file), 'utf8');
}

/** A function of a Kotlin object, from its name to the line before the next member (indented two spaces). */
export function member(kt: string, name: string): string {
  const at = kt.indexOf(`fun ${name}(`);
  if (at === -1) throw new Error(`no fun ${name}`);
  const [first, ...rest] = kt.slice(at).split('\n');
  const body: string[] = [first];
  for (const line of rest) {
    if (line.startsWith('  }')) body.push(line);
    if (line !== '' && !line.startsWith('    ')) break;
    body.push(line);
  }
  return body.join('\n');
}
