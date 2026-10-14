// Saves waiting to send (extension spec 4, flow decisions 30, 31 and 60): at most eight, kept already encrypted in
// storage.local, retried every minute while any wait. A ninth is refused rather than queued, so nothing is lost silently.
// After 200 attempts an entry stops and waits for Retry on the options page.
//
// A save goes in before its first send, so a worker stopped or a browser closed mid-send leaves it here for the next
// flush (F23). Every change reads and writes the queue under one lock (F41), and a save's send and its Undo run one at a
// time (F40).
//
// Kept encrypted (the extension's privacy note, F31): an entry holds the wrap, which only the user's key opens, the
// inbox blob, which only the wrap's key opens, and the request sealed to the device's own key. The page's title,
// host and hash are never stored beside them; the options page and Undo read them back from the sealed request.
import { itemHash } from '../../../packages/protocol/src/normalise';
import type { LocalSigner } from '../../../packages/protocol/src/signer';
import { exclusive, PerSave } from './lock';
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
/**
 * The blobs kept at once, saves on their first send included: room for the eight largest that wait. Saves on their
 * first send aren't counted among the eight, so a dozen big pages saved while the server was slow kept a dozen blobs,
 * past the 10 MB Chrome gives storage.local (QUOTA_BYTES); the write that went over was refused and that save was lost.
 * Past this a blob isn't kept, as one too large isn't, and the phone fetches that page itself.
 */
export const BLOBS_KEEP_MAX = QUEUE_MAX * BLOB_KEEP_MAX;
/**
 * The most entries kept at once, saves on their first send included, so they can't fill storage.local between them
 * even without blobs (an entry is up to 20 KB). A save past this is sent all the same, without being kept first.
 */
export const ENTRIES_MAX = 64;

export interface Queued extends Omit<Pending, (typeof PLAIN)[number]> {
  /**
   * Why it hasn't sent: the browser is offline (it waits, and counts on the badge), Kefli's server couldn't be reached
   * while online, or something in the browser refuses it (spec 6, Brave). The last two are listed as Couldn't send.
   * 'sending' is a save whose first send hasn't ended; it is neither counted nor listed, and isn't one of the eight.
   */
  why: 'sending' | 'offline' | 'reach' | 'blocked';
  stopped: boolean;
}

export async function queued(store: Store): Promise<Queued[]> {
  const kept = await store.get<Queued[]>(KEYS.queue);
  // anything else there (a value no version of the queue writes) would stop every save, flush and the options page
  return Array.isArray(kept) ? kept.filter((e) => typeof e?.id === 'string').map(sealedOnly) : [];
}

/** Reads, changes in place and writes back the queue under its lock, so no change made meanwhile is overwritten (F41). */
export function changeQueue<T>(store: Store, edit: (q: Queued[]) => T | Promise<T>): Promise<T> {
  return exclusive('queue', async () => {
    const q = await queued(store);
    const out = await edit(q);
    await store.set(KEYS.queue, q);
    return out;
  });
}

/** The blob as kept: none when it is too large, or when the other entries' blobs leave no room for it. */
function keepable(blob: string | null, q: Queued[], but?: string): string | null {
  if (blob === null || blob.length > BLOB_KEEP_MAX) return null;
  const others = q.reduce((n, e) => n + (e.id === but ? 0 : (e.blob?.length ?? 0)), 0);
  return others + blob.length > BLOBS_KEEP_MAX ? null : blob;
}
/** How many of the eight are taken: every entry but saves on their first send, and the one named. */
const taken = (q: Queued[], but?: string) => q.filter((e) => e.why !== 'sending' && e.id !== but).length;

/**
 * 'full' when eight already wait (decision 31), or when ENTRIES_MAX entries are kept. A save going in for its first send
 * is otherwise always taken; settle decides.
 */
export async function enqueue(store: Store, p: Pending, why: Queued['why']): Promise<'queued' | 'full'> {
  return changeQueue(store, (q) => {
    if ((why !== 'sending' && taken(q) >= QUEUE_MAX) || q.length >= ENTRIES_MAX) return 'full';
    q.push({ ...sealedOnly(p), blob: keepable(p.blob, q), why, stopped: false });
    return 'queued';
  });
}

export async function dequeue(store: Store, id: string): Promise<boolean> {
  return changeQueue(store, (q) => {
    const i = q.findIndex((e) => e.id === id);
    if (i >= 0) q.splice(i, 1);
    return i >= 0;
  });
}

export type Settled = 'sent' | 'queued' | 'full' | 'gone';

/**
 * What a send did to its entry: a sent one leaves; one that didn't send counts an attempt, says why and stops at 200.
 * After a save's first send (first), one that didn't send leaves as 'full' when eight others already wait. 'gone' is an
 * entry that had already left the queue (Disconnect).
 */
export async function settle(store: Store, p: Pick<Pending, 'id' | 'blob'>, d: Delivery, online: boolean, first = false): Promise<Settled> {
  return changeQueue(store, (q): Settled => {
    const i = q.findIndex((x) => x.id === p.id);
    if (i < 0) return 'gone';
    if (d === 'sent' || (first && taken(q, p.id) >= QUEUE_MAX)) {
      q.splice(i, 1);
      return d === 'sent' ? 'sent' : 'full';
    }
    const attempts = first ? 0 : q[i].attempts + 1;
    q[i] = { ...q[i], blob: keepable(p.blob, q, p.id), attempts, why: whyNot(d, online), stopped: attempts >= ATTEMPTS_MAX };
    return 'queued';
  });
}

/** Offline saves only: what the badge, the button's name and the options notice count (decision 30). */
export function waiting(q: Queued[]): number {
  return q.filter((e) => e.why === 'offline').length;
}

/** The options page's Couldn't send list: everything else still here but a save on its first send. */
export function failed<T extends Queued>(q: T[]): T[] {
  return q.filter((e) => e.why !== 'offline' && e.why !== 'sending');
}

/** Why a delivery that didn't send leaves its save waiting. */
export function whyNot(d: Exclude<Delivery, 'sent'>, online: boolean): Exclude<Queued['why'], 'sending'> {
  if (d === 'blocked') return 'blocked';
  return online ? 'reach' : 'offline';
}

export interface FlushOptions {
  /** Stopped entries too (Retry). */
  all?: boolean;
  /** Only this entry (Retry on one row). */
  only?: string;
  /** The background's saves in flight, shared with save and Undo. */
  saves?: PerSave;
}

/**
 * One pass over the queue: each entry still trying (or every entry, or the one named, for Retry) is delivered; a sent one
 * leaves, the others count an attempt and stop at 200. A save whose send is already under way is left to it, and each
 * entry is read again as its turn comes, so one undone or moved meanwhile isn't sent (F40). Returns the ids that were sent.
 */
export async function flush(store: Store, send: (p: Queued) => Promise<Delivery>, online: boolean, o: FlushOptions = {}): Promise<string[]> {
  const saves = o.saves ?? new PerSave();
  const sent: string[] = [];
  for (const { id } of await queued(store)) {
    if ((o.only !== undefined && id !== o.only) || saves.busy(id)) continue;
    const went = await saves.run(id, async () => {
      const e = (await queued(store)).find((x) => x.id === id);
      if (!e || (e.stopped && !o.all)) return false;
      return (await settle(store, e, await send(e), online)) === 'sent';
    });
    if (went) sent.push(id);
  }
  return sent;
}
