// URL normalisation, the reference implementation of contract section 4.3.
//
// A save's d tag is "kefli/item/" + sha256(normalise(finalUrl, canonical)), so this function must give
// the same string on every engine: V8 in the extension, Hermes on the phone. It therefore never uses
// the platform's URL. Parsing and serialisation come from the whatwg-url package, which is the URL
// Standard in plain JavaScript and takes its host through UTS-46 with tr46 (non-transitional, CheckBidi
// and CheckJoiners on, the Standard's own settings). Every port must pass shared/normalise.fixtures.json.
// It works on the Standard's URL record (basicURLParse, serializeURL) rather than the package's URL class,
// whose webidl-conversions reads SharedArrayBuffer at load, which Hermes doesn't have.
//
// Where the contract text leaves a choice open, the choice is marked RULED and listed in the fixtures' rulings: settled
// with contract 1.4 (section 11.9), and rulings 8, 11 and 12 as they now stand with contract 1.12 (section 11.1).

/// <reference path="./whatwg-url-state-machine.d.ts" />
import type { URLRecord } from 'whatwg-url';
import { basicURLParse, serializeHost, serializePath, serializeURL } from 'whatwg-url/lib/url-state-machine';

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

/**
 * RULED: a host written longer than this, its port included, is refused before the URL is parsed. No host that DNS
 * can resolve comes near it (253 characters in ASCII), and UTS-46 takes time that grows with the square of a label's
 * length: a shared link whose host was 30,000 different CJK characters held the phone's JavaScript for minutes, at
 * every start while its share waited in the spool.
 */
export const MAX_HOST_CHARS = 1024;

// An http(s) URL's authority as written, after what the URL Standard does first: tabs and newlines go, leading C0
// controls and spaces are skipped, and so is any run of slashes or backslashes after the scheme. Built from strings,
// as the code gate's parser misreads regex literals.
const AUTHORITY = new RegExp('^[\\u0000-\\u0020]*https?:[\\\\/]*([^\\\\/?#]*)', 'i');
const TAB_OR_NEWLINE = new RegExp('[\\t\\n\\r]', 'g');

/** The host and port of an http(s) URL as written, after any user info; '' for anything else. */
function writtenHost(input: string): string {
  const m = AUTHORITY.exec(input.replace(TAB_OR_NEWLINE, ''));
  return m ? m[1].slice(m[1].lastIndexOf('@') + 1) : '';
}

function parseHttp(input: string): URLRecord {
  if (writtenHost(input).length > MAX_HOST_CHARS) throw new NotALinkError(input, 'host too long');
  const url = basicURLParse(input);
  if (!url) throw new NotALinkError(input, 'unparseable');
  if (url.scheme !== 'http' && url.scheme !== 'https') throw new NotALinkError(input, `${url.scheme}:`);
  return url;
}

/** A URL record's host as it serialises, lowercase and in ASCII, without its port; '' for none. */
function hostOf(url: URLRecord): string {
  return url.host === null ? '' : serializeHost(url.host);
}

/** The parts of an http or https URL the protocol's rules look at, or null for anything else. */
export function urlParts(input: string): { scheme: 'http' | 'https'; hostname: string; pathname: string } | null {
  try {
    const url = parseHttp(input);
    return { scheme: url.scheme as 'http' | 'https', hostname: hostOf(url), pathname: serializePath(url) };
  } catch {
    return null;
  }
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

// A host's leading m. or amp. label, the mobile and AMP forms', and its leading www.
const ALTERNATE_LABEL = /^(m|amp)\./;
const WWW_LABEL = /^www\./;

// The mobile and AMP forms that the canonical link replaces (contract 4.3).
function isAlternateForm(hostname: string, pathname: string): boolean {
  return ALTERNATE_LABEL.test(hostname) || /\/amp\/?$/.test(pathname);
}

/** Whether a host has two labels or more, not counting the empty one a trailing dot leaves: com. is one label. */
const twoLabels = (host: string): boolean => host.split('.').filter((label) => label !== '').length >= 2;

/**
 * RULED (ruling 12): shared hosting, whose sites are different people's, each at a name of its own under the domain,
 * and on some of which every user's posts are at the domain itself (www.tumblr.com, medium.com, substack.com). There a
 * leading m. or amp. label can be a user's own name, so a blog at amp.tumblr.com could otherwise name another user's
 * post at www.tumblr.com as its canonical, and land on, or replace, a save of it. A page on one of these domains, or
 * on a name under one, takes a canonical only from its own host (sameSite).
 */
export const SHARED_HOSTING: readonly string[] = Object.freeze([
  'blogspot.com', 'github.io', 'medium.com', 'neocities.org', 'netlify.app',
  'pages.dev', 'substack.com', 'tumblr.com', 'vercel.app', 'wordpress.com',
]);

/** Whether host, its trailing dots aside, is one of SHARED_HOSTING's domains or a name under one. */
function onSharedHosting(host: string): boolean {
  let end = host.length;
  while (end > 0 && host[end - 1] === '.') end--;
  const name = host.slice(0, end);
  return SHARED_HOSTING.some((domain) => name === domain || name.endsWith(`.${domain}`));
}

/**
 * RULED: whether a canonical link on canonicalHost can stand for a page on pageHost (contract 4.3, ruling 11): only
 * from the page's own site, or a page at amp.evil.example could take another site's address and land on, or replace,
 * a save of it. The canonical's host is the page's, or equals it once a leading m. or amp. label is taken off the
 * page's and then a leading www. off each, provided the page's host so shortened still has two labels (m.com is no
 * mobile form of com, nor m.com. of com.). A page on shared hosting takes a canonical only from its own host (ruling
 * 12). Hosts are compared as the URL record serialises them: in ASCII, lowercase, without their ports.
 */
function sameSite(pageHost: string, canonicalHost: string): boolean {
  if (canonicalHost === pageHost) return true;
  if (onSharedHosting(pageHost)) return false;
  const site = pageHost.replace(ALTERNATE_LABEL, '').replace(WWW_LABEL, '');
  return twoLabels(site) && canonicalHost.replace(WWW_LABEL, '') === site;
}

/** The canonical's URL record, when it is an http or https URL on the page's own site (sameSite); null otherwise. */
function siteCanonical(pageHost: string, canonical: string): URLRecord | null {
  let target: URLRecord;
  try {
    target = parseHttp(canonical);
  } catch (e) {
    if (e instanceof NotALinkError) return null;
    throw e;
  }
  return sameSite(pageHost, hostOf(target)) ? target : null;
}

/** input, whose URL record url is, exactly as given when it holds no user info; else url serialised without it. */
function unauthenticated(input: string, url: URLRecord): string {
  if (url.username === '' && url.password === '') return input;
  url.username = '';
  url.password = '';
  return serializeURL(url);
}

/**
 * The canonical link a save keeps for the page at url (contract 4.3): canonical when it is an http or https URL on the
 * page's own site (rulings 11 and 12), without any user name and password (ruling 8), otherwise null, as for a page
 * that names none. A relative canonical takes the user info of the address it is resolved against, which on the phone
 * is where the fetch ended and keeps what was shared. The extension's capture and the phone's parse keep a page's
 * canonical through this, so a save's is always one normalise could take. Never throws: a canonical is a page's hint,
 * and a page or canonical that isn't a link keeps none.
 */
export function ownCanonical(url: string, canonical: string | null | undefined): string | null {
  if (!canonical) return null;
  try {
    const target = siteCanonical(hostOf(parseHttp(url)), canonical);
    return target && unauthenticated(canonical, target);
  } catch {
    return null;
  }
}

/**
 * input without its user name and password (ruling 8), as the extension sends a page's address; everything else in it
 * as the URL Standard serialises it. An address with no user info, or input that isn't an http or https URL, comes back
 * exactly as given.
 */
export function withoutUserInfo(input: string): string {
  let url: URLRecord;
  try {
    url = parseHttp(input);
  } catch {
    return input;
  }
  return unauthenticated(input, url);
}

/**
 * normalise(url, canonical?) from contract 4.3. Throws NotALinkError for input that isn't an http or
 * https URL. The canonical link is used only for m. and amp. hosts and paths ending /amp, and only from the
 * page's own site (sameSite); RULED: a canonical that isn't itself an http or https URL is ignored rather than
 * refusing the save.
 */
export function normalise(input: string, canonical?: string | null): string {
  const url = parseHttp(input);
  const hostname = hostOf(url);
  const own = canonical && isAlternateForm(hostname, serializePath(url)) ? siteCanonical(hostname, canonical) : null;
  return address(own ?? url);
}

/** A URL record as a save's address: no fragment or user info, the query cleaned, every trailing slash removed. */
function address(url: URLRecord): string {
  const query = cleanQuery(url.query ? `?${url.query}` : '', isXHost(hostOf(url)));
  url.fragment = null;
  url.query = null;
  // RULED: a user name and password are no part of a save's address (ruling 8), so the same page saved with them and
  // without them is one save, and no address or hash holds a password
  url.username = '';
  url.password = '';
  // A trailing slash goes except on a bare host, whose path is "/" and always serialises.
  // RULED: every trailing slash goes, so that normalise is idempotent ("/a//" would otherwise give "/a/"
  // and then "/a"); a path of slashes only becomes "/". http and https paths are always segment lists.
  const path = url.path as string[];
  while (path.length > 1 && path[path.length - 1] === '') path.pop();
  return serializeURL(url) + query;
}
