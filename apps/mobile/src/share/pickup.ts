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

/** The most addresses in one share that are tried, from the last: a share holds one or two. */
export const SHARE_MAX_TRIES = 16;

// strings, since the code gate's parser misreads regex literals. An address ends at a space, < > or ", and at U+FFFC,
// the mark a picture in styled text leaves in its plain text: ShareText.kt reads it as a space in styled text, but an
// app that flattens its own styled text sends a plain share with the mark as it is, and it was saved as part of the
// address beside it, a page that wasn't there.
const ADDRESS = new RegExp('https?://[^\\s<>"\\ufffc]+', 'g');
const PICTURE = new RegExp('\\ufffc', 'g');
// marks that show nothing: zero-width spaces and joiners, and the direction marks right-to-left chat apps put round a link
const INVISIBLE = new RegExp('[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u2069\\ufeff]');
const SENTENCE_END = '.,;:!?';

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
 * RULED: a link inside a sentence is read as it was written. Invisible marks at its end go, and so do the sentence's
 * punctuation and a closing bracket the link doesn't open ("(see https://a.example/x)."), which used to be saved as
 * part of the address, giving a page that wasn't there. A link that is the whole share, as a browser shares a page,
 * keeps them (an address may end in a full stop). Linear: each count is made once.
 */
function asWritten(link: string, whole: boolean): string {
  let end = link.length;
  while (end > 0 && INVISIBLE.test(link[end - 1])) end--;
  if (whole) return link.slice(0, end);
  const count = (c: string) => link.slice(0, end).split(c).length - 1;
  let open = count('(') - count(')');
  let square = count('[') - count(']');
  while (end > 0) {
    const c = link[end - 1];
    if (SENTENCE_END.includes(c) || INVISIBLE.test(c)) {
      end--;
    } else if (c === ')' && open < 0) {
      end--;
      open++;
    } else if (c === ']' && square < 0) {
      end--;
      square++;
    } else {
      break;
    }
  }
  return link.slice(0, end);
}

/**
 * The link a share carries: the last http(s) address in its text, since apps put their own words first, read as it
 * was written (asWritten). One Kefli can't save ("http://[", a host too long, or an address too long for its event)
 * is passed over for the one before it, the last 16 at most, so such a share says Not a link, rather than failing on
 * the sheet and again at every start from the spool. A picture's mark counts as a space here too, so a link and a
 * picture are still a link that is the whole share.
 */
export function firstLink(text: string | null): string | null {
  if (typeof text !== 'string' || text.length >= SHARE_MAX_CHARS) return null;
  const all = text.match(ADDRESS) ?? [];
  const whole = all.length === 1 && text.replace(PICTURE, ' ').trim() === all[0];
  for (let i = all.length - 1, tries = 0; i >= 0 && tries < SHARE_MAX_TRIES; i--, tries++) {
    const link = asWritten(all[i], whole);
    if (savable(link)) return link;
  }
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

/** What a share sheet opens on: the link its spool carries, or why there is none. */
export type SheetLink = { url: string } | { url: null; why: 'failed' | 'nolink' };

/**
 * The link a sheet's spool carries (5.4). A spool gone or unreadable when its sheet opens is a share that didn't save
 * (That didn't save, Try sharing it again): a share held in memory for want of room to write it goes with its process,
 * so a sheet brought back after it finds nothing, and sharing again mends that. A spool that holds no address Kefli
 * can save is Not a link, which sharing the same thing again would not mend.
 */
export function sheetLink(spoolId: string | undefined): SheetLink {
  const entry = spoolId ? readSpool(spoolId) : null;
  if (!entry) return { url: null, why: 'failed' };
  const url = firstLink(entry.text);
  return url ? { url } : { url: null, why: 'nolink' };
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
