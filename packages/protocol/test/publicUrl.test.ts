import { isPublicWebUrl } from '../src/publicUrl';

describe('inbox fetches stay off private addresses (mobile spec 7.1)', () => {
  test.each([
    'https://example.com/a', 'http://news.bbc.co.uk/x', 'https://8.8.8.8/', 'https://[2606:4700::1111]/', 'https://172.32.0.1/',
    'https://[64:ff9b::808:808]/', 'https://bücher.example/a',
  ])('public: %s', (u) => expect(isPublicWebUrl(u)).toBe(true));

  test.each([
    'http://localhost:8080/', 'http://printer.local/', 'http://router.home.arpa/', 'http://intranet/', 'http://127.0.0.1/',
    'http://10.1.2.3/', 'http://172.16.5.4/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/', 'http://100.64.0.1/',
    'http://0.0.0.0/', 'http://[::1]/', 'http://[fe80::1]/', 'http://[fd00::5]/', 'http://[::ffff:127.0.0.1]/',
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.1/', 'file:///etc/hosts', 'javascript:alert(1)', 'not a url',
    'http://[0:0:0:0:0:ffff:7f00:1]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::a00:1]/', 'http://[::]/', 'http://[ff02::1]/',
    `https://${'a'.repeat(2000)}.example/`,
  ])('refused: %s', (u) => expect(isPublicWebUrl(u)).toBe(false));

  // the phone's URL is Expo's, with no Unicode step: it leaves these as written, and OkHttp maps them to the
  // private addresses they spell
  const phoneUrl = (f: () => void) => {
    const real = globalThis.URL;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    globalThis.URL = require('whatwg-url-minimum').URL;
    try {
      f();
    } finally {
      globalThis.URL = real;
    }
  };

  test.each([
    'http://１２７.０.０.１/', 'http://１２７。０。０。１/', 'http://１９２.１６８.１.１/admin', 'http://ｆｏｏ．ｌｏｃａｌ/', 'https://ＬＯＣＡＬＨＯＳＴ/',
  ])("refused on the phone's URL too: %s", (u) => phoneUrl(() => expect(isPublicWebUrl(u)).toBe(false)));

  test("the phone's URL gives the same answers as Node's", () =>
    phoneUrl(() => {
      expect(isPublicWebUrl('https://example.com/a')).toBe(true);
      expect(isPublicWebUrl('http://[::ffff:7f00:1]/')).toBe(false);
    }));
});
