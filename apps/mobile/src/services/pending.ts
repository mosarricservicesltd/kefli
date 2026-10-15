// Sync's phase 7 (mobile spec 4.5): pending parses, one at a time, until the network goes or the run's minute is
// spent. Each is fetched and parsed as a share is (page.ts), a public http address over https alone (net/http
// overHttps); one whose site has no https fails once it is over three days old (page.ts HTTPS_WAIT_SECONDS), and one
// whose page never answers once it is over 14 days old and tried again (page.ts ANSWER_WAIT_SECONDS), unless it would
// make SLOW_RUN pages in a row that can't be had, which are the network; an X post whose check X never answers gets
// the same 14-day rule (FD 119). Its text is encrypted under a fresh key,
// staged and written, and only then is the save marked as having it, indexed and its sends queued (data/pending.ts).
// Ports, so this runs in tests.
import { encryptText, isPublicWebUrl, itemHash, textHash, withoutUserInfo, type CryptoPort } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { applyFailed, applyParsed, pendingParses, timedOut, xFound, xNoArticle, type Pending } from '../data/pending';
import { overHttps } from '../net/http';
import { checkXPost, xRetryDelay, type XPorts } from './xpost';
import type { SaveTargets } from '../data/saves';
import { indexText } from '../data/sync';
import { fetchPage, waitedForAnswer, waitedForHttps, type PageOutcome, type PagePorts } from './page';
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
  /**
   * Whether the phone is on the internet now, as Android judges it (a network behind a captive portal isn't), asked
   * only before a save is failed for having no https or no answer (page.ts HTTPS_WAIT_SECONDS, ANSWER_WAIT_SECONDS).
   * Without it, none is.
   */
  online?: () => Promise<boolean>;
};

/**
 * waiting: left for want of a network; xWaiting: X posts whose check X didn't answer (retried, G3); untried, set only
 * when the run's time ran out, or when it met SLOW_RUN pages in a row it couldn't have after settling one (stalled):
 * of the parses it left, those never tried before, which the next run should start soon for (nextRunIn).
 */
export type PendingResult = { parsed: number; failed: number; waiting: number; xWaiting: number; untried?: number };

/**
 * Pages in a row that can't be had before the rest of the queue waits too, the network being down or slow rather
 * than one site: each times out, or doesn't answer at all (a dead domain, a broken certificate, a redirect loop). A
 * page failed for never answering (page.ts ANSWER_WAIT_SECONDS) is one of them, and the one that would complete a run
 * waits: a network that has stopped carrying anything can still be Android's validated one for a while, and every
 * page then fails as one that never answers.
 */
export const SLOW_RUN = 3;

/**
 * RULED: the seconds one run spends starting parses; the parse under way when they pass finishes. The queue runs
 * inside the sync's single run (runner.ts), so an import of thousands held every later sync, the outbox and other
 * phones' saves with it, for hours. A count of parses couldn't bound that: one takes from under a second to over a
 * minute (the 20 s deadline, again on a 403, then the browser engine). A minute is some twenty typical pages, a sync
 * now waits about two minutes at most for its parses, and the next run starts soon after while any were never tried.
 */
export const RUN_SECONDS = 60;

/** How soon the runner starts the next run while parses a run had no time for were never tried (nextRunIn). */
export const AGAIN_MS = 5_000;

/**
 * When the runner starts the next run itself, in milliseconds, or null to leave the queue to the next sync: soon while
 * parses never tried remain, and while X isn't answering, from 30 s doubling to an hour (G3).
 */
export function nextRunIn(r: PendingResult, xFailures: number): number | null {
  const soon = r.untried ? AGAIN_MS : Infinity;
  const x = r.xWaiting > 0 ? xRetryDelay(xFailures) * 1000 : Infinity;
  const ms = Math.min(soon, x);
  return ms === Infinity ? null : ms;
}

/**
 * One pending parse taken as far as it goes; unreached: its page, or its X post's check, couldn't be had at all;
 * unanswered: its page couldn't be had and never has, so the save failed as one that can't be read (page.ts
 * ANSWER_WAIT_SECONDS), a page that couldn't be had all the same for the run that reads as the network (pass).
 */
type Step = 'parsed' | 'failed' | 'xWaiting' | 'unreached' | 'unanswered';

/** A queued parse taken as far as it goes, after run pages in a row that couldn't be had (pass). */
async function step(p: PendingPorts, owner: string, queued: Pending, run: number): Promise<Step> {
  const item = queued.x_state === 'pending' ? await xChecked(p, owner, queued, run) : queued;
  if (typeof item === 'string') return item;
  const outcome = await pageOf(p, item);
  if (outcome.kind !== 'offline') return settle(p, owner, item, outcome);
  const reason = await givenUp(p, item, outcome, run);
  if (!reason) return 'unreached';
  // the reason alone, never the address (7.1)
  console.log(`[kefli-pending] ${JSON.stringify({ failed: reason, after: WAITED_FOR[reason] })}`);
  await settle(p, owner, item, { kind: 'failed', reason, finalUrl: item.url });
  return reason === 'offline' ? 'unanswered' : 'failed';
}

/**
 * A shared X post, checked first: its article, if it has one, is what gets parsed (5.4), and otherwise the check's end.
 * X's embed is never asked about a post with a user name and password in it, as a row stored before ruling 8 or a
 * browser's request may hold.
 */
async function xChecked(p: PendingPorts, owner: string, item: Pending, run: number): Promise<Pending | Step> {
  const x = await checkXPost(p.x, withoutUserInfo(item.url));
  if (x.kind === 'offline') return 'unreached';
  if (x.kind === 'xfail') return xGivenUp(p, owner, item, run);
  if (x.kind === 'none') {
    xNoArticle(p.db, p.now(), owner, item, await p.targets());
    return 'failed';
  }
  return xFound(p.db, item, x.url);
}

/**
 * An X post whose check X didn't answer: it waits and is checked again (xWaiting, G3), unless it has waited as long
 * as a page may for its answer and was checked before, with the phone on the internet (givenUp), when it is published
 * with its link as a page that never answers is, and counts towards the run that reads as the network (FD 119);
 * waiting for good, as it did, a post X never answers was never backed up.
 */
async function xGivenUp(p: PendingPorts, owner: string, item: Pending, run: number): Promise<Step> {
  const reason = await givenUp(p, item, { kind: 'offline' }, run);
  if (!reason) return 'xWaiting';
  // the reason alone, never the address (7.1)
  console.log(`[kefli-pending] ${JSON.stringify({ failed: reason, after: WAITED_FOR[reason], x: true })}`);
  await settle(p, owner, item, { kind: 'failed', reason, finalUrl: item.url });
  return 'unanswered';
}

/**
 * A waiting save's page. RULED: only a share made on this phone is fetched from a private, loopback or link-local
 * address (7.1), the person having chosen it here; a browser's request, an import and another phone's save never are
 * (contract 4.4), failing as a page that can't be read. A save reaches every other phone of its library, and this one
 * after a restore, as another phone's (origin sync), which can't say a browser named it: the phone a hostile browser
 * asked refused to fetch https://10.0.0.1/admin and published the save without text, and every other phone then
 * fetched it on its own network. A public http address is fetched over https alone, as a share is, so a site with
 * none waits as a page that can't be had (left to net/http open, its http would be asked next and fail the save at
 * once), until it has waited as long as it may (page.ts waitedForHttps).
 */
async function pageOf(p: PendingPorts, item: Pending): Promise<PageOutcome> {
  const shared = p.db.get<{ origin: string }>('SELECT origin FROM items WHERE id = ?', item.id)?.origin === 'share';
  if (!shared && !isPublicWebUrl(item.url)) return { kind: 'failed', reason: 'http', finalUrl: item.url };
  return fetchPage(p.page, overHttps(item.url));
}

/** What a save the queue gives up on waited for, by the reason it fails with, for its log line. */
const WAITED_FOR = { http: 'no https', offline: 'no answer' } as const;
type GivenUp = keyof typeof WAITED_FOR;

/**
 * Why a save whose page couldn't be had fails now, or null while it waits: http once it has waited for https as long
 * as it may (page.ts waitedForHttps); offline once it has waited as long as it may for its page to answer (page.ts
 * waitedForAnswer) and was tried before, so one that comes to this phone old, as another phone's save does, has a
 * second try before one slow answer can fail it. Either only with the phone on the internet, whose state is asked
 * only then; a phone that can't say, or a save with no saved_at, waits. run is the pages in a row before it that
 * couldn't be had (pass): RULED, one that would make SLOW_RUN of them waits whatever its age, a run of pages that
 * can't be had being the network's doing (F12).
 */
async function givenUp(p: PendingPorts, item: Pending, outcome: PageOutcome, run: number): Promise<GivenUp | null> {
  const reason = waitedOut(item, outcome, p.now(), run);
  return reason && (await p.online?.().catch(() => false)) === true ? reason : null;
}

/** The wait a save whose page came to outcome, after run pages in a row that couldn't be had, has outlasted, if any. */
function waitedOut(item: Pending, outcome: PageOutcome, now: number, run: number): GivenUp | null {
  if (item.saved_at === undefined) return null;
  if (waitedForHttps(item.url, outcome, item.saved_at, now)) return 'http';
  return run + 1 < SLOW_RUN && triedBefore(item) && waitedForAnswer(outcome, item.saved_at, now) ? 'offline' : null;
}

/** Whether a pending parse was tried before and couldn't be had (F12). */
const triedBefore = (q: Pending): boolean => !!q.timed_out_at;

/** The run going for each owner, and whether another was asked for while it went. */
const runs = new Map<string, { run: Promise<PendingResult>; again: boolean }>();

/**
 * The pending parses for owner, one run at a time, for RUN_SECONDS at most. A sync's phase 7 and the inbox, which
 * parses what it has just saved, can ask at once, and two runs over one queue applied each parse twice: the second
 * re-keyed a save the first had re-keyed already, found it there, and deleted it as its own duplicate. A call while a
 * run goes gets that run's result, and one more pass follows it, inside the same time, for anything queued meanwhile.
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
      const until = p.now() + RUN_SECONDS;
      let out = await pass(p, owner, until);
      while (entry.again) {
        entry.again = false;
        out = joined(out, await pass(p, owner, until));
      }
      return out;
    } finally {
      runs.delete(owner);
    }
  })();
  runs.set(owner, entry);
  return entry.run;
}

/** Two passes of one run as one: the parses of both, and what was left as the later saw it, unless it had no time to look. */
function joined(a: PendingResult, b: PendingResult): PendingResult {
  const late = b.untried !== undefined && b.parsed + b.failed + b.waiting + b.xWaiting === 0;
  const left = late ? a : b;
  const both = { parsed: a.parsed + b.parsed, failed: a.failed + b.failed, waiting: left.waiting, xWaiting: left.xWaiting };
  return b.untried === undefined ? both : { ...both, untried: b.untried };
}

/** Of the parses a run had no time for, how many were never tried: those it would rather not leave to the next sync. */
const neverTried = (rest: Pending[]): number => rest.filter((q) => !triedBefore(q)).length;

/**
 * A pass stopped at SLOW_RUN pages in a row that couldn't be had. After it has settled one, the network was there, so
 * they were dead links in a row, as an old import has: the parses after them never tried start in a run soon after
 * (nextRunIn); before, they waited for the next sync, for days if Kefli wasn't opened. Three from its start are the
 * network, as before, and the rest wait for the next sync.
 */
function stalled(out: PendingResult, rest: Pending[]): PendingResult {
  const untried = out.parsed + out.failed > 0 ? neverTried(rest) : 0;
  return untried ? { ...out, untried } : out;
}

/**
 * The pages in a row that couldn't be had after step s, run before it (F12): one more after a page that couldn't be
 * had, failed for no answer (unanswered) or waiting, as many after an X post X didn't answer, and none once a page or
 * an X post answered.
 */
function runAfter(run: number, s: Step): number {
  if (s === 'unreached' || s === 'unanswered') return run + 1;
  return s === 'xWaiting' ? run : 0;
}

async function pass(p: PendingPorts, owner: string, until: number): Promise<PendingResult> {
  const out: PendingResult = { parsed: 0, failed: 0, waiting: 0, xWaiting: 0 };
  const queue = pendingParses(p.db, owner);
  let unreached = 0;
  for (let i = 0; queue.length > i; i++) {
    // the run's time spent, the rest wait for the next run, which comes soon while any were never tried (nextRunIn)
    if (p.now() >= until) return { ...out, untried: neverTried(queue.slice(i)) };
    // a save whose parse threw (what its page held, or applying it) waits like one that couldn't be had, rather
    // than stopping the queue at it on every sync
    const s = await step(p, owner, queue[i], unreached).catch((e: unknown): Step => {
      console.log(`[kefli-pending] ${JSON.stringify({ threw: (e as Error)?.name ?? 'unknown' })}`);
      return 'unreached';
    });
    // one that couldn't be settled goes to the back of the queue (F12), an X post X didn't answer too, so it can't
    // spend each run's time again ahead of the rest; one that never answers can't stop the shares behind it either:
    // a dead link shared offline once stopped every pending parse at every sync
    if (s === 'unreached' || s === 'xWaiting') timedOut(p.db, p.now(), queue[i].id);
    unreached = runAfter(unreached, s);
    if (s !== 'unreached') {
      out[s === 'unanswered' ? 'failed' : s]++;
      continue;
    }
    // one page that can't be had waits for the next sync without holding up the rest; a run of them is the network
    if (unreached < SLOW_RUN) {
      out.waiting++;
      continue;
    }
    out.waiting += queue.length - i;
    return stalled(out, queue.slice(i + 1));
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
 * text; parsed has its text encrypted under a fresh key, staged and written, and only then is the save marked as
 * having it, indexed and its sends queued, unless it joined a save already here, which keeps its own text. RULED: a
 * text that can't be written, on a full disk, throws with nothing applied (data/pending applyParsed), and the save
 * waits for its parse, the queue trying it again as one that couldn't be had; marked first, it read as cached with no
 * text on the phone, its upload queued.
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
    }, { sha256: enc.text.sha256, size: enc.blob.length, path }, t, (hash) => p.writeText(hash, result.markdown, outcome.derived));
  } catch (e) {
    // nothing names the staged blob, so it goes, rather than a new one staying behind at each try
    p.unstage(path);
    throw e;
  }
  if (applied.merged) p.unstage(path);
  else indexStored(p.db, item.id, outcome.spoken);
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
