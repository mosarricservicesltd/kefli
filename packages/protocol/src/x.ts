// X posts (contract 4.3, flow decision 78): a post is never saved as itself; the first link in it that
// leaves X is. The network steps are the app's (the embed service with a 5 s timeout, and t.co followed
// without a browser user agent for five hops at most); this module holds the rules around them.

import { urlParts } from '../../../shared/normalise';

// RULED: www. forms too, so a post on www.x.com follows the rule rather than being saved as itself.
const POST_HOSTS = new Set(['x.com', 'twitter.com', 'mobile.twitter.com', 'www.x.com', 'www.twitter.com']);
const X_HOSTS = ['x.com', 'twitter.com', 'pic.x.com', 'pic.twitter.com', 't.co'];

// The X rule only ever looks at http and https links, so anything else parses as null.
const parse = urlParts;

/** A post URL: x.com, twitter.com or mobile.twitter.com (and their www. forms) with the path /<user>/status/<id>. RULED: anything after the id (/photo/1) still counts. */
export function isXPost(url: string): boolean {
  const u = parse(url);
  return !!u && POST_HOSTS.has(u.hostname) && /^\/[^/]+\/status\/\d+(\/.*)?$/.test(u.pathname);
}

/** RULED: the listed hosts and their subdomains (www.x.com) are X's own. */
export function isXHost(host: string): boolean {
  return X_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

export function isXArticle(url: string): boolean {
  const u = parse(url);
  return !!u && isXHost(u.hostname) && u.pathname.startsWith('/i/article/');
}

/** The embed service's URL for a post. */
export function xEmbedUrl(post: string): string {
  return `https://publish.x.com/oembed?url=${encodeURIComponent(post)}`;
}

const AMP = /&(amp|quot|#39|#x27|lt|gt);/g;
const ENTITIES: Record<string, string> = { amp: '&', quot: '"', '#39': "'", '#x27': "'", lt: '<', gt: '>' };

/** The href of every link in the embed's html, in order. */
export function linksInEmbed(html: string): string[] {
  const out: string[] = [];
  const re = /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) out.push((m[1] ?? m[2]).replace(AMP, (_, e: string) => ENTITIES[e]));
  return out;
}

export type XOutcome = { save: string } | { nothing: 'no-link' | 'article' };

/**
 * Walk the embed's links in order: t.co links are resolved through resolve (the app's redirect follower),
 * X's own links are passed over, an X Article ends the walk with nothing saved, and the first link that
 * leaves X is saved as an ordinary link. A link that fails to resolve is passed over. RULED.
 */
export async function pickXLink(links: string[], resolve: (tco: string) => Promise<string>): Promise<XOutcome> {
  for (const link of links) {
    let url = link;
    const u = parse(url);
    if (!u) continue;
    if (u.hostname === 't.co') {
      try {
        url = await resolve(link);
      } catch {
        continue;
      }
    }
    if (isXArticle(url)) return { nothing: 'article' };
    const final = parse(url);
    if (final && !isXHost(final.hostname)) return { save: url };
  }
  return { nothing: 'no-link' };
}
