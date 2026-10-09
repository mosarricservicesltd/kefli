// The four URL-record functions shared/normalise.ts takes from whatwg-url's state machine, built on the browser's own
// URL, which in Chrome and Firefox is the URL Standard with UTS-46 hosts. build.mjs puts this in place of
// 'whatwg-url/lib/url-state-machine' for the extension only, which leaves out the package, tr46 and @exodus/bytes:
// about 800 KB of each bundle. The phone keeps whatwg-url, since Hermes has no URL of its own. A normalise built on this
// must give every answer in shared/normalise.fixtures.json, which test/urlRecord.test.ts checks under Node's URL and
// scripts/normalise.mjs in Chrome.

/** The parts of the Standard's URL record that normalise reads and writes; the host is held already serialised. */
export interface UrlRecord {
  scheme: string;
  username: string;
  password: string;
  host: string | null;
  port: string | null;
  /** Segments for an http or https URL; an opaque path (mailto:) is one string, as in the Standard. */
  path: string[] | string;
  query: string | null;
  fragment: string | null;
}

function record(u: URL): UrlRecord {
  const special = /^\//.test(u.pathname);
  return {
    scheme: u.protocol.slice(0, -1),
    username: u.username,
    password: u.password,
    host: u.host === '' && !special ? null : u.hostname,
    port: u.port === '' ? null : u.port,
    path: special ? u.pathname.slice(1).split('/') : u.pathname,
    query: u.search === '' ? null : u.search.slice(1),
    fragment: u.hash === '' ? null : u.hash.slice(1),
  };
}

// An http(s) URL's host, between the scheme's slashes and the path, without user info or port.
const AUTHORITY = /^(https?:\/\/)(?:[^@/?#]*@)?([^/?#:]*)/i;
// The URL Standard's forbidden domain code points that ASCII can hold, which still refuse a host.
const FORBIDDEN = /[\x00-\x20#%/:<>?@[\\\]^|\x7f]/;
// A host whose last label is a number is an IPv4 address to the Standard, and refused if it isn't a valid one.
const ENDS_IN_NUMBER = /(^|\.)(0x[0-9a-f]*|[0-9]+)\.?$/i;

/**
 * Since 2026 the URL Standard only lowercases a host that is all ASCII, with no punycode check, so "XN--A.com" parses
 * (shared/normalise.fixtures.json). Engines still on the older rule refuse it: for those, the URL is parsed with a
 * stand-in host and the record takes the real one lowercased, which is the newer rule exactly.
 */
function asciiHostRetry(input: string): UrlRecord | null {
  const m = AUTHORITY.exec(input);
  const host = m?.[2] ?? '';
  if (!m || host === '' || !/^[\x21-\x7e]+$/.test(host) || FORBIDDEN.test(host) || ENDS_IN_NUMBER.test(host)) return null;
  try {
    const r = record(new URL(input.replace(AUTHORITY, (all) => all.replace(host, 'stand-in.invalid'))));
    return { ...r, host: host.toLowerCase() };
  } catch {
    return null;
  }
}

/** The input parsed as the URL Standard does, or null where it fails. */
export function basicURLParse(input: string): UrlRecord | null {
  try {
    return record(new URL(input));
  } catch {
    return asciiHostRetry(input);
  }
}

export function serializeHost(host: string): string {
  return host;
}

export function serializePath(url: Pick<UrlRecord, 'path'>): string {
  return typeof url.path === 'string' ? url.path : `/${url.path.join('/')}`;
}

export function serializeURL(url: UrlRecord): string {
  const auth = url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  const host = url.host === null ? '' : `//${auth}${url.host}${url.port === null ? '' : `:${url.port}`}`;
  return `${url.scheme}:${host}${serializePath(url)}${url.query === null ? '' : `?${url.query}`}${url.fragment === null ? '' : `#${url.fragment}`}`;
}
