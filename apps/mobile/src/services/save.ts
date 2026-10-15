// A save from a shared link (mobile spec 5.4, contract 4.1–4.3): fetch and parse on the phone, encrypt and
// stage the text, record the item, and queue its outbox rows held, to be released when the share sheet closes
// without Undo. The outbox sends them (send.ts, runner.ts). What happened comes back as a kind, which picks the
// Saved sheet's state.
import { encryptText, isXPost, itemHash, textHash, urlParts, withoutUserInfo } from '@kefli/protocol';
import { overHttps } from '../net/http';
import { phonePagePorts } from './pagePorts';
import { phoneCrypto } from '../crypto/port';
import type { SqlDb } from '../data/db';
import { getItem } from '../data/items';
import { addressFits, fitSave, interimRelays, priorOf, queueSave, type Prior, type SaveTargets } from '../data/saves';
import type { NewItem } from '../data/items';
import { indexText } from '../data/sync';
import { seedGeneratedLists } from '../data/lists';
import { loadDefaults } from './config';
import { ensureSigner } from './identity';
import { stageBlob } from './staging';
import { textFiles } from './textFiles';
import { fetchPage, type PageOutcome } from './page';
import { checkXPost } from './xpost';
import { store } from './store';

export type SaveStep = { step: string; ok: boolean; detail: string };

/** Where a save reports its steps. A named type: the code gate's parser loses a function at an arrow-typed parameter. */
export type Report = (s: SaveStep) => void;

/**
 * saved: a new save (its text may still have failed). unarchived: an archived save brought back (G2). again: an
 * unread save shared again, unchanged (G2, FD 89). offline and xwait: saved, waiting for the network or for X (G3).
 * noarticle: an X post linking to no article, nothing saved.
 */
export type SaveKind = 'saved' | 'unarchived' | 'again' | 'offline' | 'xwait' | 'noarticle';

/** hash null: nothing was saved. prior: the save already here, for Undo (data/saves undoSave). */
export type Queued = { hash: string | null; held: number[]; kind: SaveKind; prior: Prior; title: string | null; site: string | null };

type Ctx = { db: SqlDb; owner: string; now: () => number; targets: SaveTargets; say: (step: string, detail: string, ok?: boolean) => void };

/** A share of a save already here takes the repeat-save rule at once, without fetching (contract 4.1). */
function repeat(c: Ctx, hash: string, url: string, prior: NonNullable<Prior>): Queued {
  const held = queueSave(c.db, c.now(), base(c, hash, url, 'queued'), null, c.targets);
  const row = getItem(c.db, c.owner, hash);
  c.say('repeat', prior.state === 'archived' ? 'archived: back in Unread' : 'already in Unread: unchanged');
  return { hash, held, kind: prior.state === 'archived' ? 'unarchived' : 'again', prior, title: row?.title ?? null, site: row?.site ?? null };
}

function base(c: Ctx, hash: string, url: string, textState: NewItem['textState'], sharedUrl = url): NewItem {
  return {
    owner: c.owner, hash, url, canonical: null, title: null, site: null, byline: null, savedAt: c.now(), words: null, lang: null,
    hero: null, text: null, textHash: null, textState, sharedUrl, origin: 'share',
  };
}

/** What a share of an X post linking to no article Kefli can keep comes to: nothing saved. */
const NO_ARTICLE: Queued = { hash: null, held: [], kind: 'noarticle', prior: null, title: null, site: null };

/**
 * A shared X post (5.4, FD 78): nothing written while it is checked; its article, if any, is what gets saved, as an
 * address to fetch. An article address too long to save is no article Kefli can keep.
 */
async function xRoute(c: Ctx, url: string): Promise<Queued | string> {
  c.say('x', 'checking the post');
  const x = await checkXPost({ fetch }, url);
  if (x.kind === 'none') {
    c.say('x', x.why === 'article' ? 'an X Article: nothing saved' : 'no article in that post: nothing saved', false);
    return NO_ARTICLE;
  }
  if (x.kind === 'article') {
    // the protocol's parser, which took the link: the phone's URL refuses a few hosts it takes, and this is a log line
    c.say('x', `the post links to ${urlParts(x.url)?.hostname}`);
    const article = withoutUserInfo(x.url);
    return addressFits(article) ? article : NO_ARTICLE;
  }
  // Offline, or X's service failing: the post waits as a pending save (G3).
  c.say('x', x.kind === 'offline' ? 'offline: the post waits' : 'X is not answering: the post waits');
  const hash = itemHash(url);
  const prior = priorOf(c.db, c.owner, hash);
  if (prior) return repeat(c, hash, url, prior);
  const held = queueSave(c.db, c.now(), { ...base(c, hash, url, 'queued'), xState: 'pending' }, null, c.targets);
  return { hash, held, kind: x.kind === 'offline' ? 'offline' : 'xwait', prior: null, title: null, site: null };
}

/** The identity, the store and the targets a save needs. */
async function context(report: Report): Promise<Ctx> {
  const defaults = await loadDefaults();
  const signer = await ensureSigner();
  const db = store();
  const owner = signer.pubkey();
  // only Kefli's own identity gets the default lists; a nostr user's come from their list and Keep backup copies (F4)
  if ((db.get<{ provider: string }>('SELECT provider FROM identities WHERE pubkey = ?', owner)?.provider ?? 'local') === 'local') {
    seedGeneratedLists(db, owner, defaults);
  }
  const c: Ctx = {
    db, owner, now: () => Math.floor(Date.now() / 1000), targets: { api: defaults.operator.api, blossom: defaults.operator.blossom, mirror: defaults.mirrors[0], interim: interimRelays(defaults) },
    say: (step, detail, ok = true) => report({ step, ok, detail }),
  };
  c.say('identity', `${owner.slice(0, 12)}…`);
  return c;
}

/**
 * A share saved as an offline share is (share-offline), with nothing fetched: keyed by its address, an X post marked
 * for its check, and parsed by the pending queue (4.5 phase 7) under that queue's timeouts. The start-up pickup saves
 * spools this way (8.5), since the sync it runs ahead of used to wait for each spool's fetch, the X check and the
 * page's second try and its browser engine among them, before it could start.
 */
export async function saveLater(shared: string, report: Report): Promise<Queued> {
  const c = await context(report);
  // kept without any user name and password, as a share's address is (saveLink)
  const url = withoutUserInfo(shared);
  if (!addressFits(url)) throw new Error('address too long to save');
  const hash = itemHash(url);
  const prior = priorOf(c.db, c.owner, hash);
  if (prior) return repeat(c, hash, url, prior);
  const held = queueSave(c.db, c.now(), { ...base(c, hash, url, 'queued'), xState: isXPost(url) ? 'pending' : null }, null, c.targets);
  c.say('queued', 'saved, waiting to fetch');
  return { hash, held, kind: 'offline', prior: null, title: null, site: null };
}

export async function saveLink(shared: string, report: Report): Promise<Queued> {
  const c = await context(report);
  // RULED: a shared address is kept, fetched and checked with X without any user name and password (contract 4.3,
  // ruling 8). The hash leaves them out, but what a save keeps is what Original, Open in browser and X's embed are given.
  const url = withoutUserInfo(shared);
  // a share's link is one that fits its event (firstLink passes over those that don't), so this doesn't happen
  if (!addressFits(url)) throw new Error('address too long to save');
  const target = isXPost(url) ? await xRoute(c, url) : url;
  if (typeof target !== 'string') return target;
  const early = priorOf(c.db, c.owner, itemHash(target));
  if (early) return repeat(c, itemHash(target), target, early);
  // a public http address is asked for over https alone, as the pending queue asks for it later (net/http overHttps);
  // the save keeps the address shared until its page parses
  const outcome = await fetchPage(phonePagePorts(), overHttps(target));
  return outcome.kind === 'parsed' ? savedParsed(c, target, url, outcome) : savedUnparsed(c, target, url, outcome);
}

/**
 * A share whose page didn't parse. Offline, the save waits on the phone keyed by the shared address, to be parsed
 * when online (share-offline); a page that can't be read is saved without text, and its row opens the original. A
 * page whose https was refused (an http site with none) waits as an offline one does: a share is new, and the pending
 * queue fails such a save as a page that can't be read only once it is over three days old (page.ts
 * HTTPS_WAIT_SECONDS). RULED: a failed parse keeps the shared address too. Where a redirect ends is trusted only when
 * the page parses; a sign-in wall's redirect lands on its login page, which isn't what was saved and isn't what Open
 * original should open.
 */
function savedUnparsed(c: Ctx, target: string, url: string, outcome: Exclude<PageOutcome, { kind: 'parsed' }>): Queued {
  const offline = outcome.kind === 'offline';
  c.say('parse', offline ? 'offline: saved, waiting to fetch' : `failed (${outcome.reason})`, offline);
  const hash = itemHash(target);
  // another share of this link may have saved it while this one fetched (two sheets, or the pickup and a sheet)
  const meanwhile = priorOf(c.db, c.owner, hash);
  if (meanwhile) return repeat(c, hash, target, meanwhile);
  const held = queueSave(c.db, c.now(), { ...base(c, hash, target, offline ? 'queued' : 'failed', url), failReason: offline ? null : outcome.reason }, null, c.targets);
  return { hash, held, kind: offline ? 'offline' : 'saved', prior: null, title: null, site: null };
}

/**
 * A share whose page parsed: its text encrypted and staged, the save written with it, the text on the phone from the
 * start and searchable (4.1, 4.9). RULED: the page's fields are fitted under the event ceiling (C§3.3, data/saves
 * fitSave). A final address too long for the event isn't adopted: the save keeps the shared one, with the text, as a
 * failed parse keeps it. RULED: the text is written before the save says it has it, as a pending parse's is
 * (services/pending.ts settle): a write that fails, as on a full disk, throws with nothing saved, staged or queued, and
 * the sheet says the share didn't save, its spool kept for the start-up pickup. Written after, the save read as cached
 * with no text on the phone, its upload queued.
 */
async function savedParsed(c: Ctx, target: string, url: string, outcome: Extract<PageOutcome, { kind: 'parsed' }>): Promise<Queued> {
  const { result: parsed, finalUrl, words } = outcome;
  c.say('parse', `“${parsed.title}”, ${words} words`);
  const fields = { canonical: parsed.canonical, title: parsed.title, site: parsed.site, byline: parsed.byline, lang: parsed.lang, hero: parsed.hero };
  const adopted = fitSave({ url: finalUrl, ...fields });
  const page = adopted ?? fitSave({ url: target, ...fields, canonical: null });
  if (!page) throw new Error('address too long to save');
  const hash = adopted ? itemHash(finalUrl, parsed.canonical) : itemHash(target);
  // The page's own address may name a save already here (a redirect, a canonical): the repeat-save rule again.
  const prior = priorOf(c.db, c.owner, hash);
  if (prior) return repeat(c, hash, page.url, prior);
  const enc = await encryptText(parsed.markdown, phoneCrypto);
  // RULED: checked again after the last wait, with nothing awaited between it and the write. A second share of the
  // same page that passed the first check while this one was encrypting found the first's row inside queueSave and
  // came back as a new save with no prior, so its Undo deleted the first share's save.
  const meanwhile = priorOf(c.db, c.owner, hash);
  if (meanwhile) return repeat(c, hash, page.url, meanwhile);
  // no save is at this hash, and nothing is awaited from here to the save's write, so the text is this save's alone
  textFiles.writeText(hash, parsed.markdown, outcome.derived);
  const staged = { sha256: enc.text.sha256, size: enc.blob.length, path: stageBlob(enc.text.sha256, enc.blob) };
  c.say('encrypt', `${enc.blob.length} bytes staged`);
  const held = queueSave(c.db, c.now(), {
    ...base(c, hash, page.url, 'cached', url), canonical: page.canonical, title: page.title, site: page.site, byline: page.byline,
    words, lang: page.lang, hero: page.hero, text: enc.text, textHash: textHash(parsed.markdown, phoneCrypto),
  }, staged, c.targets);
  const row = getItem(c.db, c.owner, hash);
  if (row) indexText(c.db, row, outcome.spoken);
  c.say('queued', `${held.length} rows held until the sheet closes`);
  return { hash, held, kind: 'saved', prior: null, title: page.title, site: page.site };
}
