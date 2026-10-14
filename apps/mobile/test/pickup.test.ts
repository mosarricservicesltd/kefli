// The link a share carries (mobile spec 5.4) and the start-up pickup of spools a killed process left (8.5): a share
// that can't be read or saved must not stop the shares behind it, at this start or any other.
import { memoryDb } from './sqlite';
import { migrate } from '../src/data/schema';
import { SHARE_MAX_CHARS, activeSpools, firstLink, pickUpSpools, readSpool } from '../src/share/pickup';

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
  saveLink: async (url: string) => {
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
