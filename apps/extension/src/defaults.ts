// The operator's defaults.json (contract 3.1), fetched from the flavour's address and kept, so a save made offline
// still knows the operator relay and Blossom server.
import { KEYS, type Store } from './store';

export interface Defaults {
  v: 1;
  operator: { relay: string; blossom: string; api: string };
  relays: string[];
  mirrors: string[];
}

function valid(d: Partial<Defaults> | null | undefined): d is Defaults {
  return !!d && d.v === 1 && !!d.operator?.relay && !!d.operator.blossom && !!d.operator.api;
}

export interface RelayRow {
  url: string;
  label: string;
  /** Kefli's own relay, the one this browser sends to, and the one a block in the browser stops. */
  operator: boolean;
}

const sameRelay = (a: string, b: string) => a.replace(/\/+$/, '').toLowerCase() === b.replace(/\/+$/, '').toLowerCase();

/**
 * Advanced's relays (F43): Kefli's own first, found by its address rather than its place, since a nostr user's list starts
 * with their own relays and leaves Kefli's out when Keep backup copies is off; it is shown either way, as the relay this
 * browser sends to. Then Kefli's backups, numbered, and the person's own as Your relay, as the phone's Advanced names
 * them (decision 113). Without the defaults, which pairing always fetches first, the list keeps its order.
 */
export function relayRows(written: string[], d: Defaults | null): RelayRow[] {
  if (!d) return written.map((url, i) => ({ url, label: i === 0 ? 'Kefli' : `Backup ${i}`, operator: i === 0 }));
  let n = 0;
  const others = written.filter((u) => !sameRelay(u, d.operator.relay));
  return [
    { url: written.find((u) => sameRelay(u, d.operator.relay)) ?? d.operator.relay, label: 'Kefli', operator: true },
    ...others.map((url) => ({ url, label: d.relays.some((r) => sameRelay(r, url)) ? `Backup ${++n}` : 'Your relay', operator: false })),
  ];
}

/** The fresh copy when it can be fetched, else the kept one; null only before the first fetch ever succeeds. */
export async function loadDefaults(store: Store, url: string, get: typeof fetch = fetch): Promise<Defaults | null> {
  try {
    const res = await get(url, { cache: 'no-store' });
    const d = res.ok ? ((await res.json()) as Defaults) : null;
    if (valid(d)) {
      await store.set(KEYS.defaults, d);
      return d;
    }
  } catch {
    // offline: the kept copy below
  }
  return (await store.get<Defaults>(KEYS.defaults)) ?? null;
}
