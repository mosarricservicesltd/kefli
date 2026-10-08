// Spools left by a share that never finished (mobile spec 8.5): the process died, or was killed, before its sheet
// closed. Each is saved at the next start as the sheet would have saved it, its rows released at once (there is no
// sheet left to Undo from), and the spool deleted. A sheet still open in this process keeps its spool.
import { ShelfShare } from '../../modules/shelf-share/src';
import { release } from '../data/outbox';
import { saveLink } from '../services/save';
import { store } from '../services/store';

/** A spool younger than this is a live sheet's. */
const FRESH_MS = 30_000;

/** Spools an open share sheet is working on, in this JavaScript runtime (the sheets share the ReactHost). */
export const activeSpools = new Set<string>();

/** The link a share carries: the last http(s) address in its text, since apps put their own words first. */
export function firstLink(text: string | null): string | null {
  const all = text?.match(/https?:\/\/[^\s<>"]+/g) ?? [];
  return all.length ? all[all.length - 1] : null;
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
  for (const id of ShelfShare.listSpools()) {
    if (activeSpools.has(id)) continue;
    // a spool this young belongs to a sheet still rising: the share brought Shelf to the front, which starts a sync
    // before the sheet has claimed it (seen on the Pixel, 8 October)
    const entry = ShelfShare.read(id);
    if (entry && Date.now() - entry.receivedAt < FRESH_MS) continue;
    const url = firstLink(entry?.text ?? null);
    if (url) {
      const r = await saveLink(url, (st) => console.log(`[shelf-pickup] ${JSON.stringify(st)}`));
      release(store(), r.held);
      if (r.hash) saved++;
    }
    ShelfShare.deleteSpool(id);
  }
  return saved;
}
