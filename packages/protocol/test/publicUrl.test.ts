import { isPublicWebUrl } from '../src/publicUrl';

describe('inbox fetches stay off private addresses (mobile spec 7.1)', () => {
  test.each([
    'https://example.com/a', 'http://news.bbc.co.uk/x', 'https://8.8.8.8/', 'https://[2606:4700::1111]/', 'https://172.32.0.1/',
  ])('public: %s', (u) => expect(isPublicWebUrl(u)).toBe(true));

  test.each([
    'http://localhost:8080/', 'http://printer.local/', 'http://router.home.arpa/', 'http://intranet/', 'http://127.0.0.1/',
    'http://10.1.2.3/', 'http://172.16.5.4/', 'http://192.168.1.1/', 'http://169.254.169.254/latest/', 'http://100.64.0.1/',
    'http://0.0.0.0/', 'http://[::1]/', 'http://[fe80::1]/', 'http://[fd00::5]/', 'http://[::ffff:127.0.0.1]/',
    'http://2130706433/', 'http://0x7f.0.0.1/', 'http://127.1/', 'file:///etc/hosts', 'javascript:alert(1)', 'not a url',
  ])('refused: %s', (u) => expect(isPublicWebUrl(u)).toBe(false));
});
