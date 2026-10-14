// The live list (mobile spec 11.3) goes through the share's own path, so what it scores is what a share would do.
import { liveOutcome } from '../src/gates/live';
import type { PagePorts } from '../src/services/page';
import type { XPorts } from '../src/services/xpost';

const WORDS = `${Array.from({ length: 150 }, (_, i) => `word${i}`).join(' ')}\n`;
const NO_X: XPorts = { fetch: (async () => Promise.reject(new Error('X is not asked for here'))) as never };

/**
 * A release build's fetch: plain http refused before it connects, as expo/fetch reports OkHttp's refusal, and https
 * from sites that have it. Returns every address asked for.
 */
function releaseBuild(https: Set<string>): { page: PagePorts; asked: string[] } {
  const asked: string[] = [];
  const page: PagePorts = {
    fetch: (async (url: string) => {
      asked.push(url);
      if (url.startsWith('http://')) throw new Error('fetch failed: java.net.UnknownServiceException: CLEARTEXT communication to old.example not permitted by network security policy');
      if (!https.has(url)) throw new Error('fetch failed: javax.net.ssl.SSLHandshakeException: java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.');
      return Object.defineProperty(new Response('<p>x</p>', { status: 200, headers: { 'content-type': 'text/html' } }), 'url', { value: url });
    }) as never,
    parse: async () => ({ ok: true, title: 'A story', byline: null, site: null, lang: null, hero: null, canonical: null, readerable: true, markdown: WORDS }),
  };
  return { page, asked };
}

describe('the live list asks as the share asks (mobile spec 11.3, 5.4)', () => {
  test('a public http address is asked for over https alone: one whose site has it is read there', async () => {
    const { page, asked } = releaseBuild(new Set(['https://news.example/story']));
    expect(await liveOutcome(page, NO_X, 'http://news.example/story')).toEqual({ got: 'article', detail: '“A story”, 150 words' });
    expect(asked).toEqual(['https://news.example/story']);
  });

  test('one whose site has no https waits, as a share of it does, rather than failing on its plain http', async () => {
    // left to net/http, the address itself was asked for next, and the build's refusal of it scored a failure the
    // share never meets: its sheet says the save waits
    const { page, asked } = releaseBuild(new Set());
    expect((await liveOutcome(page, NO_X, 'http://old.example/post')).got).toBe('offline');
    expect(asked).toEqual(['https://old.example/post']);
  });
});
