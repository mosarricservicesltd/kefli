// Inbox-driven fetches refuse private, loopback and link-local addresses (mobile spec 7.1): a browser's save request
// names a URL the phone then fetches, which must not reach into the phone's own network, nor its own files.
//
// RULED: the host as written is checked (names that are local by convention, and IP literals in every form the URL
// parser accepts); names aren't resolved, since the phone's fetch doesn't expose that. That stops a request naming
// such an address outright, which is what the control is for; the phone follows each redirect itself and checks
// every hop with this too (apps/mobile net/http).
//
// RULED: the host is read by the protocol's own parser (whatwg-url and tr46, as normalise reads it), never the
// platform's URL. The phone's URL is Expo's, with no Unicode step, so it left http://１２７.０.０.１/ (fullwidth digits)
// as written and passed it as public, while OkHttp, like every browser, maps it to 127.0.0.1.
import { urlParts } from '../../../shared/normalise';

// built from strings: lizard, which the code gate uses, loses its place in these as regex literals, and with it every
// function after them, isPublicWebUrl among them
const LOCAL_NAMES = new RegExp('(^|\\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\\.arpa)$', 'i');
const DOTTED = new RegExp('^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$');
const V4_TAIL = new RegExp('^(.*:)(\\d+\\.\\d+\\.\\d+\\.\\d+)$');
const HEX_PIECE = new RegExp('^[0-9a-f]{1,4}$');

function ipv4(host: string): number[] | null {
  const m = DOTTED.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

function privateV4([a, b]: number[]): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** An IPv6 address as its eight 16-bit pieces, or null; a dotted IPv4 tail counts as the last two. */
function pieces(h: string): number[] | null {
  const tail = V4_TAIL.exec(h);
  let text = h;
  if (tail) {
    const v4 = ipv4(tail[2]);
    if (!v4) return null;
    text = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const side = (s: string) => (s === '' ? [] : s.split(':').map((p) => (HEX_PIECE.test(p) ? parseInt(p, 16) : NaN)));
  const head = side(halves[0]);
  const rest = halves.length === 2 ? side(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  // written 0 > fill: lizard, which the code gate uses, reads fill < as the start of a generic
  if (halves.length === 1 ? head.length !== 8 : 0 > fill) return null;
  const all = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest];
  return all.some((n) => Number.isNaN(n)) ? null : all;
}

/** The IPv4 address in the last 32 bits. */
const v4Of = (p: number[]): number[] => [p[6] >> 8, p[6] & 255, p[7] >> 8, p[7] & 255];

/**
 * The IPv6 prefixes, each a /96 written as its first six pieces, whose addresses reach the IPv4 address in their last
 * 32 bits: such an address is as private as that IPv4 address.
 */
const CARRIERS = [
  [0, 0, 0, 0, 0, 0xffff], // mapped, ::ffff:a.b.c.d
  [0, 0, 0, 0, 0xffff, 0], // translated, ::ffff:0:a.b.c.d (RFC 2765)
  [0, 0, 0, 0, 0, 0], // compatible, ::a.b.c.d, as written before RFC 4291 retired it
  [0x64, 0xff9b, 0, 0, 0, 0], // NAT64's well-known prefix, 64:ff9b::/96 (RFC 6052)
];

/**
 * NAT64's prefix for a network's own use, 64:ff9b:1::/48 (RFC 8215), as its first three pieces: it reaches an IPv4
 * address its network chooses, at a place in the address its network chooses, so none of it is public.
 */
const LOCAL_NAT64 = [0x64, 0xff9b, 1];

/** Whether an IPv6 address's first n pieces are all zero. */
function zeros(p: number[], n: number): boolean {
  return p.slice(0, n).every((x) => x === 0);
}

/** Whether an IPv6 address begins with these pieces. */
function begins(p: number[], head: number[]): boolean {
  return head.every((x, i) => p[i] === x);
}

/** The IPv4 address an IPv6 one reaches (CARRIERS), or null. */
function carried(p: number[]): number[] | null {
  return CARRIERS.some((c) => begins(p, c)) ? v4Of(p) : null;
}

function privateV6(host: string): boolean {
  const p = pieces(host.replace(/^\[|\]$/g, '').toLowerCase());
  if (!p) return true;
  // :: and ::1
  if (zeros(p, 7) && p[7] <= 1) return true;
  const v4 = carried(p);
  if (v4) return privateV4(v4);
  if (begins(p, LOCAL_NAT64)) return true;
  // unique local fc00::/7, link-local fe80::/10, multicast ff00::/8
  return (p[0] & 0xfe00) === 0xfc00 || (p[0] & 0xffc0) === 0xfe80 || (p[0] & 0xff00) === 0xff00;
}

/** Whether a host, without its trailing dot, is local by name: none, a single label, or one of LOCAL_NAMES. */
function localName(host: string): boolean {
  return !host || LOCAL_NAMES.test(host) || (!host.includes('.') && !host.includes(':'));
}

// expo/fetch's stand-in host for file: URLs, and every host that only begins with it
const FILES_HOST = /^filesystem\.local/i;

/**
 * RULED: whether the phone's fetch reads an address from its own files rather than the web. expo/fetch's OkHttp client
 * turns any address whose text begins http://filesystem.local back into a file: URL, ahead of the network and of the
 * cleartext rule, and reads the rest as a path: the stand-in's own or, for a host that only begins with it, one from
 * the app's working directory, the root, so http://filesystem.localdata/data/app.kefli/… reads /data/data/app.kefli/….
 * The host is read as the protocol's parser reads it, as OkHttp does (capitals, full-width letters, %2E, a port of 80).
 * Over https the stand-in itself is a local name, and any other host is the web's to answer (as the phone's net/http
 * fromFiles rules).
 */
const fromFiles = (scheme: string, host: string): boolean => scheme === 'http' && FILES_HOST.test(host);

/**
 * True for an http(s) URL whose host is neither local by name nor a private, loopback or link-local address, nor one
 * the phone's fetch reads from its own files (fromFiles).
 */
export function isPublicWebUrl(url: string): boolean {
  const u = urlParts(url);
  if (!u) return false;
  const host = u.hostname.replace(/\.$/, '');
  if (localName(host) || fromFiles(u.scheme, host)) return false;
  if (host.startsWith('[') || host.includes(':')) return !privateV6(host);
  const v4 = ipv4(host);
  return v4 ? !privateV4(v4) : true;
}
