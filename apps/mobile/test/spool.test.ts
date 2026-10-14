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

  test('it is synced to the disk before its rename, and its folder after, so a power cut leaves all of it or none', () => {
    // renamed unsynced, it could come back from a power cut empty or cut short, which the pickup drops as no share
    expect(kt).not.toContain('writeText(');
    expect(member('write')).toContain('writeSynced(dir(context), "$id.json", body)');
    const synced = member('writeSynced');
    const steps = ['FileOutputStream(tmp)', 'out.write(body.toByteArray(Charsets.UTF_8))', 'out.fd.sync()', 'tmp.renameTo(File(dir, name))', 'syncFolder(dir)'].map((s) => synced.indexOf(s));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    const folder = member('syncFolder');
    expect(folder).toContain('Os.open(dir.path, OsConstants.O_RDONLY, 0)');
    expect(folder).toMatch(/try \{\s+Os\.fsync\(fd\)\s+\} finally \{\s+Os\.close\(fd\)/);
  });

  test("one that can't be written is held for its sheet, which saves it or says That didn't save, and the app stays up", () => {
    // a full disk threw out of onCreate, closing the app with the share in it; a failed rename left no spool, so the
    // sheet said That wasn't a link
    expect(member('write')).toMatch(/try \{\s+writeSynced\(dir\(context\), "\$id\.json", body\)\s+\} catch \(e: IOException\) \{[\s\S]*?unwritten\[id\] = body\s+\}\s+return id/);
    const synced = member('writeSynced');
    expect(synced).toContain('if (!tmp.renameTo(File(dir, name))) throw IOException(');
    expect(synced).toMatch(/catch \(e: IOException\) \{\s+tmp\.delete\(\)\s+throw e/);
    expect(member('read')).toContain('?.readText() ?: unwritten[id]');
    expect(member('delete')).toContain('unwritten.remove(id)');
    // the start-up pickup lists the files alone: a held share is its own sheet's, and goes with the process
    expect(member('list')).not.toContain('unwritten');
  });
});
