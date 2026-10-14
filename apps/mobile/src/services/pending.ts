// Sync's phase 7 (mobile spec 4.5): pending parses, one at a time, until the network goes. Each is fetched and
// parsed as a share is (page.ts); its text is encrypted under a fresh key, staged, written and indexed, and its
// sends queued (data/pending.ts). Ports, so this runs in tests.
import { encryptText, isPublicWebUrl, itemHash, textHash, type CryptoPort } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { applyFailed, applyParsed, pendingParses, timedOut, xFound, xNoArticle, type Pending } from '../data/pending';
import { checkXPost, type XPorts } from './xpost';
import type { SaveTargets } from '../data/saves';
import { indexText } from '../data/sync';
import { fetchPage, type PageOutcome, type PagePorts } from './page';
import type { Derived } from '../reader/blocks';

export type PendingPorts = {
  db: SqlDb;
  now: () => number;
  page: PagePorts;
  x: XPorts;
  crypto: CryptoPort;
  stage: (sha256: string, bytes: Uint8Array) => string;
  unstage: (path: string) => void;
  writeText: (hash: string, markdown: string, derived?: Derived) => void;
  targets: () => Promise<SaveTargets>;
};

/** waiting: left for want of a network; xWaiting: X posts whose check X didn't answer (retried, G3). */
export type PendingResult = { parsed: number; failed: number; waiting: number; xWaiting: number };

/**
 * Pages in a row that can't be had before the rest of the queue waits too, the network being down or slow rather
 * than one site: each times out, or doesn't answer at all (a dead domain, a broken certificate, a redirect loop).
 */
export const SLOW_RUN = 3;

/** One pending parse taken as far as it goes; unreached: its page, or its X post's check, couldn't be had at all. */
type Step = 'parsed' | 'failed' | 'xWaiting' | 'unreached';

async function step(p: PendingPorts, owner: string, queued: Pending): Promise<Step> {
  let item = queued;
  // A shared X post is checked first: its article, if it has one, is what gets parsed (5.4).
  if (item.x_state === 'pending') {
    const x = await checkXPost(p.x, item.url);
    if (x.kind === 'offline') return 'unreached';
    if (x.kind === 'xfail') return 'xWaiting';
    if (x.kind === 'none') {
      xNoArticle(p.db, p.now(), owner, item, await p.targets());
      return 'failed';
    }
    item = xFound(p.db, item, x.url);
  }
  // a page a browser asked for is never fetched from a private, loopback or link-local address (7.1)
  const fromBrowser = p.db.get<{ origin: string }>('SELECT origin FROM items WHERE id = ?', item.id)?.origin === 'browser';
  const outcome = fromBrowser && !isPublicWebUrl(item.url)
    ? { kind: 'failed' as const, reason: 'http' as const, finalUrl: item.url }
    : await fetchPage(p.page, item.url);
  if (outcome.kind === 'offline') return 'unreached';
  return settle(p, owner, item, outcome);
}

export async function runPendingParses(p: PendingPorts, owner: string): Promise<PendingResult> {
  const out: PendingResult = { parsed: 0, failed: 0, waiting: 0, xWaiting: 0 };
  const queue = pendingParses(p.db, owner);
  let unreached = 0;
  for (let i = 0; queue.length > i; i++) {
    // a save whose parse threw (what its page held, or applying it) waits like one that couldn't be had, rather
    // than stopping the queue at it on every sync
    const s = await step(p, owner, queue[i]).catch((e: unknown): Step => {
      console.log(`[kefli-pending] ${JSON.stringify({ threw: (e as Error)?.name ?? 'unknown' })}`);
      return 'unreached';
    });
    if (s === 'unreached') {
      // one page that can't be had waits for the next sync without holding up the rest; a run of them is the
      // network (F12). Each goes to the back of the queue, so pages that never answer can't stop the shares behind
      // them either: a dead link shared offline once stopped every pending parse at every sync.
      timedOut(p.db, p.now(), queue[i].id);
      if (++unreached < SLOW_RUN) {
        out.waiting++;
        continue;
      }
      out.waiting += queue.length - i;
      break;
    }
    if (s !== 'xWaiting') unreached = 0;
    out[s]++;
  }
  return out;
}

/**
 * A parse's result applied to a waiting save, for pending parses and the inbox (4.7): failed goes out without
 * text; parsed has its text encrypted under a fresh key, staged, written and indexed, unless it joined a save
 * already here, which keeps its own text.
 */
export async function settle(
  p: Pick<PendingPorts, 'db' | 'now' | 'crypto' | 'stage' | 'unstage' | 'writeText' | 'targets'>, owner: string, item: Pending,
  outcome: Exclude<PageOutcome, { kind: 'offline' }>,
): Promise<'parsed' | 'failed'> {
  const t = await p.targets();
  if (outcome.kind === 'failed') {
    applyFailed(p.db, p.now(), owner, item, outcome.reason, t);
    return 'failed';
  }
  const { result } = outcome;
  const enc = await encryptText(result.markdown, p.crypto);
  const path = p.stage(enc.text.sha256, enc.blob);
  let applied: ReturnType<typeof applyParsed>;
  try {
    applied = applyParsed(p.db, p.now(), owner, item, {
      hash: itemHash(outcome.finalUrl, result.canonical), url: outcome.finalUrl, canonical: result.canonical, title: result.title,
      site: result.site, byline: result.byline, lang: result.lang, hero: result.hero, words: outcome.words,
      text: enc.text, textHash: textHash(result.markdown, p.crypto),
    }, { sha256: enc.text.sha256, size: enc.blob.length, path }, t);
  } catch (e) {
    // nothing names the staged blob, so it goes, rather than a new one staying behind at each try
    p.unstage(path);
    throw e;
  }
  if (applied.merged) {
    p.unstage(path);
  } else {
    p.writeText(applied.hash, result.markdown, outcome.derived);
    indexText(p.db, { id: item.id, title: result.title, site: result.site, url: outcome.finalUrl }, outcome.spoken);
  }
  return 'parsed';
}
