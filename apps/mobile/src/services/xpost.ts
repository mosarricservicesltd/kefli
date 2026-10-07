// Checking a shared X post (mobile spec 5.4, FD 78, G3): a post is never saved as itself; the first link in it that
// leaves X is. The embed service is asked with a 5 s timeout; t.co links are followed without a browser user agent,
// five hops at most; the rules for which link counts are packages/protocol's (x.ts). Offline, or with X's service
// failing, the post waits as a pending save and is checked again. Ports, so this runs in tests.
import { linksInEmbed, pickXLink, xEmbedUrl } from '@shelf/protocol';

export const X_TIMEOUT_MS = 5_000;
export const MAX_HOPS = 5;

export type XPorts = { fetch: typeof fetch };

export type XCheck =
  | { kind: 'article'; url: string }
  | { kind: 'none'; why: 'no-link' | 'article' }
  /** No network: the post waits, as an offline share does. */
  | { kind: 'offline' }
  /** X's embed service isn't answering: the post waits and is checked again (G3). */
  | { kind: 'xfail' };

async function timed(p: XPorts, url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), X_TIMEOUT_MS);
  try {
    return await p.fetch(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** A t.co link's destination: Location headers followed by hand, five hops at most, no browser user agent. */
export async function resolveTco(p: XPorts, link: string): Promise<string> {
  let url = link;
  for (let hop = 0; MAX_HOPS > hop; hop++) {
    const res = await timed(p, url, { redirect: 'manual' });
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

export async function checkXPost(p: XPorts, post: string): Promise<XCheck> {
  let res: Response;
  try {
    res = await timed(p, xEmbedUrl(post), { headers: { Accept: 'application/json' } });
  } catch (e) {
    // A timeout is X not answering; anything else is the network.
    return (e as Error)?.name === 'AbortError' ? { kind: 'xfail' } : { kind: 'offline' };
  }
  // The embed service refuses a post it won't show (deleted, protected): there is no article to find.
  if (res.status === 404 || res.status === 403) return { kind: 'none', why: 'no-link' };
  if (!res.ok) return { kind: 'xfail' };
  let html = '';
  try {
    html = String(((await res.json()) as { html?: unknown }).html ?? '');
  } catch {
    return { kind: 'xfail' };
  }
  const picked = await pickXLink(linksInEmbed(html), (tco) => resolveTco(p, tco));
  return 'save' in picked ? { kind: 'article', url: picked.save } : { kind: 'none', why: picked.nothing };
}

/** While X fails, a waiting post is checked again from 30 s, doubling to an hour (G3). */
export function xRetryDelay(failures: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, failures - 1));
}
