// The link a share carries (mobile spec 5.4) and the start-up pickup of spools a killed process left (8.5): a share
// that can't be read or saved must not stop the shares behind it, at this start or any other.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memoryDb } from './sqlite';
import { migrate } from '../src/data/schema';
import { SHARE_MAX_CHARS, SHARE_MAX_TRIES, activeSpools, firstLink, pickUpSpools, readSpool, sheetLink } from '../src/share/pickup';
import { S } from '../src/ui/strings';

const mockSpools = new Map<string, string>();
const mockSaved: string[] = [];
let mockFail: (url: string) => boolean = () => false;
const mockDb = memoryDb();
migrate(mockDb);

jest.mock('expo-modules-core', () => ({
  requireNativeModule: () => ({
    readSpool: (id: string) => mockSpools.get(id) ?? null,
    deleteSpool: (id: string) => mockSpools.delete(id),
    listSpools: () => [...mockSpools.keys()],
    finish: () => true,
  }),
}), { virtual: true });
jest.mock('../src/services/save', () => ({
  saveLater: async (url: string) => {
    if (mockFail(url)) throw new Error('no signer yet');
    mockSaved.push(url);
    return { hash: 'ab'.repeat(32), held: [], kind: 'saved', prior: null, title: null, site: null };
  },
}));
jest.mock('../src/services/store', () => ({ store: () => mockDb }));

const spool = (id: string, text: string | null, receivedAt = 0) =>
  mockSpools.set(id, JSON.stringify({ v: 1, id, text, subject: null, referrer: null, receivedAt }));

describe('the link a share carries (5.4)', () => {
  test('the last address in the text, since apps put their own words first', () => {
    expect(firstLink('Look at this https://a.example/x and https://b.example/y')).toBe('https://b.example/y');
    expect(firstLink('no link here')).toBeNull();
    expect(firstLink(null)).toBeNull();
    expect(firstLink(`${'x'.repeat(SHARE_MAX_CHARS)} https://a.example/`)).toBeNull();
  });

  test('an address normalise refuses is passed over, for the one before it or for Not a link', () => {
    expect(firstLink('see http://[oops')).toBeNull();
    expect(firstLink('Read https://a.example/x via http://[::1')).toBe('https://a.example/x');
    expect(firstLink(`https://${'a'.repeat(2000)}.example/`)).toBeNull();
    expect(firstLink('https://example.com:99999/a')).toBeNull();
  });

  test('a link inside a sentence is read as it was written: its punctuation, an unopened bracket and invisible marks go', () => {
    expect(firstLink('Read this: https://example.com/a.')).toBe('https://example.com/a');
    expect(firstLink('(see https://example.com/a).')).toBe('https://example.com/a');
    expect(firstLink('Look: https://en.wikipedia.org/wiki/Foo_(bar).')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(firstLink('[notes](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(firstLink('see https://example.com/?q=a,b, then the rest')).toBe('https://example.com/?q=a,b');
    expect(firstLink('a link‏ https://example.com/a‏​')).toBe('https://example.com/a');
    expect(firstLink('[x] https://example.com/a]')).toBe('https://example.com/a');
  });

  test('an address ends at the mark a picture leaves in plain text (U+FFFC), as at a space', () => {
    // an app that flattens its own styled text before sharing it sends the mark as it is, beside the link
    expect(firstLink('A story https://example.com/a￼')).toBe('https://example.com/a');
    expect(firstLink('https://example.com/a￼Looks good')).toBe('https://example.com/a');
    expect(firstLink('Look ￼https://example.com￼')).toBe('https://example.com');
    expect(firstLink('https://a.example/x￼https://b.example/y')).toBe('https://b.example/y');
    // a link that is the whole share but for the mark is still the whole share, its own full stop kept
    expect(firstLink('https://en.wikipedia.org/wiki/Washington,_D.C.￼')).toBe('https://en.wikipedia.org/wiki/Washington,_D.C.');
    expect(firstLink('Look: https://example.com/a.￼')).toBe('https://example.com/a');
  });

  test('a link that is the whole share, as a browser shares a page, is taken as it is, but for invisible marks', () => {
    expect(firstLink('https://en.wikipedia.org/wiki/Washington,_D.C.')).toBe('https://en.wikipedia.org/wiki/Washington,_D.C.');
    expect(firstLink('  https://en.wikipedia.org/wiki/Foo_(bar)\n')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(firstLink('https://example.com/a​')).toBe('https://example.com/a');
  });

  test('a link that is the whole share but for the marks that show nothing round it is still the whole share', () => {
    // a right-to-left chat app puts direction marks round a link it shares alone: its own full stop stays, as without them
    expect(firstLink('\u200fhttps://en.wikipedia.org/wiki/Washington,_D.C.\u200f')).toBe('https://en.wikipedia.org/wiki/Washington,_D.C.');
    expect(firstLink('\u2066https://en.wikipedia.org/wiki/Washington,_D.C.\u2069\n')).toBe('https://en.wikipedia.org/wiki/Washington,_D.C.');
    expect(firstLink('\u200b https://example.com/a. \u200e\uFFFC')).toBe('https://example.com/a.');
    // with words beside it, it is still read as written in a sentence, and the marks still go from its end
    expect(firstLink('\u200fLook: https://example.com/a.\u200f')).toBe('https://example.com/a');
    expect(firstLink('\u200fhttps://example.com/a.\u200f \u200fmore\u200f')).toBe('https://example.com/a');
  });

  test('at most the last 16 addresses are tried', () => {
    const bad = (n: number) => 'http://[ '.repeat(n);
    expect(firstLink(`https://good.example/ ${bad(10)}`)).toBe('https://good.example/');
    expect(firstLink(`https://good.example/ ${bad(SHARE_MAX_TRIES)}`)).toBeNull();
  });

  test('so is one too long for its save to be published (C§3.3), which would never leave the phone', () => {
    const long = `https://news.example/?q=${'x'.repeat(10_000)}`;
    expect(firstLink(long)).toBeNull();
    expect(firstLink(`https://news.example/a ${long}`)).toBe('https://news.example/a');
    expect(firstLink(`https://news.example/?q=${'x'.repeat(5_000)}`)).toBe(`https://news.example/?q=${'x'.repeat(5_000)}`);
  });
});

describe('the start-up pickup (8.5)', () => {
  beforeEach(() => {
    mockSpools.clear();
    mockSaved.length = 0;
    mockFail = () => false;
  });

  test('a spool cut short, or holding no address normalise takes, is dropped, and the spools behind it are saved', async () => {
    mockSpools.set('1-cut', '{"v":1,"id":"1-cut","text":"https://a.exa');
    spool('2-bad', 'see http://[oops');
    spool('3-good', 'https://b.example/story');
    expect(readSpool('1-cut')).toBeNull();
    expect(await pickUpSpools()).toBe(1);
    expect(mockSaved).toEqual(['https://b.example/story']);
    expect([...mockSpools.keys()]).toEqual([]);
  });

  test('a save that fails keeps its spool for the next start, and the rest are still saved', async () => {
    spool('1', 'https://a.example/');
    spool('2', 'https://b.example/');
    mockFail = (u) => u === 'https://a.example/';
    expect(await pickUpSpools()).toBe(1);
    expect(mockSaved).toEqual(['https://b.example/']);
    expect([...mockSpools.keys()]).toEqual(['1']);
    mockFail = () => false;
    expect(await pickUpSpools()).toBe(1);
    expect([...mockSpools.keys()]).toEqual([]);
  });

  test('a young spool belongs to a sheet still rising, and one a sheet holds is left alone', async () => {
    spool('young', 'https://a.example/', Date.now());
    spool('held', 'https://b.example/');
    activeSpools.add('held');
    try {
      expect(await pickUpSpools()).toBe(0);
      expect([...mockSpools.keys()]).toEqual(['young', 'held']);
    } finally {
      activeSpools.delete('held');
    }
  });
});

describe('what a share sheet opens on (5.4)', () => {
  beforeEach(() => mockSpools.clear());

  test("its spool's link; a spool with none is Not a link; one gone or cut short is a share that didn't save", () => {
    spool('link', 'Look at this https://a.example/story');
    spool('words', 'no link here');
    spool('picture', null);
    mockSpools.set('cut', '{"v":1,"id":"cut","text":"https://a.exa');
    expect(sheetLink('link')).toEqual({ url: 'https://a.example/story' });
    expect(sheetLink('words')).toEqual({ url: null, why: 'nolink' });
    expect(sheetLink('picture')).toEqual({ url: null, why: 'nolink' });
    // a share held in memory for want of room to write it goes with its process, and a sheet brought back after it
    // finds nothing: sharing again mends that, where a different page or address would not
    expect(sheetLink('cut')).toEqual({ url: null, why: 'failed' });
    expect(sheetLink('gone')).toEqual({ url: null, why: 'failed' });
    expect(sheetLink(undefined)).toEqual({ url: null, why: 'failed' });
  });

  test("the sheet opens on it: a share that didn't save says so, and to share it again", () => {
    // Node can't draw the sheet: this reads its source, as the Original view's test reads its own
    const src = readFileSync(join(__dirname, '..', 'src', 'share', 'ShareRoot.tsx'), 'utf8');
    expect(src).toContain('const opened = useMemo(() => sheetLink(spoolId), [spoolId]);');
    expect(src).toContain("useState<Mode>(opened.url === null ? opened.why : isXPost(opened.url) ? 'checking' : 'saving')");
    expect(src).toContain("mode === 'nolink' ? [S.share.noLink, S.share.noLinkSub] : [S.share.failed, S.share.failedSub]");
    expect([S.share.failed, S.share.failedSub]).toEqual(['That didn’t save', 'Try sharing it again.']);
  });
});
