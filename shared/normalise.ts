// URL normalisation, the reference implementation of contract section 4.3.
//
// A save's d tag is "shelf/item/" + sha256(normalise(finalUrl, canonical)), so this function must give
// the same string on every engine: V8 in the extension, Hermes on the phone. It therefore never uses
// the platform's URL. Parsing and serialisation come from the whatwg-url package, which is the URL
// Standard in plain JavaScript and takes its host through UTS-46 with tr46 (non-transitional, CheckBidi
// and CheckJoiners on, the Standard's own settings). Every port must pass shared/normalise.fixtures.json.
//
// Where the contract text leaves a choice open, the choice is marked RULED: settled with contract 1.4
// (section 11.1) and listed in the fixtures' rulings.

import { URL } from 'whatwg-url';

/** Query parameters removed on every host (contract 4.3). Names starting utm_ go too. */
const TRACKING = new Set(['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref', 'igshid']);
/** Removed only on twitter.com and x.com. */
const X_TRACKING = new Set(['s', 't']);

/** Thrown for anything that can't be saved as a link: not a URL, or not http or https. */
const shorten = (s: string) => (s.length > 200 ? s.slice(0, 200) + '…' : s);

export class NotALinkError extends Error {
  constructor(input: string, reason: string) {
    super('not a link (' + reason + '): ' + shorten(input));
    this.name = 'NotALinkError';
  }
}

function parseHttp(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new NotALinkError(input, 'unparseable');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new NotALinkError(input, url.protocol);
  return url;
}

// RULED: on the X hosts themselves and their subdomains (mobile.twitter.com, www.x.com).
function isXHost(host: string): boolean {
  return ['twitter.com', 'x.com'].some((h) => host === h || host.endsWith(`.${h}`));
}

// A query name as URLSearchParams reads it: '+' is a space, then percent-decoded as UTF-8.
// RULED: names are compared and sorted in this decoded form, as URLSearchParams.sort() does, but the
// pairs are kept byte for byte as the URL serialised them, so nothing is re-encoded.
function queryName(pair: string): string {
  const eq = pair.indexOf('=');
  const raw = (eq === -1 ? pair : pair.slice(0, eq)).replace(/\+/g, ' ');
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function cleanQuery(search: string, xHost: boolean): string {
  if (search === '') return '';
  const kept = search
    .slice(1)
    .split('&')
    .filter((pair) => pair !== '')
    .map((pair) => ({ pair, name: queryName(pair) }))
    .filter(({ name }) => !name.startsWith('utm_') && !TRACKING.has(name) && !(xHost && X_TRACKING.has(name)));
  // Array.prototype.sort is stable on every engine since ES2019, so equal names keep their order.
  // Names compare by UTF-16 code units, as URLSearchParams.sort() compares them.
  kept.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return kept.length ? `?${kept.map(({ pair }) => pair).join('&')}` : '';
}

// The mobile and AMP forms that the canonical link replaces (contract 4.3).
function isAlternateForm(url: URL): boolean {
  return /^(m|amp)\./.test(url.hostname) || /\/amp\/?$/.test(url.pathname);
}

/**
 * normalise(url, canonical?) from contract 4.3. Throws NotALinkError for input that isn't an http or
 * https URL. The canonical link is used only for m. and amp. hosts and paths ending /amp; RULED: a
 * canonical that isn't itself an http or https URL is ignored rather than refusing the save.
 */
export function normalise(input: string, canonical?: string | null): string {
  const url = parseHttp(input);

  if (canonical && isAlternateForm(url)) {
    try {
      return normalise(canonical);
    } catch (e) {
      if (!(e instanceof NotALinkError)) throw e;
    }
  }

  const query = cleanQuery(url.search, isXHost(url.hostname));
  url.hash = '';
  url.search = '';
  // A trailing slash goes except on a bare host, whose path is "/" and always serialises.
  // RULED: every trailing slash goes, so that normalise is idempotent ("/a//" would otherwise give "/a/"
  // and then "/a"); a path of slashes only becomes "/".
  const path = url.pathname.replace(/\/+$/, '');
  if (path !== url.pathname) url.pathname = path === '' ? '/' : path;
  return url.href + query;
}
