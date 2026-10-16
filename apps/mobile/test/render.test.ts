// The render WebView asks for no address a hop of Kefli's own fetch couldn't go to (mobile spec 7.1, 8.2). Node can't
// run the Kotlin: these read kefli-parser's source, standing in for the check on the phone listed in HANDOVER, and
// hold its PublicWeb.kt to the rule it ports, packages/protocol's publicUrl.ts with net/http.ts's fromFiles, by running
// the two sides' blocks and prefixes over every address they decide, and comparing their tables of prefixes and, a
// statement at a time, the steps that read an IPv6 address. PublicWeb ran on the JVM against the protocol's answers too
// (20,239 addresses, each as written and as Chromium writes it, then 1,026,240 round the IPv6 prefixes that reach IPv4
// and NAT64's prefix for a network's own use, with the same answer for every one).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publicWeb } from '../src/net/http';
import { fetchPage, renderAnswer, type PagePorts, type ParserResult } from '../src/services/page';
import { kotlinSource, member, statements, steps } from './kotlin';

const kt = kotlinSource('kefli-parser', 'parser', 'PublicWeb.kt');
const repo = (...path: string[]) => readFileSync(join(__dirname, '..', '..', '..', ...path), 'utf8');
const js = repo('packages', 'protocol', 'src', 'publicUrl.ts');

/** A Kotlin Regex constant's pattern, its string's escapes undone, and whether it ignores case. */
function ktPattern(name: string): { source: string; ignoreCase: boolean } {
  const m = new RegExp(`val ${name} = Regex\\("((?:[^"\\\\]|\\\\.)*)"(, RegexOption\\.IGNORE_CASE)?\\)`).exec(kt);
  if (!m) throw new Error(`no Regex ${name}`);
  return { source: m[1].replace(/\\(.)/g, '$1'), ignoreCase: !!m[2] };
}

/**
 * Whether publicUrl.ts holds a pattern, as a regex literal or as the string a RegExp is built from (the code gate's
 * parser loses its place in a regex literal, so either may be there); anchored, between ^ and $, for one Kotlin's
 * matchEntire and matches hold to the whole of a string.
 */
function jsHolds(pattern: string, anchored: boolean): boolean {
  const p = anchored ? `^${pattern}$` : pattern;
  return js.includes(`/${p}/`) || js.includes(`'${p.replace(/\\/g, '\\\\')}'`);
}

/** The statements of a Kotlin function with a block body, as JavaScript reads them: val is const, and is &. */
function ktBody(name: string): string {
  const fn = member(kt, name);
  return fn.slice(fn.indexOf('{\n') + 2, fn.lastIndexOf('\n  }')).replace(/\bval\b/g, 'const').replace(/\band\b/g, '&');
}

/** The body of a function in publicUrl.ts. */
function jsBody(name: string): string {
  const at = js.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`no function ${name}`);
  return js.slice(js.indexOf('{\n', at) + 2, js.indexOf('\n}\n', at));
}

/** The numbers of a list of IPv6 pieces as written, in hex or decimal. */
const numbers = (list: string) => list.split(',').map((n) => n.trim()).filter((n) => n !== '').map(Number);

/** What a constant holds, as written, its comments gone: from its name to the end of its declaration. */
function declared(source: string, start: string, end: string): string {
  const at = source.indexOf(start);
  if (at === -1) throw new Error(`no ${start}`);
  return source.slice(at + start.length, source.indexOf(end, at)).replace(/\/\/.*$/gm, '');
}

/** A table of IPv6 pieces in publicUrl.ts: const NAME = [[…], …]; */
const jsTable = (name: string) => [...declared(js, `const ${name} = [`, '\n];').matchAll(/\[([^\]]*)\]/g)].map((m) => numbers(m[1]));
/** The same in PublicWeb.kt: private val NAME = listOf(intArrayOf(…), …) */
const ktTable = (name: string) => [...declared(kt, `private val ${name} = listOf(`, '\n  )').matchAll(/intArrayOf\(([^)]*)\)/g)].map((m) => numbers(m[1]));
/** A list of IPv6 pieces in publicUrl.ts: const NAME = […]; */
const jsPieces = (name: string) => numbers(declared(js, `const ${name} = [`, '];'));
/** The same in PublicWeb.kt: private val NAME = intArrayOf(…) */
const ktPieces = (name: string) => numbers(declared(kt, `private val ${name} = intArrayOf(`, ')'));

/** The statements of a function in publicUrl.ts. */
const jsSteps = (name: string) => statements(jsBody(name).split('\n'));
/** The statements of a function in PublicWeb.kt. */
const ktSteps = (name: string) => steps(kt, name);

/**
 * privateV6 and the helpers it reads an address with, a statement at a time, each beside its port in PublicWeb.kt; null
 * where the Kotlin takes the step in the line before (?: return true). A step on one side only, or out of its place,
 * fails: the rule the WebView keeps is the protocol's, step for step.
 */
const PORTED: Record<string, [string, string | null][]> = {
  privateV6: [
    ["const p = pieces(host.replace(/^\\[|\\]$/g, '').toLowerCase());", 'val p = pieces(host.removePrefix("[").removeSuffix("]").lowercase()) ?: return true'],
    ['if (!p) return true;', null],
    ['if (zeros(p, 7) && p[7] <= 1) return true;', 'if (zeros(p, 7) && p[7] <= 1) return true'],
    ['const v4 = carried(p);', 'val v4 = carried(p)'],
    ['if (v4) return privateV4(v4);', 'if (v4 != null) return privateV4(v4)'],
    ['if (begins(p, LOCAL_NAT64)) return true;', 'if (begins(p, LOCAL_NAT64)) return true'],
    [
      'return (p[0] & 0xfe00) === 0xfc00 || (p[0] & 0xffc0) === 0xfe80 || (p[0] & 0xff00) === 0xff00;',
      'return (p[0] and 0xfe00) == 0xfc00 || (p[0] and 0xffc0) == 0xfe80 || (p[0] and 0xff00) == 0xff00',
    ],
  ],
  carried: [['return CARRIERS.some((c) => begins(p, c)) ? v4Of(p) : null;', 'return if (CARRIERS.any { begins(p, it) }) v4Of(p) else null']],
  begins: [['return head.every((x, i) => p[i] === x);', 'return head.indices.all { p[it] == head[it] }']],
  zeros: [['return p.slice(0, n).every((x) => x === 0);', 'return (0 until n).all { p[it] == 0 }']],
};

const lastReturn = (body: string) => body.slice(body.lastIndexOf('return '));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("the render engine's public-address rule is the protocol's (7.1)", () => {
  test('the same local names, IPv4 and IPv6 text, longest host and stand-in for the phone’s files', () => {
    const names = ktPattern('LOCAL_NAMES');
    expect(jsHolds(names.source, false)).toBe(true);
    expect(names.ignoreCase).toBe(true);
    expect(js).toMatch(/const LOCAL_NAMES = (\/.*\/i|new RegExp\('.*', 'i'\));/);
    expect(['DOTTED', 'TAIL', 'PIECE'].map((name) => [name, jsHolds(ktPattern(name).source, true)])).toEqual([['DOTTED', true], ['TAIL', true], ['PIECE', true]]);
    const maxHost = /export const MAX_HOST_CHARS = (\d+);/.exec(repo('shared', 'normalise.ts'))?.[1];
    expect(kt).toContain(`private const val MAX_HOST_CHARS = ${maxHost}`);
    expect(kt).toContain('private const val FILES_HOST = "filesystem.local"');
  });

  test('every private, loopback, link-local, shared and multicast IPv4 block, and no other', () => {
    const jsV4 = new Function('a', 'b', jsBody('privateV4')) as (a: number, b: number) => boolean;
    const block = new Function('a', 'b', ktBody('privateBlock'));
    const ktV4 = new Function('p', 'privateBlock', ktBody('privateV4')) as (p: number[], b: unknown) => boolean;
    const differ: string[] = [];
    for (const a of range(256)) for (const b of range(256)) if (ktV4([a, b, 0, 0], block) !== jsV4(a, b)) differ.push(`${a}.${b}`);
    expect(differ).toEqual([]);
    expect(jsV4(192, 168) && jsV4(169, 254) && !jsV4(8, 8)).toBe(true);
  });

  test('every unique local, link-local and multicast IPv6 prefix, and the addresses that reach IPv4', () => {
    const jsPrefix = new Function('p', lastReturn(jsBody('privateV6'))) as (p: number[]) => boolean;
    const ktPrefix = new Function('p', lastReturn(ktBody('privateV6'))) as (p: number[]) => boolean;
    expect(range(65536).filter((p0) => ktPrefix([p0]) !== jsPrefix([p0]))).toEqual([]);
    expect(jsPrefix([0xfe80]) && jsPrefix([0xfd00]) && jsPrefix([0xff02]) && !jsPrefix([0x2606])).toBe(true);
    // the /96 prefixes that reach the IPv4 address in their last 32 bits (mapped, translated, compatible and NAT64's
    // well-known prefix), and NAT64's prefix for a network's own use, none of it public: the same pieces on both sides
    expect(ktTable('CARRIERS')).toEqual(jsTable('CARRIERS'));
    expect(jsTable('CARRIERS')).toEqual([[0, 0, 0, 0, 0, 0xffff], [0, 0, 0, 0, 0xffff, 0], [0, 0, 0, 0, 0, 0], [0x64, 0xff9b, 0, 0, 0, 0]]);
    expect(ktPieces('LOCAL_NAT64')).toEqual(jsPieces('LOCAL_NAT64'));
    expect(jsPieces('LOCAL_NAT64')).toEqual([0x64, 0xff9b, 1]);
    // each side's privateV6 and the helpers it reads an address with, statement for statement (PORTED): :: and ::1,
    // then an address that reaches IPv4, then NAT64's prefix for a network's own use, then the prefixes. Each step used
    // to be looked for alone, so a step on one side only passed: a prefix added to the protocol and never to the WebView
    for (const [name, pairs] of Object.entries(PORTED)) {
      expect([name, jsSteps(name)]).toEqual([name, pairs.map(([j]) => j)]);
      expect([name, ktSteps(name)]).toEqual([name, pairs.flatMap(([, k]) => (k === null ? [] : [k]))]);
    }
    // and the same 32 bits read as the IPv4 address a carrier reaches
    expect(js).toContain('const v4Of = (p: number[]): number[] => [p[6] >> 8, p[6] & 255, p[7] >> 8, p[7] & 255];');
    expect(ktSteps('v4Of')).toEqual(['return intArrayOf(p[6] shr 8, p[6] and 255, p[7] shr 8, p[7] and 255)']);
  });

  test('a host is refused for a local name, the phone’s files over http, a private IPv6 or IPv4 address, in that order', () => {
    const rule = member(kt, 'isPublicWebUrl');
    const steps = [
      'val hostname = hostname(url) ?: return false', 'val host = hostname.removeSuffix(".")', 'if (localName(host) || fromFiles(url, host)) return false',
      'if (host.startsWith("[") || host.contains(\':\')) return !privateV6(host)', 'return if (v4 != null) !privateV4(v4) else true',
    ].map((s) => rule.indexOf(s));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(member(kt, 'localName')).toContain('return host.isEmpty() || LOCAL_NAMES.containsMatchIn(host) || (!host.contains(\'.\') && !host.contains(\':\'))');
    // as net/http's publicWeb rules: any host that begins with the stand-in over http, only the stand-in over https
    expect(member(kt, 'fromFiles')).toContain('return url.startsWith("http:", ignoreCase = true) && host.startsWith(FILES_HOST)');
    expect(['http://filesystem.localdata/x', 'http://filesystem.local.example.com/x', 'https://filesystem.local/x'].map(publicWeb)).toEqual([false, false, false]);
    expect(['https://filesystem.localdata/x', 'https://filesystem.local.example.com/x'].map(publicWeb)).toEqual([true, true]);
  });

  test('a host in no form Chromium writes one is refused rather than read as a name', () => {
    // a percent sign, a letter outside ASCII, a backslash, a space or a control; a number other than four decimal
    // parts (0x7f.1, 127.1, 2130706433, 010.0.0.1); a port past 65535; a host and port past MAX_HOST_CHARS
    const host = member(kt, 'hostname');
    expect(host).toContain("val written = authority.substring(authority.lastIndexOf('@') + 1)");
    expect(host).toContain('if (written.length > MAX_HOST_CHARS) return null');
    expect(host).toContain('return if (asWritten(host) && port(m.groupValues[2])) host.lowercase() else null');
    const written = member(kt, 'asWritten');
    expect(written).toContain("if (host.any { it <= ' ' || it >= '\\u007f' || it == '%' || it == '\\\\' }) return false");
    expect(written).toContain("return !NUMBER.matches(bare.substringAfterLast('.')) || (DECIMAL.matches(bare) && ipv4(bare) != null)");
    expect(ktPattern('NUMBER').source).toBe('\\d+|0[xX][0-9a-fA-F]*');
    expect(ktPattern('DECIMAL').source).toBe('(0|[1-9]\\d{0,2})(\\.(0|[1-9]\\d{0,2})){3}');
    expect(member(kt, 'port')).toContain('return n.length < 5 || n.length == 5 && n.toInt() <= 65535');
  });
});

describe("the render engine asks for no address a hop of the fetch couldn't go to (7.1, 8.2)", () => {
  const renderer = kotlinSource('kefli-parser', 'parser', 'Renderer.kt');
  /** One of the WebViewClient's overrides, up to the blank line after it. */
  const override = (name: string) => {
    const at = renderer.indexOf(`override fun ${name}(`);
    return at === -1 ? '' : renderer.slice(at, renderer.indexOf('\n\n', at));
  };

  test("a redirect or navigation to such an address isn't followed, and the page's own going there ends the render", () => {
    // a page that sent the engine to 192.168.1.1, or a challenge that went on to a loopback address, had the phone ask
    // it, and page.ts only refused the answer afterwards
    const nav = override('shouldOverrideUrlLoading');
    const steps = [
      'if (scheme != "https" && scheme != "http") return true', 'if (PublicWeb.isPublicWebUrl(request.url.toString())) return false',
      'if (request.isForMainFrame) main.post { refused(load) }', '\n        return true\n      }',
    ].map((s) => nav.indexOf(s));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(member(renderer, 'refused')).toContain('finish(load, failure("refused"))');
  });

  test('a frame or subresource asking one is answered empty in place of the network, and the page itself asking one ends the render', () => {
    // a script, a stylesheet, a frame, a fetch from the page's script or a form's POST to the router went out as the
    // page asked: Android shows a navigation to the client, and no other request, unless it is intercepted
    expect(override('shouldInterceptRequest')).toMatch(/: WebResourceResponse\? =\s+if \(askable\(load, request\)\) null else refusal\(load, request\)$/);
    const askable = member(renderer, 'askable');
    expect(askable).toContain('if (scheme != "https" && scheme != "http") return true');
    expect(askable).toContain('return given || PublicWeb.isPublicWebUrl(url)');
    const refusal = member(renderer, 'refusal');
    expect(refusal).toContain('if (request.isForMainFrame) main.post { refused(load) }');
    expect(refusal).toContain('return WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))');
  });

  test("the address given is asked for once, though it may be on the person's own network, and no other that isn't public", () => {
    // as the fetch asks for a page someone shared from their own network, and for no hop after it there
    expect(member(renderer, 'askable')).toContain(
      'val given = request.isForMainFrame && load.host != null && PublicWeb.hostname(url) == load.host && load.unasked.getAndSet(false)',
    );
    expect(renderer).toContain('val host = PublicWeb.hostname(url)');
    expect(renderer).toContain('val unasked = AtomicBoolean(true)');
  });

  test("a render that stopped there fails as a redirect the fetch won't follow does, the save keeping its link", async () => {
    const index = readFileSync(join(__dirname, '..', 'modules', 'kefli-parser', 'src', 'index.ts'), 'utf8');
    expect(index).toContain("{ ok: false; reason: 'no_webview' | 'timeout' | 'refused' }");
    // page.ts takes any failure but too_large as no render, so the fetch's own 403 is the answer
    expect(renderAnswer({ ok: false, reason: 'refused' })).toBeNull();
    const read: ParserResult = { ok: true, title: 'A story', byline: null, site: null, lang: 'en', hero: null, canonical: null, readerable: true, markdown: 'Words.\n' };
    const f = (async () => new Response('', { status: 403, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const p: PagePorts = { fetch: f, parse: async () => read, render: async () => renderAnswer({ ok: false, reason: 'refused' }) };
    expect(await fetchPage(p, 'https://cf.example/a')).toEqual({ kind: 'failed', reason: 'http', finalUrl: 'https://cf.example/a' });
  });
});
