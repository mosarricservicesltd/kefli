// Sync's phase 7 (mobile spec 4.5): pending parses, one at a time, until the network goes. Each is fetched and
// parsed as a share is (page.ts), a public http address over https first (net/http overHttps); its text is
// encrypted under a fresh key, staged, written and indexed, and its sends queued (data/pending.ts). Ports, so this
// runs in tests.
import { encryptText, isPublicWebUrl, itemHash, textHash, type CryptoPort } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { applyFailed, applyParsed, pendingParses, timedOut, xFound, xNoArticle, type Pending } from '../data/pending';
import { overHttps } from '../net/http';
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
  // a page a browser asked for is never fetched from a private, loopback or link-local address (7.1); a share made
  // offline, an import or another phone's save naming a public http address is fetched over https, as a share is
  const fromBrowser = p.db.get<{ origin: string }>('SELECT origin FROM items WHERE id = ?', item.id)?.origin === 'browser';
  const outcome = fromBrowser && !isPublicWebUrl(item.url)
    ? { kind: 'failed' as const, reason: 'http' as const, finalUrl: item.url }
    : await fetchPage(p.page, overHttps(item.url));
  if (outcome.kind === 'offline') return 'unreached';
  return settle(p, owner, item, outcome);
}

/** The run going for each owner, and whether another was asked for while it went. */
const runs = new Map<string, { run: Promise<PendingResult>; again: boolean }>();

/**
 * The pending parses for owner, one run at a time. A sync's phase 7 and the inbox, which parses what it has just
 * saved, can ask at once, and two runs over one queue applied each parse twice: the second re-keyed a save the first
 * had re-keyed already, found it there, and deleted it as its own duplicate. A call while a run goes gets that run's
 * result, and one more pass follows it for anything queued meanwhile.
 */
export function runPendingParses(p: PendingPorts, owner: string): Promise<PendingResult> {
  const going = runs.get(owner);
  if (going) {
    going.again = true;
    return going.run;
  }
  const entry = { run: Promise.resolve<PendingResult>({ parsed: 0, failed: 0, waiting: 0, xWaiting: 0 }), again: false };
  entry.run = (async () => {
    try {
      let out = await pass(p, owner);
      while (entry.again) {
        entry.again = false;
        const more = await pass(p, owner);
        out = { parsed: out.parsed + more.parsed, failed: out.failed + more.failed, waiting: more.waiting, xWaiting: more.xWaiting };
      }
      return out;
    } finally {
      runs.delete(owner);
    }
  })();
  runs.set(owner, entry);
  return entry.run;
}

async function pass(p: PendingPorts, owner: string): Promise<PendingResult> {
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
 * Whether a save is still waiting for the parse it was taken for: at the same hash, its text queued (pending parses)
 * or fetching (the inbox). A parse that another path settled first, or re-keyed, is dropped rather than applied over it.
 */
function waiting(db: SqlDb, item: Pending): boolean {
  const row = db.get<{ hash: string; text_state: string }>('SELECT hash, text_state FROM items WHERE id = ?', item.id);
  return !!row && row.hash === item.hash && (row.text_state === 'queued' || row.text_state === 'fetching');
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
    if (waiting(p.db, item)) applyFailed(p.db, p.now(), owner, item, outcome.reason, t);
    return 'failed';
  }
  const { result } = outcome;
  const enc = await encryptText(result.markdown, p.crypto);
  // the last wait: from here the parse is applied in one go, and only to a save still as it was when its parse began
  if (!waiting(p.db, item)) return 'parsed';
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
    indexStored(p.db, item.id, outcome.spoken);
  }
  return 'parsed';
}

/**
 * A parsed save's search entry, from its row as stored: its fields as fitted under its event's ceiling, and the
 * address it keeps, which for a save already out is its own rather than where its page now lands (applyParsed). The
 * parse's own title, site and address found the save by words it doesn't hold.
 */
function indexStored(db: SqlDb, id: number, spoken: string): void {
  const row = db.get<{ id: number; title: string | null; site: string | null; url: string }>('SELECT id, title, site, url FROM items WHERE id = ?', id);
  if (row) indexText(db, row, spoken);
}
