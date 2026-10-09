// Saves waiting to send (extension spec 4, flow decisions 30, 31 and 60): at most eight, kept already encrypted in
// storage.local, retried every minute while any wait. A ninth is refused rather than queued, so nothing is lost silently.
// After 200 attempts an entry stops and waits for Retry on the options page.
import type { Delivery, Pending } from './save';
import { KEYS, type Store } from './store';

export const QUEUE_MAX = 8;
export const ATTEMPTS_MAX = 200;
/** An inbox blob larger than this (as base64) isn't kept while offline; the phone fetches that page itself. */
export const BLOB_KEEP_MAX = 900_000;

export interface Queued extends Pending {
  /**
   * Why it hasn't sent: the browser is offline (it waits, and counts on the badge), Kefli's server couldn't be reached
   * while online, or something in the browser refuses it (spec 6, Brave). The last two are listed as Couldn't send.
   */
  why: 'offline' | 'reach' | 'blocked';
  stopped: boolean;
}

export async function queued(store: Store): Promise<Queued[]> {
  return (await store.get<Queued[]>(KEYS.queue)) ?? [];
}

/** 'full' when eight already wait (decision 31). */
export async function enqueue(store: Store, p: Pending, why: Queued['why']): Promise<'queued' | 'full'> {
  const q = await queued(store);
  if (q.length >= QUEUE_MAX) return 'full';
  const blob = p.blob !== null && p.blob.length > BLOB_KEEP_MAX ? null : p.blob;
  q.push({ ...p, blob, why, stopped: false });
  await store.set(KEYS.queue, q);
  return 'queued';
}

export async function dequeue(store: Store, id: string): Promise<boolean> {
  const q = await queued(store);
  const rest = q.filter((e) => e.id !== id);
  await store.set(KEYS.queue, rest);
  return rest.length !== q.length;
}

/** Offline saves only: what the badge, the button's name and the options notice count (decision 30). */
export function waiting(q: Queued[]): number {
  return q.filter((e) => e.why === 'offline').length;
}

/** The options page's Couldn't send list: everything else still here. */
export function failed(q: Queued[]): Queued[] {
  return q.filter((e) => e.why !== 'offline');
}

/** Why a delivery that didn't send leaves its save waiting. */
export function whyNot(d: Exclude<Delivery, 'sent'>, online: boolean): Queued['why'] {
  if (d === 'blocked') return 'blocked';
  return online ? 'reach' : 'offline';
}

/**
 * One pass over the queue: each entry still trying (or every entry, for Retry) is delivered; a sent one leaves, the
 * others count an attempt and stop at 200. Returns the ids that were sent.
 */
export async function flush(store: Store, send: (p: Pending) => Promise<Delivery>, online: boolean, all = false): Promise<string[]> {
  const sent: string[] = [];
  for (const e of await queued(store)) {
    if (e.stopped && !all) continue;
    const d = await send(e);
    const q = await queued(store);
    const i = q.findIndex((x) => x.id === e.id);
    if (i < 0) continue;
    if (d === 'sent') {
      q.splice(i, 1);
      sent.push(e.id);
    } else {
      q[i] = { ...q[i], blob: e.blob, attempts: q[i].attempts + 1, why: whyNot(d, online), stopped: q[i].attempts + 1 >= ATTEMPTS_MAX };
    }
    await store.set(KEYS.queue, q);
  }
  return sent;
}
