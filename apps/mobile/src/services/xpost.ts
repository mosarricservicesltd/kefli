// Checking a shared X post (mobile spec 5.4, FD 78, G3): a post is never saved as itself; the first link in it that
// leaves X is. The embed service is asked with a 5 s timeout over its whole answer; t.co links are followed without
// a browser user agent, five hops at most; neither sends or keeps cookies. The rules for which link counts are
// packages/protocol's (x.ts). Offline, or with X's service failing, the post waits as a pending save and is checked
// again. Ports, so this runs in tests.
import { linksInEmbed, pickXLink, xEmbedUrl } from '@kefli/protocol';
import { open, TimedOut, type Opened } from '../net/http';

export const X_TIMEOUT_MS = 5_000;
export const MAX_HOPS = 5;
/** An embed answer is a few kilobytes; anything near this is not one. */
export const X_MAX_BYTES = 512 * 1024;

export type XPorts = { fetch: typeof fetch };

export type XCheck =
  | { kind: 'article'; url: string }
  | { kind: 'none'; why: 'no-link' | 'article' }
  /** No network: the post waits, as an offline share does. */
  | { kind: 'offline' }
  /** X's embed service isn't answering: the post waits and is checked again (G3). */
  | { kind: 'xfail' };

/** The X post check's reads: 5 s over the headers and the body, no cookies (net/http.ts). */
function timed(p: XPorts, url: string, init: RequestInit = {}): Promise<Opened> {
  return open(p.fetch, url, init, X_TIMEOUT_MS);
}

/** A t.co link's destination: Location headers followed by hand, five hops at most, no browser user agent. */
export async function resolveTco(p: XPorts, link: string): Promise<string> {
  let url = link;
  for (let hop = 0; MAX_HOPS > hop; hop++) {
    const { res, done } = await timed(p, url, { redirect: 'manual' });
    done();
    const next = res.headers.get('location');
    if (res.status >= 300 && 400 > res.status && next) {
      url = new URL(next, url).href;
      continue;
    }
    // A fetch that follows redirects itself reports where it ended.
    return res.url || url;
  }
  return url;
}

/** The embed service's answer for a post that has one. */
type Embed = { kind: 'embed'; html: string } | Exclude<XCheck, { kind: 'article' }>;

async function embedOf(p: XPorts, post: string): Promise<Embed> {
  let o: Opened;
  try {
    o = await timed(p, xEmbedUrl(post), { headers: { Accept: 'application/json' } });
  } catch (e) {
    // A timeout is X not answering; anything else is the network.
    return e instanceof TimedOut || (e as Error)?.name === 'AbortError' ? { kind: 'xfail' } : { kind: 'offline' };
  }
  // The embed service refuses a post it won't show (deleted, protected): there is no article to find.
  const refused = o.res.status === 404 || o.res.status === 403;
  if (refused || !o.res.ok) {
    o.done();
    return refused ? { kind: 'none', why: 'no-link' } : { kind: 'xfail' };
  }
  try {
    const json = JSON.parse(new TextDecoder().decode(await o.read(X_MAX_BYTES))) as { html?: unknown };
    return { kind: 'embed', html: String(json.html ?? '') };
  } catch {
    return { kind: 'xfail' };
  }
}

export async function checkXPost(p: XPorts, post: string): Promise<XCheck> {
  const e = await embedOf(p, post);
  if (e.kind !== 'embed') return e;
  const picked = await pickXLink(linksInEmbed(e.html), (tco) => resolveTco(p, tco));
  return 'save' in picked ? { kind: 'article', url: picked.save } : { kind: 'none', why: picked.nothing };
}

/** While X fails, a waiting post is checked again from 30 s, doubling to an hour (G3). */
export function xRetryDelay(failures: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, failures - 1));
}
