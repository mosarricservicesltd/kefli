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

const WAITING: Record<ReturnType<typeof whyNot>, Outcome> = { offline: 'waiting, offline', reach: 'waiting, couldn’t reach', blocked: 'waiting, blocked' };

/** What the toast shows of a save, under the id its wrap has now, which Undo names. */
const toasted = (p: Pending, link: boolean) => ({ id: p.id, hash: p.hash, title: p.title, host: p.host, link });

export function background(b: Browser) {
  const saves = new PerSave();
  /**
   * Saves whose request went, or waits to go, without the HTML the operator refused (v1.12), by their wrap's id, until the
   * toast or Copy debug info says so. A flush adds the queue's own marks first, so a save sent again by a background
   * before this one is recorded as sent with no text too.
   */
  const textless = new Set<string>();
  const deliverFor = (ctx: SaveContext) => (p: Delivered) =>
    deliver(p, ctx.defaults.operator.blossom, ctx.defaults.operator.relay, ctx.device, b.net, (q, refused) => (refused ? withoutHtml(q, ctx) : freshen(q, ctx)));

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

  /** The wrap a save goes by now: the last of those that took the named wrap's place, if it went again under another. */
  async function goesBy(id: string): Promise<string> {
    for (let hops = 0; hops < RENAMED_MAX; hops++) {
      const kept = await b.session.get<UndoKey | Renamed>(`undo:${id}`);
      if (!kept || !('to' in kept)) break;
      id = kept.to;
    }
    return id;
  }

  /**
   * The save under a new wrap: the wrap, its key and its id take the old one's place in the queue, with what else
   * changed, and in Undo's key before it is sent, so a worker stopped meanwhile leaves the new wrap for the next flush,
   * and the new id is busy for as long as this send runs, as the old one is. A mark that it goes without text follows it.
   */
  async function takePlace(p: Delivered, again: Again, changed: Partial<Queued>): Promise<void> {
    const was = p.id;
    Object.assign(p, { id: again.wrap.id, wrap: again.wrap, sealed: again.sealed, wrapped_at: b.now() });
    if (textless.delete(was)) textless.add(p.id);
    saves.follow(was, p.id);
    await replaceWrap(b.store, was, { ...changed, id: p.id, wrap: p.wrap, sealed: p.sealed, wrapped_at: p.wrapped_at });
    await moveUndoKey(was, p.id, again.wrapKey, p.sha256);
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
    await b.toast(where, { kind: refused, title: '', host: '', link: true });
    return null;
  }

  async function save(c: Captured, where: Where, link: boolean): Promise<void> {
    // a move found now means this save is wrapped for the new key from the start
    await b.checkMovesSoon();
    const ctx = await b.context();
    if (!ctx) return b.openOptions();
    const p = await prepared(c, ctx, where);
    if (!p) return;
    const { pending, wrapKey } = p;
    await b.toast(where, { ...toasted(pending, link), kind: 'saving' });
    await b.session.set(`undo:${pending.id}`, { key: bytesToHex(wrapKey), sha256: pending.sha256, hash: pending.hash } satisfies UndoKey);
    // into the queue inside the save's own run, so a flush already going never finds it there and not busy, and sends it
    // a second time beside this send
    const { d, s, online } = await saves.run(pending.id, async () => {
      await enqueue(b.store, pending, 'sending');
      await b.flushAlarm(true);
      const online = b.online();
      const d: Delivery = online ? await deliverFor(ctx)(pending) : 'unreachable';
      return { d, online, s: await settle(b.store, pending, d, online, true) };
    });
    // from here the toast names the wrap the save has now, a new one if its HTML was refused, so Undo retracts that
    if (d === 'sent') return sentNow(c, pending, where, link);
    await waits(pending, where, link, { d, s, online });
  }

  /** Saved, or, for a save that went without its text, the toast saying the phone will fetch it. */
  async function sentNow(c: Captured, pending: Pending, where: Where, link: boolean): Promise<void> {
    const noText = textless.delete(pending.id) || c.html === null;
    await record(b.store, b.now(), pending.id, noText ? 'sent, no text' : 'sent', link);
    await queueChanged();
    await b.toast(where, { ...toasted(pending, link), kind: noText ? 'notext' : 'saved' });
    if (where === 'popup') await b.tick();
  }

  /** A save that didn't go at once: taken off the queue meanwhile, refused as the ninth, or waiting, and why. */
  async function waits(pending: Pending, where: Where, link: boolean, r: { d: Exclude<Delivery, 'sent'>; s: Settled; online: boolean }): Promise<void> {
    await queueChanged();
    const base = toasted(pending, link);
    // taken off the queue while it was sending: Disconnect deleted it, as its confirm said
    if (r.s === 'gone') return b.toast(where, { ...base, kind: 'unqueued' });
    if (r.s === 'full') {
      await record(b.store, b.now(), pending.id, 'queue full', link);
      return b.toast(where, { ...base, kind: 'full' });
    }
    const why = whyNot(r.d, r.online);
    await record(b.store, b.now(), pending.id, WAITING[why], link);
    await b.toast(where, { ...base, kind: why === 'offline' ? 'offline' : 'failed' });
    if (where === 'popup' && why === 'offline') await b.tick();
  }

  /**
   * Undo: a save still waiting comes off the queue; one that went is retracted with its wrap's key, and looked for on the
   * phone (decision 101). A retraction that fails, or a key the session no longer holds, says so (F40). A waiting save
   * whose send may have reached the relay all the same (an answer that timed out, a worker stopped mid-send) is retracted
   * as well as taken off the queue; the relay refuses a retraction of a wrap it doesn't hold, which then changes nothing.
   * Undo first waits for a send of the save under way, which may put it under a new wrap when the operator refuses its
   * HTML (v1.12), and then undoes it under the wrap it has now, so a toast that still names the old wrap undoes it too.
   */
  async function undo(id: string, where: Where): Promise<void> {
    const ctx = await b.context();
    if (!ctx) return b.openOptions();
    const now = await saves.run(id, () => goesBy(id));
    await saves.run(now, () => undoNow(now, where, ctx));
  }

  /** What Undo asks of the network: the wrap retracted with its own key, and whether the phone has collected it. */
  function asks(id: string, kept: UndoKey | undefined, ctx: SaveContext) {
    const { relay, blossom } = ctx.defaults.operator;
    return {
      retractIt: () => (kept ? retract({ id, sha256: kept.sha256 }, hexToBytes(kept.key), blossom, relay, ctx.device, b.net, b.now()) : Promise.reject(new Error('no key'))),
      collected: () => b.collected(relay, id, ctx.pairing.user_pubkey),
    };
  }

  async function undoNow(id: string, where: Where, ctx: SaveContext): Promise<void> {
    const kept = await b.session.get<UndoKey>(`undo:${id}`);
    // read on its own line: lizard, which the code gate uses, ends the function at a find called on a bracketed await
    const q = await queued(b.store);
    const waitingSave = q.find((e) => e.id === id);
    if (waitingSave && (await dequeue(b.store, id))) return offTheQueue(waitingSave, kept, where, ctx);
    const { retractIt, collected } = asks(id, kept, ctx);
    const outcome = await settleUndo(retractIt, collected, b.wait).catch(() => 'failed' as const);
    // a failed retraction keeps the key, so Undo pressed again tries again
    if (outcome !== 'failed') await b.session.remove(`undo:${id}`);
    const said: Record<typeof outcome, [Outcome, ToastKind]> = { onphone: ['undo: on the phone', 'onphone'], undone: ['undo: retracted', 'undone'], failed: ['undo: failed', 'undofailed'] };
    await record(b.store, b.now(), id, said[outcome][0]);
    await b.toast(where, { kind: said[outcome][1], hash: kept?.hash, title: '', host: '', link: false });
  }

  /** Undo on a save taken off the queue: retracted too when its send may have reached the relay all the same. */
  async function offTheQueue(e: Queued, kept: UndoKey | undefined, where: Where, ctx: SaveContext): Promise<void> {
    await record(b.store, b.now(), e.id, 'undo: off the queue');
    await queueChanged();
    const { retractIt, collected } = asks(e.id, kept, ctx);
    const tried = e.why !== 'offline' || e.attempts > 0;
    const went = tried && kept ? await settleUndo(retractIt, collected, b.wait).catch(() => 'undone' as const) : 'undone';
    if (kept) await b.session.remove(`undo:${e.id}`);
    if (went === 'onphone') {
      await record(b.store, b.now(), e.id, 'undo: on the phone');
      return b.toast(where, { kind: 'onphone', hash: kept?.hash, title: '', host: '', link: false });
    }
    // the title and host come from the sealed request; the queue doesn't keep them in the clear (F31)
    const [s] = await shown([e], ctx.device);
    return b.toast(where, { kind: 'unqueued', title: s.title, host: s.host, link: false });
  }

  /**
   * A pass over the queue, from the alarm, the browser coming online or Retry. Quiet when not paired (F10). Returns the ids
   * the saves sent went under, a new wrap's for a save sent without its HTML (v1.12), so Retry knows its save went.
   */
  async function flushQueue(all = false, only?: string): Promise<string[]> {
    // a save queued before a move must go to the new key, so a waiting queue looks for one first
    await b.checkMovesSoon();
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
    for (const id of sent) await record(b.store, b.now(), id, textless.delete(id) ? 'sent, no text' : 'sent from queue');
    for (const e of await queued(b.store)) if (e.stopped && !stoppedBefore.has(e.id)) await record(b.store, b.now(), e.id, 'stopped');
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
