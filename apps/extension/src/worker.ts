// The background's work on a save (extension spec 2 and 4): saving, Undo, the queue's flush and Disconnect. bg.ts passes
// in the browser's parts (storage, the toast, the badge, the alarm and the relay), so the tests can play them.
//
// A save goes into the queue before its first send, so a worker stopped or a browser closed mid-send leaves it there
// for the next flush (F23). A save's send and its Undo run one at a time, so Undo pressed while a send is under way waits
// for it and then retracts what went or takes back what didn't (F40). Undo isn't timed here: it can only be pressed on a
// toast or popup still showing it, whose countdown pauses while the pointer or focus is on it (decision 38, F24).
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { isWebAddress, type Captured } from './captured';
import { record, type Outcome } from './debug';
import { PerSave } from './lock';
import { changeQueue, dequeue, enqueue, flush, queued, settle, shown, whyNot } from './queue';
import { AddressTooLongError, deliver, prepare, retract, type Delivery, type Net, type Pending, type SaveContext } from './save';
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

const WAITING: Record<ReturnType<typeof whyNot>, Outcome> = { offline: 'waiting, offline', reach: 'waiting, couldn’t reach', blocked: 'waiting, blocked' };

export function background(b: Browser) {
  const saves = new PerSave();
  const deliverFor = (ctx: SaveContext) => (p: Pick<Pending, 'id' | 'wrap' | 'blob' | 'sha256'>) => deliver(p, ctx.defaults.operator.blossom, ctx.defaults.operator.relay, ctx.device, b.net);

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
    const base = { id: pending.id, hash: pending.hash, title: pending.title, host: pending.host, link };
    await b.toast(where, { ...base, kind: 'saving' });
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
    if (d === 'sent') {
      await record(b.store, b.now(), pending.id, c.html === null ? 'sent, no text' : 'sent', link);
      await queueChanged();
      await b.toast(where, { ...base, kind: c.html === null ? 'notext' : 'saved' });
      if (where === 'popup') await b.tick();
      return;
    }
    await queueChanged();
    // taken off the queue while it was sending: Disconnect deleted it, as its confirm said
    if (s === 'gone') return b.toast(where, { ...base, kind: 'unqueued' });
    if (s === 'full') {
      await record(b.store, b.now(), pending.id, 'queue full', link);
      return b.toast(where, { ...base, kind: 'full' });
    }
    const why = whyNot(d, online);
    await record(b.store, b.now(), pending.id, WAITING[why], link);
    await b.toast(where, { ...base, kind: why === 'offline' ? 'offline' : 'failed' });
    if (where === 'popup' && why === 'offline') await b.tick();
  }

  /**
   * Undo: a save still waiting comes off the queue; one that went is retracted with its wrap's key, and looked for on the
   * phone (decision 101). A retraction that fails, or a key the session no longer holds, says so (F40). A waiting save
   * whose send may have reached the relay all the same (an answer that timed out, a worker stopped mid-send) is retracted
   * as well as taken off the queue; the relay refuses a retraction of a wrap it doesn't hold, which then changes nothing.
   */
  async function undo(id: string, where: Where): Promise<void> {
    const ctx = await b.context();
    if (!ctx) return b.openOptions();
    await saves.run(id, async () => {
      const kept = await b.session.get<UndoKey>(`undo:${id}`);
      const { relay, blossom } = ctx.defaults.operator;
      const retractIt = () => (kept ? retract({ id, sha256: kept.sha256 }, hexToBytes(kept.key), blossom, relay, ctx.device, b.net, b.now()) : Promise.reject(new Error('no key')));
      const collected = () => b.collected(relay, id, ctx.pairing.user_pubkey);
      const waitingSave = (await queued(b.store)).find((e) => e.id === id);
      if (waitingSave && (await dequeue(b.store, id))) {
        await record(b.store, b.now(), id, 'undo: off the queue');
        await queueChanged();
        const tried = waitingSave.why !== 'offline' || waitingSave.attempts > 0;
        const went = tried && kept ? await settleUndo(retractIt, collected, b.wait).catch(() => 'undone' as const) : 'undone';
        if (kept) await b.session.remove(`undo:${id}`);
        if (went === 'onphone') {
          await record(b.store, b.now(), id, 'undo: on the phone');
          return b.toast(where, { kind: 'onphone', hash: kept?.hash, title: '', host: '', link: false });
        }
        // the title and host come from the sealed request; the queue doesn't keep them in the clear (F31)
        const [s] = await shown([waitingSave], ctx.device);
        return b.toast(where, { kind: 'unqueued', title: s.title, host: s.host, link: false });
      }
      const outcome = await settleUndo(retractIt, collected, b.wait).catch(() => 'failed' as const);
      // a failed retraction keeps the key, so Undo pressed again tries again
      if (outcome !== 'failed') await b.session.remove(`undo:${id}`);
      const said: Record<typeof outcome, [Outcome, ToastKind]> = { onphone: ['undo: on the phone', 'onphone'], undone: ['undo: retracted', 'undone'], failed: ['undo: failed', 'undofailed'] };
      await record(b.store, b.now(), id, said[outcome][0]);
      await b.toast(where, { kind: said[outcome][1], hash: kept?.hash, title: '', host: '', link: false });
    });
  }

  /** A pass over the queue, from the alarm, the browser coming online or Retry. Quiet when not paired (F10). */
  async function flushQueue(all = false, only?: string): Promise<void> {
    // a save queued before a move must go to the new key, so a waiting queue looks for one first
    await b.checkMovesSoon();
    const ctx = await b.context();
    // nothing to send to, and nobody asked: the alarm goes rather than opening the options page every minute
    if (!ctx) return b.flushAlarm(false);
    const stoppedBefore = new Set((await queued(b.store)).filter((e) => e.stopped).map((e) => e.id));
    const sent = await flush(b.store, deliverFor(ctx), b.online(), { all, only, saves });
    for (const id of sent) await record(b.store, b.now(), id, 'sent from queue');
    for (const e of await queued(b.store)) if (e.stopped && !stoppedBefore.has(e.id)) await record(b.store, b.now(), e.id, 'stopped');
    await queueChanged();
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
