import { linkRoute } from '../src/nav/links';

const H = 'ab'.repeat(32);
const has = (h: string) => h === H;

describe('internal links (mobile spec 5.1, 7.1)', () => {
  test("the Reader, for a save on the phone, with a word when it's a whole number", () => {
    expect(linkRoute(`kefli://reader/${H}`, has, false)).toBe(`/reader/${H}`);
    expect(linkRoute(`kefli://reader/${H}?word=42`, has, false)).toBe(`/reader/${H}?word=42`);
    expect(linkRoute(`/reader/${H}`, has, false)).toBe(`/reader/${H}`);
    expect(linkRoute(`kefli://reader/${H}?word=-1`, has, false)).toBe(`/reader/${H}`);
    expect(linkRoute(`kefli://reader/${H}?word=1e9`, has, false)).toBe(`/reader/${H}`);
  });

  test('anything else opens Saves', () => {
    expect(linkRoute(`kefli://reader/${'cd'.repeat(32)}`, has, false)).toBe('/');
    expect(linkRoute('kefli://reader/../delete', has, false)).toBe('/');
    expect(linkRoute('kefli://delete', has, false)).toBe('/');
    expect(linkRoute('kefli://switch', has, false)).toBe('/');
    expect(linkRoute('/advanced', has, false)).toBe('/');
    expect(linkRoute(`kefli://reader/${H}/original`, has, false)).toBe('/');
    expect(linkRoute('::::', has, false)).toBe('/');
  });

  test('the gates only in the local build', () => {
    expect(linkRoute('kefli://gates', has, true)).toBe('/gates');
    expect(linkRoute('kefli://gates', has, false)).toBe('/');
  });
});
