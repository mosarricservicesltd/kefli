// Inbox-driven fetches refuse private, loopback and link-local addresses (mobile spec 7.1): a browser's save request
// names a URL the phone then fetches, which must not reach into the phone's own network, nor its own files.
//
// RULED: the host as written is checked (names that are local by convention, and IP literals in every form the URL
// parser accepts); names aren't resolved, and a redirect isn't followed up, since the phone's fetch doesn't expose
// either. That stops a request naming such an address outright, which is what the control is for.
//
// RULED: the host is read by the protocol's own parser (whatwg-url and tr46, as normalise reads it), never the
// platform's URL. The phone's URL is Expo's, with no Unicode step, so it left http://１２７.０.０.１/ (fullwidth digits)
// as written and passed it as public, while OkHttp, like every browser, maps it to 127.0.0.1.
import { urlParts } from '../../../shared/normalise';

const LOCAL_NAMES = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain|home\.arpa)$/i;

function ipv4(host: string): number[] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
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
  const tail = h.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let text = h;
  if (tail) {
    const v4 = ipv4(tail[2]);
    if (!v4) return null;
    text = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const side = (s: string) => (s === '' ? [] : s.split(':').map((p) => (/^[0-9a-f]{1,4}$/.test(p) ? parseInt(p, 16) : NaN)));
  const head = side(halves[0]);
  const rest = halves.length === 2 ? side(halves[1]) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 0) return null;
  const all = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest];
  return all.some((n) => Number.isNaN(n)) ? null : all;
}

/** The IPv4 address in the last 32 bits. */
const v4Of = (p: number[]): number[] => [p[6] >> 8, p[6] & 255, p[7] >> 8, p[7] & 255];

function privateV6(host: string): boolean {
  const p = pieces(host.replace(/^\[|\]$/g, '').toLowerCase());
  if (!p) return true;
  const zeros = (n: number) => p.slice(0, n).every((x) => x === 0);
  // :: and ::1; an IPv4 address mapped (::ffff:a.b.c.d) or, as written before RFC 4291 retired it, compatible (::a.b.c.d)
  if (zeros(7) && p[7] <= 1) return true;
  if ((zeros(5) && p[5] === 0xffff) || zeros(6)) return privateV4(v4Of(p));
  // NAT64's well-known prefix (64:ff9b::/96) reaches the IPv4 address in its last 32 bits
  if (p[0] === 0x64 && p[1] === 0xff9b && p.slice(2, 6).every((x) => x === 0)) return privateV4(v4Of(p));
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
