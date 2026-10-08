// Sync's phase 7 (mobile spec 4.5): pending parses, one at a time, until the network goes. Each is fetched and
// parsed as a share is (page.ts); its text is encrypted under a fresh key, staged, written and indexed, and its
// sends queued (data/pending.ts). Ports, so this runs in tests.
import { encryptText, isPublicWebUrl, itemHash, textHash, type CryptoPort } from '@shelf/protocol';
import type { SqlDb } from '../data/db';
import { applyFailed, applyParsed, pendingParses, xFound, xNoArticle, type Pending } from '../data/pending';
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

export async function runPendingParses(p: PendingPorts, owner: string): Promise<PendingResult> {
  const out: PendingResult = { parsed: 0, failed: 0, waiting: 0, xWaiting: 0 };
  const queue = pendingParses(p.db, owner);
  for (let i = 0; queue.length > i; i++) {
    let item: Pending = queue[i];
    // A shared X post is checked first: its article, if it has one, is what gets parsed (5.4).
    if (item.x_state === 'pending') {
      const x = await checkXPost(p.x, item.url);
      if (x.kind === 'offline') {
        out.waiting = queue.length - i;
        break;
      }
      if (x.kind === 'xfail') {
        out.xWaiting++;
        continue;
      }
      if (x.kind === 'none') {
        xNoArticle(p.db, p.now(), owner, item, await p.targets());
        out.failed++;
        continue;
      }
      item = xFound(p.db, item, x.url);
    }
    // a page a browser asked for is never fetched from a private, loopback or link-local address (7.1)
    const fromBrowser = p.db.get<{ origin: string }>('SELECT origin FROM items WHERE id = ?', item.id)?.origin === 'browser';
    const outcome = fromBrowser && !isPublicWebUrl(item.url)
      ? { kind: 'failed' as const, reason: 'http' as const, finalUrl: item.url }
      : await fetchPage(p.page, item.url);
    if (outcome.kind === 'offline') {
      out.waiting = queue.length - i;
      break;
    }
    if ((await settle(p, owner, item, outcome)) === 'failed') {
      out.failed++;
      continue;
    }
    out.parsed++;
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
  const applied = applyParsed(p.db, p.now(), owner, item, {
    hash: itemHash(outcome.finalUrl, result.canonical), url: outcome.finalUrl, canonical: result.canonical, title: result.title,
    site: result.site, byline: result.byline, lang: result.lang, hero: result.hero, words: outcome.words,
    text: enc.text, textHash: textHash(result.markdown, p.crypto),
  }, { sha256: enc.text.sha256, size: enc.blob.length, path }, t);
  if (applied.merged) {
    p.unstage(path);
  } else {
    p.writeText(applied.hash, result.markdown, outcome.derived);
    indexText(p.db, { id: item.id, title: result.title, site: result.site, url: outcome.finalUrl }, outcome.spoken);
  }
  return 'parsed';
}
