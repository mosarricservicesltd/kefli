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

  // an IPv4-translated address (::ffff:0:a.b.c.d, RFC 2765) reaches the IPv4 address in its last 32 bits, as a mapped
  // one does; NAT64's prefix for a network's own use (64:ff9b:1::/48, RFC 8215) reaches one its network chooses, at a
  // place in the address its network chooses, so none of it is public
  test.each([
    'http://[::ffff:0:127.0.0.1]/', 'http://[::ffff:0:7f00:1]/', 'http://[0:0:0:0:ffff:0:a00:1]/', 'http://[::ffff:0:192.168.1.1]/admin',
    'http://[::ffff:0:a9fe:a9fe]/latest/', 'http://[::ffff:0:0.0.0.0]/', 'http://[64:ff9b:1::a00:1]/', 'https://[64:ff9b:1::808:808]/',
    'https://[64:ff9b:1:ffff:ffff:ffff:ffff:ffff]/', 'https://[64:ff9b:1::]/', 'https://[64:ff9b:1:c0a8:1:100::]/',
  ])('refused, as an address that reaches a private IPv4 one or a local NAT64: %s', (u) => expect(isPublicWebUrl(u)).toBe(false));

  test.each([
    'https://[::ffff:0:808:808]/', 'https://[::ffff:0:8.8.4.4]/', 'https://[64:ff9b::1.1.1.1]/', 'https://[64:ff9b:2::808:808]/',
    'https://[64:ff9b:0:1::808:808]/',
  ])('public, as one that reaches a public IPv4 address, or lies outside the local NAT64 prefix: %s', (u) => expect(isPublicWebUrl(u)).toBe(true));

  // expo/fetch's OkHttp client reads any address whose text begins http://filesystem.local from the phone's own files,
  // http://filesystem.localdata/data/app.kefli/… as /data/data/app.kefli/…, before the network: no such host is
  // public over http, however it is written
  test.each([
    'http://filesystem.localdata/data/app.kefli/files/kefli/a.html', 'http://FileSystem.LocalData:80/user/0/app.kefli/databases/kefli.db',
    'http://ｆｉｌｅｓｙｓｔｅｍ.ｌｏｃａｌｄａｔａ/data/app.kefli/x', 'http://filesystem.local-x/', 'http://filesystem.local0./etc/hosts',
    'http://filesystem%2Elocaldata/x', 'http://filesystem.local.example.com/x', 'http://a@filesystem.localdata/x', 'HTTP://filesystem.localdata/x',
    ' http://filesystem.localdata/x', 'ht\ttp://filesystem.localdata/x', 'http:\\\\filesystem.localdata\\x', 'http:///filesystem.localdata/x',
    'http://filesystem.local/x', 'https://filesystem.local/x', 'https://FILESYSTEM.LOCAL./x',
  ])("refused, as the phone's fetch reads it from its own files: %s", (u) => expect(isPublicWebUrl(u)).toBe(false));

  test("over https only the stand-in itself is refused, and an address that only holds its words is the web's", () => {
    for (const u of [
      'https://filesystem.localdata/x', 'https://filesystem.local.example.com/x', 'http://www.filesystem.localdata/x',
      'http://example.com/filesystem.local', 'http://example.com/?u=http://filesystem.localdata/', 'http://filesystemlocal.example/',
    ]) {
      expect([u, isPublicWebUrl(u)]).toEqual([u, true]);
    }
  });

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
