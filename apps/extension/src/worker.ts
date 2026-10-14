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
import { PerSave } from './lock';
import { changeQueue, dequeue, enqueue, flush, queued, replaceWrap, settle, shown, whyNot, type Queued, type Settled } from './queue';
import {
  AddressTooLongError, deliver, freshWrap, prepare, retract, withoutText, WRAP_FRESH_FOR, type Again, type Delivered, type Delivery, type Net, type Pending, type SaveContext,
} from './save';
import type { Store } from './store';
import type { ToastKind, ToastState } from './toastCopy';
import { settleUndo } from './undo';

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
  /** Whether the phone has collected a save (relay.ts). */
  collected(relay: string, wrapId: string, user: string): Promise<boolean>;
  wait(ms: number): Promise<void>;
}

/** What Undo keeps of a save for the session: the wrap's own key, which alone can retract it. */
interface UndoKey {
  key: string;
  sha256: string | null;
  hash: string;
}

/**
 * What Undo keeps in a wrap's place once the save went again under another, its HTML refused (v1.12) or its wrap made
 * again: a toast still naming the old wrap, such as the offline one, then undoes the save under the wrap it has now (F40).
 */
interface Renamed {
  to: string;
}

/**
 * How many new wraps Undo follows from the one a toast names. A wrap is made again at most once a minute, at a send that
 * then fails, and a toast leaves after eight seconds unless the pointer or focus holds it.
 */
const RENAMED_MAX = 64;

/** One Undo's save, where it is told, the session's key for it, and what retracts it, looks for it and forgets it. */
interface UndoOf {
  id: string;
  where: Where;
  kept: UndoKey | undefined;
  retractIt(): Promise<void>;
  collected(): Promise<boolean>;
  forget(): Promise<void>;
}

const WAITING: Record<ReturnType<typeof whyNot>, Outcome> = { offline: 'waiting, offline', reach: 'waiting, couldn’t reach', blocked: 'waiting, blocked' };

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
  const deliverFor = (ctx: SaveContext) => (p: Delivered) =>
    deliver(p, ctx.defaults.operator.blossom, ctx.defaults.operator.relay, ctx.device, b.net, (q, refused) => (refused ? withoutHtml(q, ctx) : freshen(q, ctx)));

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
   * Undo's key moved to a save's new wrap: the key that alone retracts it, and the inbox blob it deletes, if the operator
   * holds one. The old wrap's id points to the new one, for an Undo pressed on a toast that still names it.
   */
  async function moveUndoKey(was: string, to: string, wrapKey: Uint8Array, sha256: string | null): Promise<void> {
    const kept = await b.session.get<UndoKey>(`undo:${was}`);
    if (!kept) return;
    await b.session.set(`undo:${to}`, { key: bytesToHex(wrapKey), sha256, hash: kept.hash } satisfies UndoKey);
    await b.session.set(`undo:${was}`, { to } satisfies Renamed);
  }

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
   * Undo saying it couldn't undo, rather than holding the save.
   */
  async function takePlace(p: Delivered, again: Again, changed: Partial<Queued>): Promise<void> {
    const was = p.id;
    const next = { id: again.wrap.id, wrap: again.wrap, sealed: again.sealed, wrapped_at: b.now() };
    saves.follow(was, next.id);
    const placed = await replaceWrap(b.store, was, { ...changed, ...next }).then(() => true, () => false);
    if (!placed) return;
    Object.assign(p, next);
    if (textless.delete(was)) textless.add(p.id);
    await moveUndoKey(was, p.id, again.wrapKey, p.sha256).catch(() => undefined);
  }

  /**
   * The operator refused the save's upload for good (contract 4.4 and 5, v1.12), and the extension doesn't wait for room:
   * the request goes with `html` null, rebuilt and signed again with the same uuid, under a new wrap (takePlace). A
   * request that can't be rebuilt goes as it was, and the phone, finding no blob, fetches the page at once.
   */
  async function withoutHtml(p: Delivered, ctx: SaveContext): Promise<void> {
    p.sha256 = null;
    const again = await withoutText(p, ctx.device, b.now());
    if (again) await takePlace(p, again, { blob: null, sha256: null, textless: true });
    textless.add(p.id);
  }

  /**
   * A wrap made more than a minute ago is made again before it goes (WRAP_FRESH_FOR, contract 4.4): the same request,
   * under a new wrap dated from now (takePlace). Offline the send fails anyway, so the wrap waits as it is.
   */
  async function freshen(p: Delivered, ctx: SaveContext): Promise<void> {
    if (b.now() - (p.wrapped_at ?? 0) <= WRAP_FRESH_FOR || !b.online()) return;
    const again = await freshWrap(p, ctx.device, b.now());
    if (again) await takePlace(p, again, {});
  }

  /**
   * After the queue changes: the alarm is on while anything still tries and goes once nothing does, and the badge counts
   * what waits. Turned on here as well as at a save, since the alarm may be gone after a browser restart (Firefox keeps
   * none) and a start-up flush that fails must still leave one to try again.
   */
  async function queueChanged(): Promise<void> {
    await b.flushAlarm((await queued(b.store)).some((e) => !e.stopped));
    await b.badge();
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
    if (kept) return { d, online, s: await settle(b.store, pending, d, online, true).catch((): Settled => 'queued') };
    if (d === 'sent') return { d, online, s: 'sent' };
    // with the mark a save whose HTML the operator refused carries in the queue, for whichever background sends it
    const smaller = { ...pending, blob: null, ...(textless.has(pending.id) ? { textless: true as const } : {}) };
    const s = await enqueue(b.store, smaller, whyNot(d, online)).catch((): Settled => 'full');
    return { d, online, s };
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
    if (d === 'sent') return sentNow(c, pending, where, link);
    await waits(pending, where, link, { d, s, online });
  }

  /** Saved, or, for a save that went without its text, the toast saying the phone will fetch it. */
  async function sentNow(c: Captured, pending: Pending, where: Where, link: boolean): Promise<void> {
    const noText = textless.delete(pending.id) || c.html === null;
    await note(pending.id, noText ? 'sent, no text' : 'sent', link);
    await queueChanged();
    await toast(where, { ...toasted(pending, link), kind: noText ? 'notext' : 'saved' });
    if (where === 'popup') await b.tick();
  }

  /** A save that didn't go at once: taken off the queue meanwhile, refused as the ninth, or waiting, and why. */
  async function waits(pending: Pending, where: Where, link: boolean, r: { d: Exclude<Delivery, 'sent'>; s: Settled; online: boolean }): Promise<void> {
    await queueChanged();
    const base = toasted(pending, link);
    // taken off the queue while it was sending: Disconnect deleted it, as its confirm said
    if (r.s === 'gone') return toast(where, { ...base, kind: 'unqueued' });
    if (r.s === 'full') {
      await note(pending.id, 'queue full', link);
      return toast(where, { ...base, kind: 'full' });
    }
    const why = whyNot(r.d, r.online);
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
   * A second Undo of a save already undone, such as a double click, changes and says nothing more.
   */
  async function undo(id: string, where: Where): Promise<void> {
    const ctx = await b.context();
    if (!ctx) return b.openOptions();
    const now = await saves.run(id, () => goesBy(id));
    await saves.run(now, () => undoNow(now, where, ctx));
  }

  /**
   * One Undo of the save under the wrap it goes by now: its wrap retracted with its own key, the look for it on the
   * phone, and its key forgotten once it is undone, so a second press says nothing more.
   */
  function undoOf(id: string, where: Where, kept: UndoKey | undefined, ctx: SaveContext): UndoOf {
    const { relay, blossom } = ctx.defaults.operator;
    return {
      id, where, kept,
      retractIt: () => (kept ? retract({ id, sha256: kept.sha256 }, hexToBytes(kept.key), blossom, relay, ctx.device, b.net, b.now()) : Promise.reject(new Error('no key'))),
      collected: () => b.collected(relay, id, ctx.pairing.user_pubkey),
      forget: async () => {
        undone.add(id);
        await b.session.remove(`undo:${id}`).catch(() => undefined);
      },
    };
  }

  async function undoNow(id: string, where: Where, ctx: SaveContext): Promise<void> {
    // already undone: its toast says so, and a second press changes and says nothing more
    if (undone.has(id)) return;
    const kept = await b.session.get<UndoKey>(`undo:${id}`).catch(() => undefined);
    const u = undoOf(id, where, kept, ctx);
    // read on its own line: lizard, which the code gate uses, ends the function at a find called on a bracketed await
    const q = await queued(b.store);
    const waitingSave = q.find((e) => e.id === id);
    if (waitingSave && (await dequeue(b.store, id))) return unqueue(u, waitingSave, ctx.device);
    const outcome = await settleUndo(u.retractIt, u.collected, b.wait).catch(() => 'failed' as const);
    // a failed retraction keeps the key, so Undo pressed again tries again; one found on the phone is looked for again
    if (outcome === 'undone') await u.forget();
    if (outcome === 'onphone') await b.session.remove(`undo:${id}`).catch(() => undefined);
    const said: Record<typeof outcome, [Outcome, ToastKind]> = { onphone: ['undo: on the phone', 'onphone'], undone: ['undo: retracted', 'undone'], failed: ['undo: failed', 'undofailed'] };
    await note(id, said[outcome][0]);
    await toast(where, { kind: said[outcome][1], hash: kept?.hash, title: '', host: '', link: false });
  }

  /** Undo of a save still in the queue: off it, and retracted as well when its send may have reached the relay. */
  async function unqueue(u: UndoOf, waitingSave: Queued, device: SaveContext['device']): Promise<void> {
    await note(u.id, 'undo: off the queue');
    await queueChanged();
    const tried = waitingSave.why !== 'offline' || waitingSave.attempts > 0;
    const went = tried && u.kept ? await settleUndo(u.retractIt, u.collected, b.wait).catch(() => 'undone' as const) : 'undone';
    if (went === 'onphone') {
      if (u.kept) await b.session.remove(`undo:${u.id}`).catch(() => undefined);
      await note(u.id, 'undo: on the phone');
      return toast(u.where, { kind: 'onphone', hash: u.kept?.hash, title: '', host: '', link: false });
    }
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

  return { save, undo, flushQueue, disconnected };
}
