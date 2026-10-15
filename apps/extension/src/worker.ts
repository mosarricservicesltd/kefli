// The background's work on a save (extension spec 2 and 4): saving, Undo, the queue's flush and Disconnect. bg.ts passes
// in the browser's parts (storage, the toast, the badge, the alarm and the relay), so the tests can play them.
//
// A save goes into the queue before its first send, so a worker stopped or a browser closed mid-send leaves it there
// for the next flush (F23). A save's send and its Undo run one at a time, so Undo pressed while a send is under way waits
// for it and then retracts what went or takes back what didn't (F40). Undo isn't timed here: it can only be pressed on a
// toast or popup still showing it, whose countdown pauses while the pointer or focus is on it (decision 38, F24). A save
// whose upload the operator refuses for good goes without its HTML, under a new wrap that Undo then names (v1.12), and a
// wrap that waited in the queue is made again just before it goes, so the phone's look at its inbox finds it.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { isWebAddress, type Captured } from './captured';
import { record, type Outcome } from './debug';
import { exclusive, PerSave } from './lock';
import { recipient, wrappedFor } from './move';
import { changeQueue, dequeue, enqueue, flush, queued, replaceWrap, settle, shown, whyNot, type Queued, type Settled } from './queue';
import {
  AddressTooLongError, deliver, freshWrap, prepare, retract, withoutText, wrapAgain, WRAP_FRESH_FOR, type Again, type Delivered, type Delivery, type Net, type Pending,
  type SaveContext,
} from './save';
import { KEYS, type Pairing, type Store } from './store';
import type { ToastKind, ToastState } from './toastCopy';
import { moveUndoKey, retracted, settleUndo, together, type Earlier, type Found, type Renamed, type Retracted, type UndoKey, type UndoOutcome } from './undo';

/** Where a save's notices go: the tab's toast, the toolbar popup where no toast can run, or nowhere (a link menu). */
export type Where = number | 'popup' | null;

export interface Browser {
  /** storage.local, and storage.session for Undo's keys. */
  store: Store;
  session: Store;
  net: Net;
  now(): number;
  online(): boolean;
  /** The pairing, the operator's defaults and the device key, or null before pairing. */
  context(): Promise<SaveContext | null>;
  openOptions(): void;
  toast(where: Where, s: Omit<ToastState, 'shortcut'>): Promise<void>;
  /** The toolbar's tick, for a save made where no toast can run. */
  tick(): Promise<void>;
  badge(): Promise<void>;
  /** The minute alarm that flushes the queue: on while anything waits, off when nothing does. */
  flushAlarm(on: boolean): Promise<void>;
  /** A look for a move first, so a save is wrapped for the library's current key. */
  checkMovesSoon(): Promise<void>;
  /** Whether the phone has collected a save (relay.ts): null when the relay gave no whole answer. */
  collected(relay: string, wrapId: string, user: string): Promise<Found>;
  wait(ms: number): Promise<void>;
}

/**
 * How many new wraps Undo follows from the one a toast names (undo.ts, Renamed). A wrap is made again at most once a
 * minute, at a send that then fails, or at a move, and a toast leaves after eight seconds unless the pointer or focus
 * holds it.
 */
const RENAMED_MAX = 64;

/** One Undo's save, where it is told, the session's key for it, and what retracts it, looks for it and forgets it. */
interface UndoOf {
  id: string;
  where: Where;
  kept: UndoKey | undefined;
  retractIt(): Promise<Retracted>;
  collected(): Promise<Found>;
  forget(): Promise<void>;
}

/** How an Undo ends on its toast: removed, found on the phone, or not taken back. */
type Ended = Exclude<UndoOutcome, 'absent'>;

/** What Copy debug info records of an Undo's end, and the toast that says it. */
const SAID: Record<Ended, [Outcome, ToastKind]> = { onphone: ['undo: on the phone', 'onphone'], undone: ['undo: retracted', 'undone'], failed: ['undo: failed', 'undofailed'] };

/** A wrap of a save and the library it went to, whose kind 5 for it says the phone took it from that library's inbox. */
type WentTo = Pick<Earlier, 'id' | 'user'>;

/** What Undo found of a save under one wrap: the session's key for it, and its waiting entry, already off the queue. */
interface Held {
  kept: UndoKey | undefined;
  waiting: Queued | null;
}

/** The wrap a save goes by now, when another has taken this one's place (undo.ts Renamed), or what Undo found under it. */
type Finding = Renamed | Held;

const WAITING: Record<ReturnType<typeof whyNot>, Outcome> = { offline: 'waiting, offline', reach: 'waiting, couldn’t reach' };

/**
 * Whether a waiting save may be on the relay all the same: one tried before, whose answer may have timed out though the
 * relay took it, or one a move put under a new wrap while its old one may have gone (undo.ts Earlier). Whether the
 * session still holds its key or not: without it the wrap can't be retracted, which Undo then says.
 */
const mayBeOnRelay = (e: Queued, kept: UndoKey | undefined) => e.why !== 'offline' || e.attempts > 0 || (kept?.earlier?.length ?? 0) > 0;

/**
 * Whether a save about to go may be on the relay already: a waiting one tried before, or one a stopped worker left on its
 * first send. A save on its own first send, not a queue entry, has gone nowhere yet.
 */
const triedBefore = (p: Delivered & Partial<Queued>) => p.why !== undefined && (p.why !== 'offline' || (p.attempts ?? 0) > 0);

/** What the toast shows of a save, under the id its wrap has now, which Undo names. */
const toasted = (p: Pending, link: boolean) => ({ id: p.id, hash: p.hash, title: p.title, host: p.host, link });

/**
 * How long a save waits on a toast before going on. A page can keep a toast from showing for as long as it likes (a
 * main thread kept busy, a custom element of the toast's name that never returns, a page that never finishes loading),
 * and a save held before it is queued is lost when the browser stops the worker. Past this the save goes on; the toast
 * still shows if the page ever lets it, after the ones before it.
 */
export const TOAST_WAIT_MS = 2_000;

export function background(b: Browser) {
  const saves = new PerSave();
  /**
   * Saves whose request went, or waits to go, without the HTML the operator refused (v1.12), by their wrap's id, until the
   * toast or Copy debug info says so. A flush adds the queue's own marks first, so a save sent again by a background
   * before this one is recorded as sent with no text too.
   */
  const textless = new Set<string>();
  /**
   * Saves Undo has removed, by the wrap each went by then. A second Undo on the same toast (a double click, Enter pressed
   * twice) found no key and no waiting save, and said "Couldn't undo this save" over "Removed from Kefli".
   */
  const undone = new Set<string>();
  /**
   * Saves a move put under a new wrap while a send of the old one was under way, by the wrap they went by (follow). The
   * move says so before it writes the queue, and before it moves Undo's key, so a send that ends as the move does is
   * settled under the new wrap even when Undo's key hasn't followed yet (settleFirst).
   */
  const movedMidSend = new Map<string, string>();
  /**
   * A save's delivery. The wrap a try before this one may have sent (triedBefore) is the one the save has as the try
   * begins; a wrap made in this try, as for a move caught up with (forPairing), has gone nowhere yet. When it is made
   * again, its HTML refused or its date too old, Undo keeps its key to retract it too (takePlace, wentTo).
   */
  const deliverFor = (ctx: SaveContext) => async (p: Delivered & Partial<Queued>) => {
    const tried = triedBefore(p) ? p.id : null;
    await forPairing(p, ctx);
    const wentTo = (q: Delivered) => (q.id === tried ? recipient(q) : null);
    return deliver(p, ctx.defaults.operator.blossom, ctx.defaults.operator.relay, ctx.device, b.net, (q, refused) => (refused ? withoutHtml(q, ctx, wentTo(q)) : freshen(q, ctx, wentTo(q))));
  };

  /** Each tab's toasts, one after another, so Saved never lands before the Saving… it replaces. */
  const showing = new Map<Where, Promise<void>>();
  function toast(where: Where, s: Omit<ToastState, 'shortcut'>): Promise<void> {
    const shown = (showing.get(where) ?? Promise.resolve()).then(() => b.toast(where, s)).catch(() => undefined);
    showing.set(where, shown);
    void shown.then(() => showing.get(where) === shown && showing.delete(where));
    return Promise.race([shown, b.wait(TOAST_WAIT_MS)]);
  }

  /** What became of a save, for Copy debug info: storage that refuses it mustn't stop the save it describes. */
  const note = (id: string, outcome: Outcome, link?: boolean) => record(b.store, b.now(), id, outcome, link).catch(() => undefined);

  /**
   * The wrap a save goes by now: the last of those that took the named wrap's place, if it went again under another. A
   * session that can't be read leaves Undo with the last wrap it found, which then says if it couldn't undo.
   */
  async function goesBy(id: string): Promise<string> {
    for (let hops = 0; hops < RENAMED_MAX; hops++) {
      const kept = await b.session.get<UndoKey | Renamed>(`undo:${id}`).catch(() => undefined);
      if (!kept || !('to' in kept)) break;
      id = kept.to;
    }
    return id;
  }

  /**
   * The save under a new wrap: the wrap, its key and its id take the old one's place in the queue, with what else
   * changed, and in Undo's key before it is sent, so a worker stopped meanwhile leaves the new wrap for the next flush,
   * and the new id is busy for as long as this send runs, as the old one is. A mark that it goes without text follows it.
   * Storage that won't take the change doesn't stop the save: a queue that can't be written leaves it under the wrap the
   * queue still names, so a later send and Undo agree with what went, and a session that can't keep the new key leaves
   * Undo saying it couldn't undo, rather than holding the save. A save the queue doesn't hold, never kept, goes under the
   * new wrap all the same; one a move put under another wrap meanwhile (move.ts, movedMidSend) goes as it was, since
   * Undo's key for the old wrap points, or is about to point, to the move's, which waits in the queue and which Undo must
   * still reach. With wentTo, the library the old wrap went to when it may be on the relay, Undo keeps its key to retract
   * it too (undo.ts Earlier).
   */
  async function takePlace(p: Delivered, again: Again, changed: Partial<Queued>, wentTo?: string | null): Promise<void> {
    const was = p.id;
    const next = { id: again.wrap.id, wrap: again.wrap, sealed: again.sealed, wrapped_at: b.now() };
    saves.follow(was, next.id);
    const found = await replaceWrap(b.store, was, { ...changed, ...next }).catch(() => null);
    if (found === null || (!found && movedMidSend.has(was))) return;
    Object.assign(p, next);
    if (textless.delete(was)) textless.add(p.id);
    await moveUndoKey(b.session, was, p.id, again.wrapKey, p.sha256, wentTo ?? null).catch(() => undefined);
  }

  /**
   * Before each try, a save wrapped for a library the pairing no longer names, or with an older token, is wrapped again
   * for the pairing as it is now, with its token (contract 4.4 and 4.8; takePlace). A save that read the pairing just
   * before a move was taken, and joined the queue just after the move had wrapped the queue again, went on to the library
   * that moved away, and every try after made its wrap again for that library from the old wrap's own p tag: refused
   * there once its account was deleted, until it stopped, or lost under Saved once the phone had read that inbox for the
   * last time. The pairing is read under the move's lock, so a move is seen whole or not at all; an old wrap that may be
   * on the relay keeps its key, so Undo retracts it too.
   */
  async function forPairing(p: Delivered & Partial<Queued>, ctx: SaveContext): Promise<void> {
    await exclusive('move', async () => {
      const pairing = await b.store.get<Pairing>(KEYS.pairing).catch(() => undefined);
      if (!pairing || (await wrappedFor(p, ctx.device, pairing))) return;
      const again = await wrapAgain(p.sealed, ctx.device, pairing.user_pubkey, (r) => ({ ...r, token: pairing.token }), b.now()).catch(() => null);
      if (again) await takePlace(p, again, {}, triedBefore(p) ? recipient(p) : null);
    });
  }

  /**
   * The operator refused the save's upload for good (contract 4.4 and 5, v1.12), and the extension doesn't wait for room:
   * the request goes with `html` null, rebuilt and signed again with the same uuid, under a new wrap (takePlace). A
   * request that can't be rebuilt goes as it was, and the phone, finding no blob, fetches the page at once. wentTo: the
   * library the old wrap went to, when a try before this one may have sent it, as a worker stopped mid-send may have.
   */
  async function withoutHtml(p: Delivered, ctx: SaveContext, wentTo: string | null): Promise<void> {
    p.sha256 = null;
    const again = await withoutText(p, ctx.device, b.now());
    if (again) await takePlace(p, again, { blob: null, sha256: null, textless: true }, wentTo);
    textless.add(p.id);
  }

  /**
   * A wrap made more than a minute ago is made again before it goes (WRAP_FRESH_FOR, contract 4.4): the same request,
   * under a new wrap dated from now (takePlace). Offline the send fails anyway, so the wrap waits as it is. wentTo: the
   * library the old wrap went to, when a try before this one may have sent it, its answer timed out though the relay
   * took it; Undo then retracts it as well as the new one, which a toast held open through both sends retracted alone.
   */
  async function freshen(p: Delivered, ctx: SaveContext, wentTo: string | null): Promise<void> {
    if (b.now() - (p.wrapped_at ?? 0) <= WRAP_FRESH_FOR || !b.online()) return;
    const again = await freshWrap(p, ctx.device, b.now());
    if (again) await takePlace(p, again, {}, wentTo);
  }

  /**
   * After the queue changes: the alarm is on while anything still tries and goes once nothing does, and the badge counts
   * what waits. Turned on here as well as at a save, since the alarm may be gone after a browser restart (Firefox keeps
   * none) and a start-up flush that fails must still leave one to try again. A queue storage.local can't read leaves the
   * alarm on, for the next minute's flush, and stops neither the toast after it nor Undo: it left a save at Saving… for
   * good, whether it had gone or wasn't kept.
   */
  async function queueChanged(): Promise<void> {
    const trying = await queued(b.store).then((q) => q.some((e) => !e.stopped), () => true);
    await b.flushAlarm(trying);
    await b.badge().catch(() => undefined);
  }

  /** The request wrapped, or null when nothing can be saved, with the toast saying why (decision 100, F39). */
  async function prepared(c: Captured, ctx: SaveContext, where: Where) {
    // a page the capture script could read without a web address, such as a file
    let refused: ToastKind = 'browserpage';
    try {
      if (isWebAddress(c.url)) return await prepare(c, ctx);
    } catch (e) {
      if (!(e instanceof AddressTooLongError)) throw e;
      refused = 'toolong';
    }
    await toast(where, { kind: refused, title: '', host: '', link: true });
    return null;
  }

  /**
   * A save's first send, from the queue (F23). Storage that won't take the save (storage.local full, or broken) doesn't
   * stop it: it is sent all the same, and one that can't be sent is kept smaller if it can be, else refused as the ninth
   * is, so it never sits at Saving… unkept. A settle that can't be written leaves the save queued as sending, for the
   * next flush to send. The send may put the save under a new wrap (takePlace), which is the one kept.
   */
  async function firstSend(pending: Pending, ctx: SaveContext): Promise<{ d: Delivery; s: Settled; online: boolean }> {
    const kept = await enqueue(b.store, pending, 'sending').then((r) => r === 'queued', () => false);
    await b.flushAlarm(true);
    const online = b.online();
    const d: Delivery = online ? await deliverFor(ctx)(pending) : 'unreachable';
    if (kept) return { d, online, s: await settleFirst(pending, d, online).catch((): Settled => 'queued') };
    if (d === 'sent') return { d, online, s: 'sent' };
    // with the mark a save whose HTML the operator refused carries in the queue, for whichever background sends it
    const smaller = { ...pending, blob: null, ...(textless.has(pending.id) ? { textless: true as const } : {}) };
    const s = await enqueue(b.store, smaller, whyNot(online)).catch((): Settled => 'full');
    return { d, online, s };
  }

  /**
   * A first send settled in the queue. A move found meanwhile wraps the save again under a new id (move.ts), which Undo
   * follows (undo.ts): one that didn't go is settled under that id, so it waits there as any save that didn't go does,
   * rather than its toast saying it was removed. One that went, to the library that moved away, is left queued under its
   * new wrap for the next flush to send to the new library, since the phone may have read the old one for the last time.
   */
  async function settleFirst(pending: Pending, d: Delivery, online: boolean): Promise<Settled> {
    const s = await settle(b.store, pending, d, online, true);
    const moved = movedMidSend.get(pending.id);
    movedMidSend.delete(pending.id);
    if (s !== 'gone' || d === 'sent') return s;
    const now = await goesBy(moved ?? pending.id);
    return now === pending.id ? s : settle(b.store, { id: now, blob: pending.blob }, d, online, true);
  }

  async function save(c: Captured, where: Where, link: boolean): Promise<void> {
    // a move found now means this save is wrapped for the new key from the start; a look that fails leaves the key as it was
    await b.checkMovesSoon().catch(() => undefined);
    const ctx = await b.context();
    if (!ctx) return b.openOptions();
    const p = await prepared(c, ctx, where);
    if (!p) return;
    const { pending, wrapKey } = p;
    await toast(where, { ...toasted(pending, link), kind: 'saving' });
    // a session that can't keep the key leaves Undo saying it couldn't undo, rather than losing the save
    await b.session.set(`undo:${pending.id}`, { key: bytesToHex(wrapKey), sha256: pending.sha256, hash: pending.hash } satisfies UndoKey).catch(() => undefined);
    // into the queue inside the save's own run, so a flush already going never finds it there and not busy, and sends it
    // a second time beside this send
    const { d, s, online } = await saves.run(pending.id, () => firstSend(pending, ctx));
    // from here the toast names the wrap the save has now, a new one if its HTML was refused, so Undo retracts that
    if (d === 'sent') return sentNow(pending, where, link);
    await waits(pending, where, link, { s, online });
  }

  /**
   * Saved, or, for a save whose request went without its text, the toast saying the phone will fetch it. That is a request
   * whose HTML the operator refused, and one that names no inbox blob: a link, a page whose capture kept no HTML, and a
   * page whose HTML was left out to fit the wrap (F39), though the capture had it.
   */
  async function sentNow(pending: Pending, where: Where, link: boolean): Promise<void> {
    const noText = textless.delete(pending.id) || pending.sha256 === null;
    await note(pending.id, noText ? 'sent, no text' : 'sent', link);
    await queueChanged();
    await toast(where, { ...toasted(pending, link), kind: noText ? 'notext' : 'saved' });
    if (where === 'popup') await b.tick();
  }

  /** A save that didn't go at once: taken off the queue meanwhile, refused as the ninth, or waiting, and why. */
  async function waits(pending: Pending, where: Where, link: boolean, r: { s: Settled; online: boolean }): Promise<void> {
    await queueChanged();
    const base = toasted(pending, link);
    // taken off the queue while it was sending: Disconnect deleted it, as its confirm said
    if (r.s === 'gone') return toast(where, { ...base, kind: 'unqueued' });
    if (r.s === 'full') {
      await note(pending.id, 'queue full', link);
      return toast(where, { ...base, kind: 'full' });
    }
    const why = whyNot(r.online);
    await note(pending.id, WAITING[why], link);
    await toast(where, { ...base, kind: why === 'offline' ? 'offline' : 'failed' });
    if (where === 'popup' && why === 'offline') await b.tick();
  }

  /**
   * Undo: a save still waiting comes off the queue; one that went is retracted with its wrap's key, and looked for on the
   * phone (decision 101). A retraction that fails, or a key the session no longer holds, says so (F40). A waiting save
   * whose send may have reached the relay all the same (an answer that timed out, a worker stopped mid-send) is retracted
   * as well as taken off the queue; the relay refuses a retraction of a wrap it doesn't hold, which then changes nothing.
   * Undo first waits for a send of the save under way, which may put it under a new wrap when the operator refuses its
   * HTML (v1.12), and then undoes it under the wrap it has now, so a toast that still names the old wrap undoes it too.
   * Each wrap the save went by since is followed under its own lock, a run at a time (undoNow): a wrap found and then
   * waited on could be made again by the send under way, and Undo, reading the new wrap's name in the old one's place as
   * a key, sent no retraction and said it couldn't undo while the new wrap reached the phone. Taken under the run it
   * found the name in, the next wrap's lock would wait on that run, which PerSave.follow gave it. A second Undo of a save
   * already undone, such as a double click, changes and says nothing more.
   */
  async function undo(id: string, where: Where): Promise<void> {
    const ctx = await b.context();
    if (!ctx) return b.openOptions();
    let next: string | null = id;
    for (let hops = 0; next !== null; hops++) {
      const now: string = next;
      next = await saves.run(now, () => undoNow(now, where, ctx, hops >= RENAMED_MAX));
    }
  }

  /**
   * What Undo finds of a save under one wrap, read under the move's lock, so a move wrapping the queue again (move.ts) is
   * seen whole or not at all: the wrap it goes by now, if another took this one's place, or the session's key for it and
   * its waiting entry, taken off the queue as it is read. A move between the read of the queue and the dequeue had left
   * Undo retracting a wrap that never went, saying it couldn't, while the move's wrap waited to go. A queue that can't be
   * read or written holds no save Undo can take off it there, so Undo retracts, and says if it couldn't.
   */
  function findSave(id: string): Promise<Finding> {
    return exclusive('move', () => heldUnder(id));
  }

  /** findSave's reads, under the move's lock. */
  async function heldUnder(id: string): Promise<Finding> {
    const kept = await b.session.get<UndoKey | Renamed>(`undo:${id}`).catch(() => undefined);
    if (kept && 'to' in kept) return { to: kept.to };
    return { kept, waiting: await takeOff(id) };
  }

  /** The save's waiting entry under this wrap, taken off the queue, or null when the queue holds none there. */
  async function takeOff(id: string): Promise<Queued | null> {
    // read on its own line: lizard, which the code gate uses, ends the function at a find called on a bracketed await
    const q = await queued(b.store).catch((): Queued[] => []);
    const waiting = q.find((e) => e.id === id);
    if (!waiting) return null;
    return (await dequeue(b.store, id).catch(() => false)) ? waiting : null;
  }

  /**
   * One wrap retracted with its own key, and its inbox blob removed (save.ts retract), read as undo.ts reads a retraction.
   * A key that can't be read can't retract its wrap either, which may then still be on the relay.
   */
  function retractOne(p: Pick<Pending, 'id' | 'sha256'>, key: string, ctx: SaveContext): Promise<Retracted> {
    const { relay, blossom } = ctx.defaults.operator;
    return retracted(Promise.resolve().then(() => retract(p, hexToBytes(key), blossom, relay, ctx.device, b.net, b.now())));
  }

  /**
   * The save's wraps from before a move, or from before it was made again, retracted, each with its own key (undo.ts
   * Earlier). The relay refuses to retract one it never took, which changes nothing; one it couldn't be asked to retract
   * may still be there, which Undo then says (undo.ts together). Whether the phone took one is looked for after.
   */
  async function retractEarlier(earlier: Earlier[], ctx: SaveContext): Promise<Retracted[]> {
    const each: Retracted[] = [];
    for (const e of earlier) each.push(await retractOne({ id: e.id, sha256: null }, e.key, ctx));
    return each;
  }

  /**
   * Whether the phone took one of a save's wraps: its deletion is signed by the library that wrap went to, as it read
   * that inbox. Found for one is found; otherwise a look the relay didn't answer whole leaves it unknown (null).
   */
  async function collectedAny(relay: string, wraps: WentTo[]): Promise<Found> {
    let unknown = false;
    for (const w of wraps) {
      const found = await b.collected(relay, w.id, w.user);
      if (found === true) return true;
      unknown ||= found === null;
    }
    return unknown ? null : false;
  }

  /**
   * One Undo of the save under the wrap it goes by now: its wrap retracted with its own key, with any from before a move
   * that may be on the relay, the look for it on the phone, and its key forgotten once it is undone, so a second press
   * says nothing more.
   */
  function undoOf(id: string, where: Where, kept: UndoKey | undefined, ctx: SaveContext): UndoOf {
    const earlier = kept?.earlier ?? [];
    return {
      id, where, kept,
      retractIt: async () => {
        const each = await retractEarlier(earlier, ctx);
        // with no key for the save's own wrap it can't be retracted, so a copy of it on the relay stays there
        each.push(kept ? await retractOne({ id, sha256: kept.sha256 }, kept.key, ctx) : 'unreached');
        return together(each);
      },
      collected: () => collectedAny(ctx.defaults.operator.relay, [{ id, user: ctx.pairing.user_pubkey }, ...earlier]),
      forget: async () => {
        undone.add(id);
        await b.session.remove(`undo:${id}`).catch(() => undefined);
      },
    };
  }

  /**
   * How an Undo ends, said on the toast and in Copy debug info. A save removed forgets its key, so a second press says
   * nothing more; one Undo couldn't take back keeps it, so Undo pressed again tries again; one found on the phone is
   * looked for again.
   */
  async function told(u: UndoOf, ended: Ended): Promise<void> {
    if (ended === 'undone') await u.forget();
    if (ended === 'onphone') await b.session.remove(`undo:${u.id}`).catch(() => undefined);
    await note(u.id, SAID[ended][0]);
    await toast(u.where, { kind: SAID[ended][1], hash: u.kept?.hash, title: '', host: '', link: false });
  }

  /**
   * One Undo's run under one wrap: the wrap the save goes by now, for undo() to follow under that wrap's own lock, or
   * null once the save is undone here. Past RENAMED_MAX wraps, a name in the key's place counts as no key.
   */
  async function undoNow(id: string, where: Where, ctx: SaveContext, last: boolean): Promise<string | null> {
    // already undone: its toast says so, and a second press changes and says nothing more
    if (undone.has(id)) return null;
    const found = await findSave(id);
    if ('to' in found) return last ? undoUnder(id, where, { kept: undefined, waiting: null }, ctx) : found.to;
    return undoUnder(id, where, found, ctx);
  }

  /** Undo of the save under the wrap it goes by now: off the queue if it waited there, else retracted. */
  async function undoUnder(id: string, where: Where, found: Held, ctx: SaveContext): Promise<null> {
    const u = undoOf(id, where, found.kept, ctx);
    if (found.waiting) return unqueue(u, found.waiting, ctx.device).then(() => null);
    const outcome = await settleUndo(u.retractIt, u.collected, b.wait).catch((): UndoOutcome => 'failed');
    // 'absent', for a save that went: its wrap gone from the relay, yet no phone said it took it
    await told(u, outcome === 'absent' ? 'failed' : outcome);
    return null;
  }

  /**
   * Undo of a save still in the queue: off it, and retracted as well when its send may have reached the relay, under the
   * wrap it has now or one from before (mayBeOnRelay). The relay refusing a retraction as holding no such wrap means that
   * wrap never reached it, and the save is removed with its entry; a retraction it couldn't be asked for, out of reach or
   * refusing it for now, leaves a wrap that did reach it there for the phone to take, so Undo says it couldn't, as it
   * does for a save that went. Every failure read as removed said Removed from Kefli of a save sent before a move, whose
   * wrap waited on the relay for the phone's last look at the old library's inbox. So does a key the session no longer
   * holds, which can retract nothing: the save is still looked for on the phone, and otherwise Undo says it couldn't.
   */
  async function unqueue(u: UndoOf, waitingSave: Queued, device: SaveContext['device']): Promise<void> {
    await note(u.id, 'undo: off the queue');
    await queueChanged();
    const went = mayBeOnRelay(waitingSave, u.kept) ? await settleUndo(u.retractIt, u.collected, b.wait).catch((): UndoOutcome => 'failed') : 'undone';
    if (went === 'onphone' || went === 'failed') return told(u, went);
    await u.forget();
    // the title and host come from the sealed request; the queue doesn't keep them in the clear (F31)
    const [s] = await shown([waitingSave], device);
    return toast(u.where, { kind: 'unqueued', title: s.title, host: s.host, link: false });
  }

  /**
   * A pass over the queue, from the alarm, the browser coming online or Retry. Quiet when not paired (F10). Returns the ids
   * the saves sent went under, a new wrap's for a save sent without its HTML (v1.12), so Retry knows its save went.
   */
  async function flushQueue(all = false, only?: string): Promise<string[]> {
    // a save queued before a move must go to the new key, so a waiting queue looks for one first
    await b.checkMovesSoon().catch(() => undefined);
    const ctx = await b.context();
    // nothing to send to, and nobody asked: the alarm goes rather than opening the options page every minute
    if (!ctx) {
      await b.flushAlarm(false);
      return [];
    }
    const before = await queued(b.store);
    const stoppedBefore = new Set(before.filter((e) => e.stopped).map((e) => e.id));
    for (const e of before) if (e.textless) textless.add(e.id);
    const sent = await flush(b.store, deliverFor(ctx), b.online(), { all, only, saves });
    for (const id of sent) await note(id, textless.delete(id) ? 'sent, no text' : 'sent from queue');
    for (const e of await queued(b.store)) if (e.stopped && !stoppedBefore.has(e.id)) await note(e.id, 'stopped');
    await queueChanged();
    return sent;
  }

  /**
   * Disconnect removed the pairing: the queue goes, as its confirm said, with any save that went in while it was being
   * deleted, and so does the alarm (F10).
   */
  async function disconnected(): Promise<void> {
    await changeQueue(b.store, (q) => void q.splice(0));
    await b.flushAlarm(false);
    await b.badge();
  }

  /**
   * A move put a save under a new wrap (move.ts): while a send under its old id is under way, the new id is busy too, so
   * a flush leaves it to that send rather than sending it beside it, and the send settles under the new id (movedMidSend).
   * True when one is, since its old wrap may then reach the relay, and Undo has to retract it as well.
   */
  function follow(was: string, to: string): boolean {
    const underWay = saves.follow(was, to);
    if (underWay) movedMidSend.set(was, to);
    return underWay;
  }

  return { save, undo, flushQueue, disconnected, follow };
}
