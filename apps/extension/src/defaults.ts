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
