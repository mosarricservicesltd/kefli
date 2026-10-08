import { linkRoute } from '../src/nav/links';

const H = 'ab'.repeat(32);
const has = (h: string) => h === H;

describe('internal links (mobile spec 5.1, 7.1)', () => {
  test("the Reader, for a save on the phone, with a word when it's a whole number", () => {
    expect(linkRoute(`shelf://reader/${H}`, has, false)).toBe(`/reader/${H}`);
    expect(linkRoute(`shelf://reader/${H}?word=42`, has, false)).toBe(`/reader/${H}?word=42`);
    expect(linkRoute(`/reader/${H}`, has, false)).toBe(`/reader/${H}`);
    expect(linkRoute(`shelf://reader/${H}?word=-1`, has, false)).toBe(`/reader/${H}`);
    expect(linkRoute(`shelf://reader/${H}?word=1e9`, has, false)).toBe(`/reader/${H}`);
  });

  test('anything else opens Saves', () => {
    expect(linkRoute(`shelf://reader/${'cd'.repeat(32)}`, has, false)).toBe('/');
    expect(linkRoute('shelf://reader/../delete', has, false)).toBe('/');
    expect(linkRoute('shelf://delete', has, false)).toBe('/');
    expect(linkRoute('shelf://switch', has, false)).toBe('/');
    expect(linkRoute('/advanced', has, false)).toBe('/');
    expect(linkRoute(`shelf://reader/${H}/original`, has, false)).toBe('/');
    expect(linkRoute('::::', has, false)).toBe('/');
  });

  test('the gates only in the local build', () => {
    expect(linkRoute('shelf://gates', has, true)).toBe('/gates');
    expect(linkRoute('shelf://gates', has, false)).toBe('/');
  });
});
