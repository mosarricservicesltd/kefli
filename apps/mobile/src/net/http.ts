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
// under EXPO_PUBLIC_USE_RN_FETCH) has its answer refused when it says it ended somewhere a hop couldn't go. Every
// request the phone makes to a blob server takes the same hops (serverHops): a text's blob servers, the inbox's and
// the mirrors, through open or, for calls written against a fetch (the protocol's Blossom calls), serverFetch; so a
// mirror, a server another app named or a save's text.servers can't send the phone into its own network either; and
// so does defaults.json (services/defaultsPick.ts), which no signature binds to its address. A hop to another origin
// is asked without the request's Authorization, as OkHttp's own following and browsers leave it out (RFC 9110, 15.4),
// and a 303, or a 301 or 302 to a POST, is followed with a GET and no body, as the Fetch Standard has it. Kefli's API
// takes no hop at all (NO_HOPS, apiFetch): each call to it is signed for its exact address, and a 3xx in its place
// fails the call as the API not answering.
//
// Cleartext (7.1): release builds allow none, and OkHttp refuses plain http before it connects. That refusal fails
// what was asked for (Blocked); read as the network, as it was, it left a save waiting for good. A read that follows
// its hops asks a public http address over https first, and as itself only when that can't be had (asked).
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
 * go, or for a caller that follows none (NO_HOPS) any 3xx or an answer that came through a redirect (redirect); more
 * redirects than the caller follows (redirects); or plain http, which the build refuses before connecting
 * (cleartext), in OkHttp's words "CLEARTEXT communication to ... not permitted by network security policy".
 */
export class Blocked extends Error {
  constructor(readonly why: 'redirect' | 'redirects' | 'cleartext') {
    super(`blocked: ${why}`);
    this.name = 'Blocked';
  }
}

/**
 * How a fetch follows redirects itself: at most max of them, each to an address allow passes. With max 0 it follows
 * none, and takes no 3xx as an answer, nor an answer that came through a redirect (NO_HOPS).
 */
export type Hops = { max: number; allow: (url: string) => boolean };

/**
 * No redirect at all: Kefli's API's hops (contract 6), in every call and on every build. Each call is signed with
 * NIP-98 for its exact address and method, so the API never answers through a redirect: a 3xx in its place, whatever
 * page it names, is no answer of the API's. Followed, a DELETE /account answered 303 to any page that answers 200 read
 * as the account deleted, and Delete my data went on to wipe the phone; a POST answered 301 or 302 went the same way.
 * Each fails the ask (Blocked), which every call reads as the API not answering: the outbox tries it again, and a
 * screen shows what it shows for the API unreachable.
 */
export const NO_HOPS: Hops = { max: 0, allow: () => false };

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

// a loopback host as the protocol's URL parser writes it (lowercase, IPv4 in dotted decimal, IPv6 compressed):
// localhost, with or without its trailing dot, 127.0.0.0/8 and ::1; a string, as the code gate misreads regex literals
const LOOPBACK = new RegExp('^(?:localhost\\.?|127(?:\\.\\d{1,3}){3}|\\[::1\\])$');

/** Whether url is an http(s) address on the phone's own loopback, as the local stack's servers are (adb reverse). */
export function loopback(url: string): boolean {
  return LOOPBACK.test(urlParts(url)?.hostname ?? '');
}

/** The local stack's hops: ten at most, each to a public address or to loopback, where its servers are. */
const LOCAL_HOPS: Hops = { max: MAX_REDIRECTS, allow: (url) => publicWeb(url) || loopback(url) };

/**
 * The hops a blob server's answer, or defaults.json's, may take (7.1): a page's (WEB_HOPS), so a mirror, a server
 * another app named in the 10063 or a save's text.servers can't send the phone to 192.168.1.1; and on the local stack
 * only (services/config.ts LOCAL_STACK, which the caller passes in), whose servers are on this machine, to loopback too.
 * Kefli's API takes none (NO_HOPS).
 */
export function serverHops(localStack: boolean): Hops {
  return localStack ? LOCAL_HOPS : WEB_HOPS;
}

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

// an http address as written up to its path: its user info, its host (an IPv6 one in its brackets) and any port; a
// string, as the code gate misreads regex literals
const PLAIN_AUTHORITY = new RegExp('^http://([^@/?#]*@)?(\\[[^\\]/?#]*\\]|[^:/?#]+)(?::([^/?#]*))?', 'i');
// a port as written that the URL parser reads as http's own, and drops: 80, with any leading zeros, or none at all
const HTTP_PORT = new RegExp('^(?:0*80)?$');

/**
 * RULED (services/save.ts, for shares): a public http:// address is fetched over https, as browsers now try first,
 * since release builds allow no cleartext. One with another port, and a local one (the local stack's own pages), keep
 * their http. http's own port written out (http://host:80/) is no port, as the URL parser reads it: the address goes
 * over https without it, where kept as a port its save failed at once on cleartext. A share's page, and a pending
 * parse's, are asked over https alone, so one with no https waits as any page that can't be had does, and the save
 * keeps the address it has until its page parses. The hops after it, and an article's images, fall back to the
 * address itself (asked).
 */
export function overHttps(url: string): string {
  const m = PLAIN_AUTHORITY.exec(url);
  if (!m || !HTTP_PORT.test(m[3] ?? '') || !isPublicWebUrl(url)) return url;
  return `https://${m[1] ?? ''}${m[2]}${url.slice(m[0].length)}`;
}

/** The request a read is on: its controller changes with each hop, and the deadline lets go of the one current. */
type Line = { ctl: AbortController; late: boolean };

/** An answer, and the address it came from. */
type Answered = { res: Response; at: string };

/**
 * One request of a read that follows its hops: a public http address with no port is asked for over https first
 * (overHttps), and as itself only when that can't be had (the deadline aside), which every build refuses once its
 * name resolves (Blocked) and the network being gone fails as the network. So a redirect through plain http, a
 * shortener's or an old link's, reaches the https its site now serves, and an image or a hop whose site has none
 * fails, where the https try read as the network: an image's run stopped there at every sync, none after it fetched.
 * An https address that redirected here, to its own http, isn't asked again: that would go round to the tenth hop.
 */
async function asked(f: typeof fetch, at: string, from: string, init: RequestInit, line: Line): Promise<Answered> {
  const tls = overHttps(at);
  if (tls !== at && tls !== from) {
    try {
      return { res: await f(tls, init), at: tls };
    } catch (e) {
      if (line.late) throw e;
    }
  }
  return { res: await f(at, init), at };
}

/** An address's scheme, host and port, which a hop's is compared with; '' for one that doesn't parse. */
function originOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

/**
 * Whether a redirect of this status turns a request of this method into a GET (the Fetch Standard, HTTP-redirect fetch):
 * a 303 does so to anything but a GET or a HEAD, and a 301 or 302 to a POST; a 307 or 308 never does.
 */
function asGet(method: string, status: number): boolean {
  if (status === 303) return method !== 'GET' && method !== 'HEAD';
  return (status === 301 || status === 302) && method === 'POST';
}

// the headers that describe a request's body, which go when the body does (the Fetch Standard's request-body-header
// names)
const BODY_HEADERS = ['content-encoding', 'content-language', 'content-location', 'content-type'];

/**
 * The request as a hop from at to next asks it, after an answer of this status. An Authorization header goes no
 * further than its own origin (RFC 9110, 15.4), as OkHttp's own following and browsers drop it, so a redirect can't
 * hand a blob server's authorisation to another server. A redirect that turns the request into a GET (asGet) asks
 * without the body or the headers that describe it, as browsers do: sent again, a call answered 303 went on with its
 * method and its body.
 */
function onwards(init: RequestInit, status: number, at: string, next: string): RequestInit {
  const headers = new Headers(init.headers);
  const away = headers.has('authorization') && originOf(at) !== originOf(next);
  const get = asGet((init.method ?? 'GET').toUpperCase(), status);
  if (!away && !get) return init;
  if (away) headers.delete('authorization');
  if (!get) return { ...init, headers };
  for (const name of BODY_HEADERS) headers.delete(name);
  return { ...init, method: 'GET', headers, body: null };
}

/** The answer at the end of the redirects, each hop asked for afresh under the line; without hops, the fetch's own. */
async function arrive(f: typeof fetch, url: string, init: RequestInit, line: Line, hops?: Hops): Promise<{ res: Response; url: string }> {
  let at = url;
  let from = '';
  let ask = init;
  for (let n = 0; ; n++) {
    const opts: RequestInit = { ...ask, credentials: 'omit', signal: line.ctl.signal };
    const got: Answered = hops ? await asked(f, at, from, { ...opts, redirect: 'manual' }, line) : { res: await f(at, opts), at };
    const next = hops ? redirectTo(got.res, got.at) : null;
    if (next === null) return { res: got.res, url: arrived(got.res, got.at, hops) };
    // the redirect's own answer is let go, its body unread
    line.ctl.abort();
    if (!hops!.allow(next)) throw new Blocked('redirect');
    if (n >= hops!.max) throw new Blocked('redirects');
    if (line.late) throw new TimedOut();
    line.ctl = new AbortController();
    ask = onwards(ask, got.res.status, got.at, next);
    from = got.at;
    at = next;
  }
}

/**
 * Where an answer came from: where the fetch says it ended, refused when that strays (strayed) and, for a caller that
 * follows no redirect, when it is one or came through one (through).
 */
function arrived(res: Response, at: string, hops?: Hops): string {
  const said = res.url || at;
  if (hops && (strayed(hops, at, said) || through(hops, res, at, said))) throw new Blocked('redirect');
  return said;
}

/**
 * For a caller that follows no redirect (max 0, NO_HOPS): whether an answer is a 3xx of any kind, one with no
 * Location, a 300 or a 304 as much as a redirect, or came through a redirect, by the fetch's own word (redirected) or
 * by the address it says it came from, as a fetch that follows redirects itself (React Native's own) hands back the
 * last hop's answer as if it were the first's. at is the address asked, after any move to https (asked).
 */
function through(hops: Hops, res: Response, at: string, said: string): boolean {
  if (hops.max > 0) return false;
  return (res.status >= 300 && 400 > res.status) || res.redirected === true || !sameAddress(said, at);
}

/** Whether two addresses are one as the URL parser writes them, as OkHttp writes the one it asked; else as written. */
function sameAddress(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
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

/**
 * How long a request to a server has for its whole answer, headers and body, when it sends little: Kefli's API in
 * every call, as GET /account has (services/account.ts ACCOUNT_TIMEOUT_MS), and a blob's deletion. expo/fetch's
 * OkHttp client has no timeout of its own, so without one a server that takes the connection and never answers held
 * what asked it for good: the outbox's run, or Delete my data, whose screen swallows Back while it runs.
 */
export const SERVER_TIMEOUT_MS = 15_000;

/**
 * The deadline for a request that moves a blob before it is answered, an upload or a mirror's copy: a server's 15 s
 * and a second more for every 32 KB, as the extension gives its uploads (its save.ts uploadTimeoutMs), so the largest
 * text still has a slow uplink's time.
 */
export function movingMs(bytes: number): number {
  return SERVER_TIMEOUT_MS + Math.ceil(bytes / 32_768) * 1000;
}

/**
 * The most of a server's answer read, unless the caller reads blobs: a Blossom descriptor or refusal and every answer
 * of Kefli's API are a few hundred bytes, as the extension reads them too (its save.ts ANSWER_MAX_BYTES).
 */
export const ANSWER_MAX_BYTES = 65_536;

/** How a request to a server is made: the hops its redirects may take, its deadline, and the most of its body read. */
export type ServerAsk = { hops: Hops; timeoutMs: number; maxBytes?: number };

/**
 * A server's answer with its body read already (serverFetch): the part of Response the phone's calls use, its status
 * and headers as the last hop sent them and its body as bytes, text or JSON, as often as asked. A body past the cap
 * fails each read of it (TooLarge), the status and headers still there, so a call that needs only the status has it.
 * Built here rather than as a Response: React Native's own decodes a body of bytes as Latin-1.
 */
class Answer {
  constructor(private readonly res: Response, readonly url: string, private readonly got: Uint8Array | TooLarge) {}

  get status(): number {
    return this.res.status;
  }

  get ok(): boolean {
    return this.status >= 200 && 300 > this.status;
  }

  get statusText(): string {
    return this.res.statusText;
  }

  get headers(): Headers {
    return this.res.headers;
  }

  async bytes(): Promise<Uint8Array> {
    if (this.got instanceof TooLarge) throw this.got;
    return this.got.slice();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this.bytes()).buffer as ArrayBuffer;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes());
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

/** The answer o opened, its body read within o's deadline, up to maxBytes; past them, kept as the body's failure. */
async function answered(o: Opened, maxBytes: number): Promise<Answer> {
  try {
    return new Answer(o.res, o.url, await o.read(maxBytes));
  } catch (e) {
    if (e instanceof TooLarge) return new Answer(o.res, o.url, e);
    throw e;
  }
}

/** The address a server is asked at: the calls pass a string. A Request's own method, headers and body aren't read here. */
function addressOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  throw new TypeError('a server is asked by its address');
}

/**
 * fetch for a server, for calls written against a fetch (the protocol's uploadBlob, mirrorBlob and deleteBlob, and the
 * phone's own to Kefli's API, through apiFetch): no cookies, each redirect followed here with its address checked first
 * (open, with ask.hops), and the whole answer, headers and body, had within ask.timeoutMs, at most ask.maxBytes of the
 * body kept. A hop where none may go rejects (Blocked), as the deadline (TimedOut) and the network do, and each call
 * reads all three as the server not answering; past the cap, only the body's reads fail.
 */
export function serverFetch(f: typeof fetch, ask: ServerAsk): typeof fetch {
  const get = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const o = await open(f, addressOf(input), init ?? {}, ask.timeoutMs, ask.hops);
    return (await answered(o, ask.maxBytes ?? ANSWER_MAX_BYTES)) as unknown as Response;
  };
  return get as typeof fetch;
}

/**
 * fetch for Kefli's API (contract 6), in every call the phone makes to it: the outbox's register, browsers' and
 * removals, GET and DELETE /account (Advanced's check, Delete my data's and a move's), Connect's lookup and pairing a
 * phone's. serverFetch with no redirect followed or taken (NO_HOPS), on every build, the local stack's included, whose
 * API never redirects either; the API's deadline; and an answer's cap.
 */
export function apiFetch(f: typeof fetch): typeof fetch {
  return serverFetch(f, { hops: NO_HOPS, timeoutMs: SERVER_TIMEOUT_MS });
}
