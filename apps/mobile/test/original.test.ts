import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transformSync } from '@babel/core';
import { originalMayLoad } from '../src/net/navigation';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { stripConsole } = require('../babel.config.js');

describe('the Original view stays on the web and opens no other app (F25)', () => {
  test('http(s) and blank frames load; other schemes, a signer request among them, do not', () => {
    for (const url of ['https://news.example/a', 'http://old.example/', 'HTTPS://LOUD.EXAMPLE/', 'about:blank', 'about:srcdoc']) expect(originalMayLoad(url)).toBe(true);
    for (const url of [
      'nostrsigner:{"kind":1}?compressionType=none&returnType=signature&type=sign_event&callbackUrl=https://evil.example/?r=',
      'intent://scan/#Intent;scheme=zxing;package=com.example;end',
      'market://details?id=com.example', 'tel:+441234567890', 'sms:+441234567890', 'mailto:a@b.example', 'kefli://reader/x',
      'data:text/html,<script>1</script>', 'blob:https://news.example/1', 'file:///sdcard/x', 'javascript:alert(1)', 'about:config', 'https:evil', '',
    ]) expect(originalMayLoad(url)).toBe(false);
  });

  test('the view decides every navigation itself, so react-native-webview never hands one to Linking', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'screens', 'Original.tsx'), 'utf8');
    expect(src).toContain("originWhitelist={['*']}");
    expect(src).toContain('onShouldStartLoadWithRequest={(r) => originalMayLoad(r.url)}');
    // incognito, and the jar held while it is open and emptied as it closes (F27)
    expect(src).toMatch(/\n\s+incognito\n/);
    expect(src).toContain('useEffect(() => holdJar(), [])');
    const cookies = readFileSync(join(__dirname, '..', 'src', 'net', 'cookies.ts'), 'utf8');
    const hold = cookies.slice(cookies.indexOf('export function holdJar('), cookies.indexOf('export function clearCookies('));
    expect(hold.indexOf('KefliParser.holdJar(true)')).toBeLessThan(hold.indexOf('return () =>'));
    expect(hold).toMatch(/KefliParser\.holdJar\(false\);\s+void clearCookies\(\);/);
  });

  test('a renderer the system or Kefli ends leaves the view in its failure state, not a blank page', () => {
    // every WebView in the app shares one renderer, which ending a stuck parse (kefli-parser's Parser.kt) ends too;
    // the failed state also takes the dead WebView away, so nothing is drawn by it again
    const src = readFileSync(join(__dirname, '..', 'src', 'screens', 'Original.tsx'), 'utf8');
    expect(src).toContain("onRenderProcessGone={() => setSt('failed')}");
    expect(src).toContain("online && st !== 'failed' && (");
  });

  // Node can't run the Kotlin: these read its source, standing in for the Pixel check listed in HANDOVER
  test("the render WebView's cookies and storage go when each render ends, or when the open Original view closes (F27)", () => {
    const kt = readFileSync(join(__dirname, '..', 'modules', 'kefli-parser', 'android', 'src', 'main', 'java', 'app', 'kefli', 'parser', 'Renderer.kt'), 'utf8');
    const fn = (name: string) => {
      const at = kt.indexOf('fun ' + name + '(');
      return kt.slice(at, kt.indexOf('\n  }\n', at));
    };
    expect(fn('clearJar')).toContain('WebStorage.getInstance().deleteAllData()');
    expect(fn('clearJar')).toContain('removeAllCookies { flush() }');
    const finish = fn('finish');
    // before the promise answers, so the next render starts with an empty jar, unless an Original view holds it
    expect(finish).toContain('if (holds > 0) owed = true else clearJar()');
    expect(finish.indexOf('clearJar()')).toBeLessThan(finish.indexOf('load.promise.resolve'));
    expect(fn('hold')).toMatch(/--holds == 0 && owed\) \{\s+owed = false\s+clearJar\(\)/);
  });
});

describe("release builds strip the libraries' warns as well (mobile spec 7.1, F25)", () => {
  const strip = (code: string, filename: string) => transformSync(code, { plugins: [stripConsole], babelrc: false, configFile: false, filename })!.code;
  const webview = "console.warn(`Can't open url: ${url}`); console.error('e');";

  test('a warn in node_modules goes, on either kind of path; errors stay', () => {
    for (const f of ['/app/node_modules/react-native-webview/lib/WebViewShared.js', 'C:\\app\\node_modules\\x\\index.js']) {
      const out = strip(webview, f);
      expect(out).not.toContain('console.warn');
      expect(out).toContain("console.error('e')");
    }
  });

  test("Kefli's own warns stay, as before", () => {
    expect(strip(webview, '/app/apps/mobile/src/screens/Original.tsx')).toContain('console.warn');
  });
});
