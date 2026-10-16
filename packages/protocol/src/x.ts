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

// Built from strings, as the code gate's parser misreads regex literals.
const TAG = new RegExp('<a\\s', 'gi');
const HREF = new RegExp('href\\s*=\\s*', 'gi');

/**
 * The href of every link in the embed's html, in order: exactly what /<a\s[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi
 * finds, in one pass. That pattern read on from each "<a " to the tag's ">" looking for an href, and again from every
 * "<a " inside it, so an answer of "<a " with no ">" took time that grows with the square of its length: 512 KB of
 * it, the embed's cap, held the JavaScript for three minutes here. Here every `href =` is found once, and a tag
 * takes the first before its ">" whose quote closes (the value itself may hold a ">"); a tag with none passes over
 * every "<a " up to its ">", since those would find none either.
 */
export function linksInEmbed(html: string): string[] {
  const out: string[] = [];
  // each quote's last place: an unclosed value is known at once, rather than read to the end for every tag
  const last: Record<string, number> = { '"': html.lastIndexOf('"'), "'": html.lastIndexOf("'") };
  // every `href =`: where it starts, and where the quote of its value would be
  const hrefs = [...html.matchAll(HREF)].map((m) => [m.index, m.index + m[0].length]);
  let k = 0;
  // the tag's ">", found once for all the tags before it
  let gt = -1;
  TAG.lastIndex = 0;
  for (let m = TAG.exec(html); m; m = TAG.exec(html)) {
    const from = m.index + m[0].length;
    if (gt < from) {
      gt = html.indexOf('>', from);
      if (gt === -1) gt = html.length;
    }
    while (k < hrefs.length && hrefs[k][0] < from) k++;
    let next = gt;
    for (; k < hrefs.length && hrefs[k][0] < gt; k++) {
      const at = hrefs[k][1];
      const q = html[at];
      if ((q === '"' || q === "'") && last[q] > at) {
        const close = html.indexOf(q, at + 1);
        out.push(html.slice(at + 1, close).replace(AMP, (_, e: string) => ENTITIES[e]));
        next = close + 1;
        break;
      }
    }
    TAG.lastIndex = next;
  }
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
