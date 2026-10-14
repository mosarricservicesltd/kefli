// Spools left by a share that never finished (mobile spec 8.5): the process died, or was killed, before its sheet
// closed. Each is saved at the next start as an offline share is, its rows released at once (there is no sheet left
// to Undo from), and the spool deleted; its page is fetched by the pending queue, with that queue's timeouts, so the
// sync this runs ahead of doesn't wait on a fetch for every spool. A sheet still open in this process keeps its spool.
import { itemHash } from '@kefli/protocol';
import { KefliShare, type SpoolEntry } from '../../modules/kefli-share/src';
import { release } from '../data/outbox';
import { addressFits } from '../data/saves';
import { saveLater } from '../services/save';
import { store } from '../services/store';

/** A spool younger than this is a live sheet's. */
const FRESH_MS = 30_000;

/** Spools an open share sheet is working on, in this JavaScript runtime (the sheets share the ReactHost). */
export const activeSpools = new Set<string>();

/** Shared text past this is refused as not a link (7.1: a share is a string under 64 KB). */
export const SHARE_MAX_CHARS = 64 * 1024;

// a string, since the code gate's parser misreads regex literals
const ADDRESS = new RegExp('https?://[^\\s<>"]+', 'g');

/** A link Kefli can save: one normalise takes, short enough for its save's event (data/saves addressFits). */
function savable(url: string): boolean {
  try {
    itemHash(url);
    return addressFits(url);
  } catch {
    return false;
  }
}

/**
 * The link a share carries: the last http(s) address in its text, since apps put their own words first. One Kefli
 * can't save ("http://[", a host too long, or an address too long for its event) is passed over for the one before
 * it, so such a share says Not a link, rather than failing on the sheet and again at every start from the spool.
 */
export function firstLink(text: string | null): string | null {
  if (typeof text !== 'string' || text.length >= SHARE_MAX_CHARS) return null;
  const all = text.match(ADDRESS) ?? [];
  for (let i = all.length - 1; i >= 0; i--) if (savable(all[i])) return all[i];
  return null;
}

/** A spool's share, or null when it is gone or can't be read (a file cut short by a power cut, say). */
export function readSpool(id: string): SpoolEntry | null {
  try {
    const entry = KefliShare.read(id);
    return entry && typeof entry === 'object' ? entry : null;
  } catch (e) {
    console.log(`[kefli-pickup] ${JSON.stringify({ unreadable: id, error: String((e as Error)?.message ?? e) })}`);
    return null;
  }
}

let picking: Promise<number> | null = null;

/** Returns how many spools were saved. Concurrent calls (the start's several triggers) share one run. */
export function pickUpSpools(): Promise<number> {
  picking ??= pickUp().finally(() => {
    picking = null;
  });
  return picking;
}

async function pickUp(): Promise<number> {
  let saved = 0;
  for (const id of KefliShare.listSpools()) {
    if (activeSpools.has(id)) continue;
    // a spool this young belongs to a sheet still rising: the share brought Kefli to the front, which starts a sync
    // before the sheet has claimed it (seen on the Pixel, 8 October)
    const entry = readSpool(id);
    if (entry && Date.now() - entry.receivedAt < FRESH_MS) continue;
    const url = firstLink(entry?.text ?? null);
    try {
      if (url) {
        const r = await saveLater(url, (st) => console.log(`[kefli-pickup] ${JSON.stringify(st)}`));
        release(store(), r.held);
        if (r.hash) saved++;
      }
      KefliShare.deleteSpool(id);
    } catch (e) {
      // kept for the next start, and the spools behind it are still saved: one that fails no longer stops them all
      console.log(`[kefli-pickup] ${JSON.stringify({ kept: id, error: String((e as Error)?.message ?? e) })}`);
    }
  }
  return saved;
}
