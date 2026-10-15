// The live list (mobile spec 11.3): each address through the share's own path, the X check for X posts and
// otherwise fetchPage with its user agents, caps and guard, a public http address asked for over https alone as the
// share asks for it (net/http overHttps), and every address without a user name and password, as the share takes it
// (services/save.ts saveLink), scored against the outcome that is right for it.
// Ports, so the same run checks the list on the desktop (scripts/live-urls.ts) before the phone runs it.
import { isXPost, withoutUserInfo } from '@kefli/protocol';
import { overHttps } from '../net/http';
import { fetchPage, type PagePorts } from '../services/page';
import { checkXPost, type XPorts } from '../services/xpost';

export type LiveUrl = { url: string; kind: string; expect: string };
export type LiveResult = LiveUrl & { got: string; pass: boolean; detail: string; ms: number };

export async function liveOutcome(page: PagePorts, x: XPorts, listed: string): Promise<{ got: string; detail: string }> {
  const url = withoutUserInfo(listed);
  if (isXPost(url)) {
    const c = await checkXPost(x, url);
    return { got: c.kind === 'article' ? 'x-article' : c.kind === 'none' ? 'x-none' : c.kind, detail: c.kind === 'article' ? c.url : '' };
  }
  const o = await fetchPage(page, overHttps(url));
  if (o.kind === 'offline') return { got: 'offline', detail: '' };
  if (o.kind === 'failed') return { got: `failed:${o.reason}`, detail: o.finalUrl };
  return { got: 'article', detail: `“${o.result.title ?? '(no title)'}”, ${o.words} words` };
}

export async function runLive(page: PagePorts, x: XPorts, list: LiveUrl[], now: () => number): Promise<LiveResult[]> {
  const out: LiveResult[] = [];
  for (const u of list) {
    const t = now();
    const { got, detail } = await liveOutcome(page, x, u.url).catch((e) => ({ got: 'error', detail: String((e as Error).message) }));
    out.push({ ...u, got, pass: got === u.expect, detail, ms: Math.round(now() - t) });
  }
  return out;
}
