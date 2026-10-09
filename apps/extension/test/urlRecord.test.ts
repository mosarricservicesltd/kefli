// The shared normaliser on the browser's URL (src/urlRecord.ts, the extension's stand-in for whatwg-url) against every
// case in shared/normalise.fixtures.json, here on Node's URL. scripts/normalise.mjs runs the same check in Chrome.
jest.mock('whatwg-url/lib/url-state-machine', () => jest.requireActual('../src/urlRecord'));

import { normalise } from '../../../shared/normalise';
import { basicURLParse, serializeURL } from '../src/urlRecord';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const F = require('../../../shared/normalise.fixtures.json') as { cases: { name: string; url: string; canonical?: string; expect: string | null }[] };

const run = (url: string, canonical?: string) => {
  try {
    return normalise(url, canonical);
  } catch {
    return null;
  }
};

describe('normalise on the platform URL (shared/normalise.fixtures.json)', () => {
  test.each(F.cases.map((c) => [c.name, c] as const))('%s', (_n, c) => {
    expect(run(c.url, c.canonical)).toBe(c.expect);
  });
});

describe('the URL record', () => {
  test('a record serialises back to the URL it came from', () => {
    for (const u of ['https://user:pw@example.com:8443/a/b?x=1#f', 'http://[2001:db8::1]/', 'https://example.com/?', 'mailto:a@b.example']) {
      expect(serializeURL(basicURLParse(u)!)).toBe(new URL(u).href.replace(/\?$/, ''));
    }
  });
  test('what the Standard can’t parse is null', () => expect(basicURLParse('not a url')).toBeNull());
  test('the ASCII-host rule doesn’t let through what the Standard still refuses', () => {
    expect(basicURLParse('https://XN--A.com/x')?.host).toBe('xn--a.com');
    for (const u of ['https://1.2.3.999/', 'https://exa mple.com/', 'https://a<b.com/', 'https://xn--a.cöm/']) expect(basicURLParse(u)).toBeNull();
    expect(basicURLParse('https://u:p@XN--A.com:8080/x?y#z')).toMatchObject({ host: 'xn--a.com', username: 'u', password: 'p', port: '8080', query: 'y', fragment: 'z' });
  });
});
