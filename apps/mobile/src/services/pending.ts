// Sync's phase 7 (mobile spec 4.5): pending parses, one at a time, until the network goes. Each is fetched and
// parsed as a share is (page.ts); its text is encrypted under a fresh key, staged, written and indexed, and its
// sends queued (data/pending.ts). Ports, so this runs in tests.
import { encryptText, itemHash, textHash, type CryptoPort } from '@shelf/protocol';
import type { SqlDb } from '../data/db';
import { applyFailed, applyParsed, pendingParses } from '../data/pending';
import type { SaveTargets } from '../data/saves';
import { indexText } from '../data/sync';
import { fetchPage, type PagePorts } from './page';

export type PendingPorts = {
  db: SqlDb;
  now: () => number;
  page: PagePorts;
  crypto: CryptoPort;
  stage: (sha256: string, bytes: Uint8Array) => string;
  unstage: (path: string) => void;
  writeText: (hash: string, markdown: string) => void;
  targets: () => Promise<SaveTargets>;
};

export type PendingResult = { parsed: number; failed: number; waiting: number };

export async function runPendingParses(p: PendingPorts, owner: string): Promise<PendingResult> {
  const out: PendingResult = { parsed: 0, failed: 0, waiting: 0 };
  const queue = pendingParses(p.db, owner);
  for (let i = 0; queue.length > i; i++) {
    const item = queue[i];
    const outcome = await fetchPage(p.page, item.shared_url ?? item.url);
    if (outcome.kind === 'offline') {
      out.waiting = queue.length - i;
      break;
    }
    const t = await p.targets();
    if (outcome.kind === 'failed') {
      applyFailed(p.db, p.now(), owner, item, outcome.reason, t);
      out.failed++;
      continue;
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
      // It joined a save already here, which keeps its own text.
      p.unstage(path);
    } else {
      p.writeText(applied.hash, result.markdown);
      indexText(p.db, { id: item.id, title: result.title, site: result.site, url: outcome.finalUrl }, outcome.spoken);
    }
    out.parsed++;
  }
  return out;
}
