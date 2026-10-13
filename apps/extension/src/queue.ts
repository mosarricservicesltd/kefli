// Saves waiting to send (extension spec 4, flow decisions 30, 31 and 60): at most eight, kept already encrypted in
// storage.local, retried every minute while any wait. A ninth is refused rather than queued, so nothing is lost silently.
// After 200 attempts an entry stops and waits for Retry on the options page.
//
// Kept encrypted (the extension's privacy note, F31): an entry holds the wrap, which only the user's key opens, the
// inbox blob, which only the wrap's key opens, and the request sealed to the device's own key. The page's title,
// host and hash are never stored beside them; the options page and Undo read them back from the sealed request.
import { itemHash } from '../../../packages/protocol/src/normalise';
import type { LocalSigner } from '../../../packages/protocol/src/signer';
import { hostOf, type Delivery, type Pending } from './save';
import { KEYS, type Store } from './store';

/** What a queued save shows: read back from its sealed request, never stored in the clear. */
export interface Shown extends Queued {
  title: string;
  host: string;
  hash: string;
}

const PLAIN = ['title', 'host', 'hash'] as const;
/** An entry without the fields that would name the page: what is stored (and an entry stored before F31, cleaned). */
function sealedOnly<T extends object>(e: T): Omit<T, (typeof PLAIN)[number]> {
  const out = { ...e } as Record<string, unknown>;
  for (const k of PLAIN) delete out[k];
  return out as Omit<T, (typeof PLAIN)[number]>;
}

/** The queued saves with their title, host and hash, read from each sealed request with the device key. */
export async function shown(q: Queued[], device: Pick<LocalSigner, 'nip44Decrypt' | 'pubkey'>): Promise<Shown[]> {
  return Promise.all(q.map(async (e) => {
    try {
      const { request } = JSON.parse(await device.nip44Decrypt(device.pubkey(), e.sealed)) as { request: { url: string; canonical: string | null; title: string | null } };
      return { ...e, title: request.title ?? hostOf(request.url), host: hostOf(request.url), hash: itemHash(request.url, request.canonical) };
    } catch {
      return { ...e, title: 'A saved page', host: '', hash: '0'.repeat(64) };
    }
  }));
}

export const QUEUE_MAX = 8;
export const ATTEMPTS_MAX = 200;
/** An inbox blob larger than this (as base64) isn't kept while offline; the phone fetches that page itself. */
export const BLOB_KEEP_MAX = 900_000;

export interface Queued extends Omit<Pending, (typeof PLAIN)[number]> {
  /**
   * Why it hasn't sent: the browser is offline (it waits, and counts on the badge), Kefli's server couldn't be reached
   * while online, or something in the browser refuses it (spec 6, Brave). The last two are listed as Couldn't send.
   */
  why: 'offline' | 'reach' | 'blocked';
  stopped: boolean;
}

export async function queued(store: Store): Promise<Queued[]> {
  return ((await store.get<Queued[]>(KEYS.queue)) ?? []).map(sealedOnly);
}

/** 'full' when eight already wait (decision 31). */
export async function enqueue(store: Store, p: Pending, why: Queued['why']): Promise<'queued' | 'full'> {
  const q = await queued(store);
  if (q.length >= QUEUE_MAX) return 'full';
  const blob = p.blob !== null && p.blob.length > BLOB_KEEP_MAX ? null : p.blob;
  q.push({ ...sealedOnly(p), blob, why, stopped: false });
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
export function failed<T extends Queued>(q: T[]): T[] {
  return q.filter((e) => e.why !== 'offline');
}

/** Why a delivery that didn't send leaves its save waiting. */
export function whyNot(d: Exclude<Delivery, 'sent'>, online: boolean): Queued['why'] {
  if (d === 'blocked') return 'blocked';
  return online ? 'reach' : 'offline';
}

/**
 * One pass over the queue: each entry still trying (or every entry, or the one named, for Retry) is delivered; a sent one
 * leaves, the others count an attempt and stop at 200. Returns the ids that were sent.
 */
export async function flush(store: Store, send: (p: Queued) => Promise<Delivery>, online: boolean, all = false, only?: string): Promise<string[]> {
  const sent: string[] = [];
  for (const e of await queued(store)) {
    if ((e.stopped && !all) || (only !== undefined && e.id !== only)) continue;
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
