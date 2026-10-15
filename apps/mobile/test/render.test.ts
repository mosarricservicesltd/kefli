// The render WebView asks for no address a hop of Kefli's own fetch couldn't go to (mobile spec 7.1, 8.2). Node can't
// run the Kotlin: these read kefli-parser's source, standing in for the check on the phone listed in HANDOVER, and
// hold its PublicWeb.kt to the rule it ports, packages/protocol's publicUrl.ts with net/http.ts's fromFiles, by running
// the two sides' blocks and prefixes over every address they decide. PublicWeb ran on the JVM against the protocol's
// answers too (20,239 addresses, each as written and as Chromium writes it).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publicWeb } from '../src/net/http';
import { kotlinSource, member } from './kotlin';

const kt = kotlinSource('kefli-parser', 'parser', 'PublicWeb.kt');
const repo = (...path: string[]) => readFileSync(join(__dirname, '..', '..', '..', ...path), 'utf8');
const js = repo('packages', 'protocol', 'src', 'publicUrl.ts');

/** A Kotlin Regex constant's pattern, its string's escapes undone, and whether it ignores case. */
function ktPattern(name: string): { source: string; ignoreCase: boolean } {
  const m = new RegExp(`val ${name} = Regex\\("((?:[^"\\\\]|\\\\.)*)"(, RegexOption\\.IGNORE_CASE)?\\)`).exec(kt);
  if (!m) throw new Error(`no Regex ${name}`);
  return { source: m[1].replace(/\\(.)/g, '$1'), ignoreCase: !!m[2] };
}

/** The pattern of the regex literal in publicUrl.ts that follows prefix. */
function jsPattern(prefix: string): string {
  const at = js.indexOf(prefix);
  if (at === -1) throw new Error(`no ${prefix}`);
  const m = /^\/(.*?)\/[a-z]*[;).]/.exec(js.slice(at + prefix.length));
  if (!m) throw new Error(`no pattern after ${prefix}`);
  return m[1];
}

/** A pattern the whole of a string must match, as Kotlin's matchEntire and matches read one: without its ^ and $. */
const whole = (pattern: string) => /^\^(.*)\$$/.exec(pattern)?.[1] ?? `not anchored: ${pattern}`;

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

const lastReturn = (body: string) => body.slice(body.lastIndexOf('return '));
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe("the render engine's public-address rule is the protocol's (7.1)", () => {
  test('the same local names, IPv4 and IPv6 text, longest host and stand-in for the phone’s files', () => {
    const names = ktPattern('LOCAL_NAMES');
    expect(names.source).toBe(jsPattern('const LOCAL_NAMES = '));
    expect(names.ignoreCase).toBe(true);
    expect(js).toMatch(/const LOCAL_NAMES = \/.*\/i;/);
    expect(ktPattern('DOTTED').source).toBe(whole(jsPattern('host.match(')));
    expect(ktPattern('TAIL').source).toBe(whole(jsPattern('h.match(')));
    expect(ktPattern('PIECE').source).toBe(whole(jsPattern('(p) => (')));
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
    // :: and ::1; mapped and compatible; NAT64's well-known prefix
    expect(js).toContain('if (zeros(7) && p[7] <= 1) return true;');
    expect(member(kt, 'privateV6')).toContain('if (zeros(p, 7) && p[7] <= 1) return true');
    expect(js).toContain('if ((zeros(5) && p[5] === 0xffff) || zeros(6)) return privateV4(v4Of(p));');
    expect(member(kt, 'carried')).toContain('val mapped = (zeros(p, 5) && p[5] == 0xffff) || zeros(p, 6)');
    expect(js).toContain('if (p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every((x) => x === 0)) return privateV4(v4Of(p));');
    expect(member(kt, 'carried')).toContain('val nat64 = p[0] == 0x64 && p[1] == 0xff9b && (2 until 6).all { p[it] == 0 }');
    expect(member(kt, 'privateV6')).toMatch(/val v4 = carried\(p\)\s+if \(v4 != null\) return privateV4\(v4\)/);
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
