// The share's spool as kefli-share writes it (mobile spec 8.5), before any JavaScript runs. Node can't run the
// Kotlin: these read its source, standing in for the check on the phone listed in HANDOVER, and run the sheet's
// reading of the text the spool holds (pickup.ts firstLink).
import { SHARE_MAX_TRIES, firstLink } from '../src/share/pickup';
import { kotlinSource, member as memberOf } from './kotlin';

jest.mock('expo-modules-core', () => ({ requireNativeModule: () => ({}) }), { virtual: true });
jest.mock('../src/services/save', () => ({}));
jest.mock('../src/services/store', () => ({ store: () => null }));

const kt = kotlinSource('kefli-share', 'share', 'Spool.kt');
const member = (name: string) => memberOf(kt, name);

describe("the share's spool (8.5)", () => {
  test('the text and subject are read as text whether the sender passes a String or styled text', () => {
    // getStringExtra reads a CharSequence as null, so a share of styled text said That wasn't a link
    expect(kt).not.toContain('.getStringExtra(');
    expect(member('charsExtra')).toMatch(/try \{\s+intent\.getCharSequenceExtra\(name\)\s+\} catch \(e: RuntimeException\) \{\s+null/);
    const write = member('write');
    expect(write).toContain('charsExtra(intent, Intent.EXTRA_TEXT)?.let(ShareText::of)');
    expect(write).toContain('charsExtra(intent, Intent.EXTRA_SUBJECT)?.toString()');
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

describe('styled text as the spool keeps it (8.5)', () => {
  const shareText = () => kotlinSource('kefli-share', 'share', 'ShareText.kt');

  test('a link whose address is only in its styling is saved, as its address alone, which the sheet takes exactly', () => {
    // ShareCompat's setHtmlText sends <a href="…">A story</a> as the styled text "A story", the address in its link
    // alone: spooled as plain text, the sheet found no address and said That wasn't a link
    expect(firstLink('A story')).toBeNull();
    expect(firstLink('https://news.example/story')).toBe('https://news.example/story');
    // alone, the link's own full stop stays; after its words, it would be read as ending their sentence
    expect(firstLink('https://en.wikipedia.org/wiki/Washington,_D.C.')).toBe('https://en.wikipedia.org/wiki/Washington,_D.C.');
    expect(firstLink('Washington\nhttps://en.wikipedia.org/wiki/Washington,_D.C.')).toBe('https://en.wikipedia.org/wiki/Washington,_D.C');
    // several links, a line each: the last is taken, as from any share
    expect(firstLink('https://news.example/story\nhttps://app.example/')).toBe('https://app.example/');
    const st = shareText();
    const of = memberOf(st, 'of');
    expect(of).toContain('if (cs !is Spanned) return cs.toString()');
    expect(of).toContain('if (text.contains("http://") || text.contains("https://")) return text');
    expect(of).toContain('return if (links.isEmpty()) text else links.joinToString("\\n")');
    const links = memberOf(st, 'linksOf');
    const steps = ['getSpans(0, s.length, URLSpan::class.java)', '.sortedBy { s.getSpanStart(it) }', '.mapNotNull { it.url }', '.filter { it.startsWith("http://") || it.startsWith("https://") }', '.distinct()', '.takeLast(LINKS)'].map((s) => links.indexOf(s));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    // as many as the sheet tries, from the last
    expect(st).toContain(`const val LINKS = ${SHARE_MAX_TRIES}`);
  });

  test("a picture's mark beside an address is a space, rather than part of the address saved", () => {
    // U+FFFC, which a picture leaves in styled text, isn't white space to the sheet's pattern
    expect(firstLink('https://a.example/x\uFFFCcaption')).toBe('https://a.example/x\uFFFCcaption');
    expect(firstLink('https://a.example/x caption')).toBe('https://a.example/x');
    const st = shareText();
    expect(st).toContain("private const val PICTURE = '\\uFFFC'");
    expect(memberOf(st, 'of')).toContain('val text = cs.toString().replace(PICTURE, \' \')');
  });
});
