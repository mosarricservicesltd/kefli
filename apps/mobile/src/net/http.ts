// Reads from the open web (mobile spec 5.4, 5.6; F12, F27): one deadline over the headers and the whole body, a cap
// counted while the body streams, and no cookies either way. expo/fetch resolves on the headers and its OkHttp client
// has no timeouts of its own, so a deadline cleared there leaves the body to a server that may send a byte a minute,
// and a cap checked after arrayBuffer() comes too late for an endless one. expo/fetch also sends and keeps cookies
// unless told otherwise, in the jar the WebViews share, so a site would know every later fetch for the same person.
//
// Redirects (5.4, 7.1): a page, an image or X's embed is asked for with redirect: 'manual', which expo/fetch (the
// global fetch on Android in SDK 57) honours by turning OkHttp's own following off and handing back the 3xx itself,
// Location and all (its NativeRequest.kt). Each hop is followed here, inside the one deadline, and its address is
// checked before it is asked for. Left to OkHttp, a saved page or an image could send the phone to 192.168.1.1, or
// to a loopback or link-local address; and since each hop followed here is a fresh request, which expo/fetch answers
// from the phone's own files when its address begins http://filesystem.local (fromFiles), such a host is refused at
// every hop as at the first (services/page.ts fetchable). A fetch that follows redirects anyway (React Native's own,
// under EXPO_PUBLIC_USE_RN_FETCH) has its answer refused when it says it ended somewhere a hop couldn't go.
//
// Cleartext (7.1): release builds allow none, and OkHttp refuses plain http before it connects. That refusal fails
// what was asked for (Blocked); read as the network, as it was, it left a save waiting for good.
import { isPublicWebUrl, urlParts } from '@kefli/protocol';

export class TimedOut extends Error {
  constructor() {
    super('timed out');
    this.name = 'TimedOut';
  }
}

export class TooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`over the cap at ${bytes} bytes`);
    this.name = 'TooLarge';
  }
}

/**
 * A fetch the phone won't make or finish, which asking again would only repeat, so what was asked for fails rather
 * than waiting as offline: a redirect to an address the caller doesn't allow, or one naming nowhere a request can
 * go (redirect); more redirects than the caller follows (redirects); or plain http, which the build refuses before
 * connecting (cleartext), in OkHttp's words "CLEARTEXT communication to ... not permitted by network security policy".
 */
export class Blocked extends Error {
  constructor(readonly why: 'redirect' | 'redirects' | 'cleartext') {
    super(`blocked: ${why}`);
    this.name = 'Blocked';
  }
}

/** How a fetch follows redirects itself: at most max of them, each to an address allow passes. */
export type Hops = { max: number; allow: (url: string) => boolean };

/** The most redirects a page, an image or X's embed is followed through (5.4); one more fails it. */
export const MAX_REDIRECTS = 10;

// expo/fetch's stand-in host for file: URLs, and every host that only begins with it; the stand-in itself, with or
// without the trailing dot a host may carry
const FILES_HOST = /^filesystem\.local/i;
const FILES_ITSELF = /^filesystem\.local\.?$/i;
// what the URL parser drops before it reads a scheme: leading controls and spaces, then every tab and newline
const LEADING = /^[\x00-\x20]+/;
const BREAKS = /[\t\n\r]/g;
const PLAIN = /^http:/i;

/**
 * Whether expo/fetch answers url from the phone's own files rather than the web. Its OkHttp client turns an address
 * whose text begins http://filesystem.local back into a file: URL, ahead of the network and of the cleartext rule,
 * and reads the rest as a path: the stand-in's own, or for a host that only begins with it, a path from the app's
 * working directory, the root, so http://filesystem.localdata/data/app.kefli/… reads /data/data/app.kefli/…. No such
 * host is a local name, so the public-address check passes it. RULED: the host is read as the protocol's URL parser
 * reads it, as OkHttp does (capitals, fullwidth letters, %2E, a port of 80). Over https only the stand-in itself is
 * refused: https://filesystem.local.example.com/ is a site like any other.
 */
export function fromFiles(url: string): boolean {
  const host = urlParts(url)?.hostname ?? '';
  if (!FILES_HOST.test(host)) return false;
  return FILES_ITSELF.test(host) || PLAIN.test(url.replace(LEADING, '').replace(BREAKS, ''));
}

/** An address the phone asks the open web for: public (7.1), and not one expo/fetch reads from its files. */
export function publicWeb(url: string): boolean {
  return isPublicWebUrl(url) && !fromFiles(url);
}

/** The open web's hops: ten at most, each to a public http(s) address (7.1). */
export const WEB_HOPS: Hops = { max: MAX_REDIRECTS, allow: publicWeb };

/** A response whose body is still under the deadline it was asked for with. */
export type Opened = {
  res: Response;
  /** The address the answer came from: the last hop's, or where a fetch that follows redirects itself says it ended. */
  url: string;
  /** The body, at most maxBytes: TooLarge past it (declared or streamed), TimedOut at the deadline. Ends the deadline. */
  read: (maxBytes: number) => Promise<Uint8Array>;
  /** Ends the deadline without reading the body, and lets the request go. */
  done: () => void;
};

const noop = () => undefined;

/** The Fetch Standard's redirect statuses: anything else, a 300 or a 304 among them, is an answer in itself. */
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Where a redirect sends its request next, resolved against the address that answered: null for an answer that is no
 * redirect (an empty Location among them), '' for a Location that names nowhere a request can go.
 */
export function redirectTo(res: Pick<Response, 'status' | 'headers'>, at: string): string | null {
  const to = REDIRECTS.has(res.status) ? res.headers.get('location') : null;
  if (!to) return null;
  try {
    return new URL(to, at).href;
  } catch {
    return '';
  }
}

/**
 * Whether an answer said to come from said, for a request to asked, has strayed from an address allow passes to one
 * it refuses, as a fetch or a browser engine that follows redirects itself can. An address the caller chose to ask
 * for though allow refuses it (a share of a page on the person's own network) is held to nothing more.
 */
export function strayed(hops: Hops, asked: string, said: string): boolean {
  return said !== asked && hops.allow(asked) && !hops.allow(said);
}

// a build's refusal of plain http, as OkHttp words it, wrapped by expo/fetch or not
const CLEARTEXT = /\bcleartext\b/i;

/**
 * What a failure to fetch was: the deadline's; the build refusing cleartext, which every later try would meet too,
 * where it read as the network and left the save waiting for good; or itself.
 */
function failure(e: unknown, late: boolean): unknown {
  if (late) return new TimedOut();
  return CLEARTEXT.test(String((e as Error | undefined)?.message ?? '')) ? new Blocked('cleartext') : e;
}

// an http address's host and port as written, with no user info: a string, as the code gate misreads regex literals
const PLAIN_HOST = new RegExp('^http://(?:[^@/?#]*@)?([^/?#]*)', 'i');

/**
 * RULED (services/save.ts, for shares): a public http:// address is fetched over https, as browsers now try first,
 * since release builds allow no cleartext. One with a port, and a local one (the local stack's own pages), keep their
 * http. Pending parses and article images ask the same way; a page with no https fails there as any page that can't
 * be had does, and the save keeps the address it has until its page parses.
 */
export function overHttps(url: string): string {
  const host = PLAIN_HOST.exec(url)?.[1];
  return host && !host.includes(':') && isPublicWebUrl(url) ? `https://${url.slice('http://'.length)}` : url;
}

/** The request a read is on: its controller changes with each hop, and the deadline lets go of the one current. */
type Line = { ctl: AbortController; late: boolean };

/** The answer at the end of the redirects, each hop asked for afresh under the line; without hops, the fetch's own. */
async function arrive(f: typeof fetch, url: string, init: RequestInit, line: Line, hops?: Hops): Promise<{ res: Response; url: string }> {
  let at = url;
  for (let n = 0; ; n++) {
    const res = await f(at, { ...init, credentials: 'omit', signal: line.ctl.signal, ...(hops ? { redirect: 'manual' as const } : {}) });
    const next = hops ? redirectTo(res, at) : null;
    if (next === null) return { res, url: arrived(res, at, hops) };
    // the redirect's own answer is let go, its body unread
    line.ctl.abort();
    if (n >= hops!.max) throw new Blocked('redirects');
    if (!hops!.allow(next)) throw new Blocked('redirect');
    if (line.late) throw new TimedOut();
    line.ctl = new AbortController();
    at = next;
  }
}

/** Where an answer came from: where the fetch says it ended, refused when that strays (strayed). */
function arrived(res: Response, at: string, hops?: Hops): string {
  const said = res.url || at;
  if (hops && strayed(hops, at, said)) throw new Blocked('redirect');
  return said;
}

/**
 * Fetches url with no cookies, the deadline running from now until the body is read or done() is called. With hops,
 * redirects are followed one at a time inside that deadline, each address checked before it is asked for (Blocked).
 */
export async function open(f: typeof fetch, url: string, init: RequestInit, timeoutMs: number, hops?: Hops): Promise<Opened> {
  const line: Line = { ctl: new AbortController(), late: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  // the deadline is raced as well as signalled, so a fetch or a body that ignores the abort still lets go
  const deadline = new Promise<never>((_, fail) => {
    timer = setTimeout(() => {
      line.late = true;
      line.ctl.abort();
      fail(new TimedOut());
    }, timeoutMs);
  });
  deadline.catch(noop);
  const end = () => clearTimeout(timer);
  let landed: { res: Response; url: string };
  try {
    landed = await Promise.race([arrive(f, url, init, line, hops), deadline]);
  } catch (e) {
    end();
    throw failure(e, line.late);
  }
  const { res } = landed;
  const read = async (maxBytes: number): Promise<Uint8Array> => {
    try {
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxBytes) throw new TooLarge(declared);
      return await Promise.race([body(res, maxBytes), deadline]);
    } catch (e) {
      line.ctl.abort();
      throw failure(e, line.late);
    } finally {
      end();
    }
  };
  const done = () => {
    end();
    line.ctl.abort();
  };
  return { res, url: landed.url, read, done };
}

/** The body chunk by chunk, refused as soon as it passes the cap; a fetch with no stream is read whole and then checked. */
async function body(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const whole = new Uint8Array(await res.arrayBuffer());
    if (whole.length > maxBytes) throw new TooLarge(whole.length);
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > maxBytes) throw new TooLarge(n);
      chunks.push(value);
    }
  } catch (e) {
    reader.cancel().catch(noop);
    throw e;
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
