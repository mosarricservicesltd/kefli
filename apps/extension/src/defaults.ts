// The operator's defaults.json (contract 3.1), fetched from the flavour's address and kept, so a save made offline
// still knows the operator relay and Blossom server.
import { ANSWER_MAX_BYTES, capped, timed } from './save';
import { addresses, ADDRESS_MAX, KEYS, type Store } from './store';

export interface Defaults {
  v: 1;
  operator: { relay: string; blossom: string; api: string };
  relays: string[];
  mirrors: string[];
}

/**
 * How long the fetch may take before the kept copy stands in. Every save and every look for a move fetches it first,
 * so an operator that accepts the connection and never answers would otherwise hold every save before it is queued.
 */
export const DEFAULTS_TIMEOUT_MS = 10_000;
/** The most relays or mirrors a copy may list: the operator's lists hold two or three. */
export const DEFAULTS_LIST_MAX = 32;

const at = (u: unknown, scheme: RegExp) => typeof u === 'string' && u.length <= ADDRESS_MAX && scheme.test(u);
const WS = /^wss?:\/\//i;
const HTTP = /^https?:\/\//i;
const list = (l: unknown, scheme: RegExp) => Array.isArray(l) && l.length <= DEFAULTS_LIST_MAX && l.every((u) => at(u, scheme));

/**
 * A copy the extension can use, else the kept one stays (contract 3.1: the last copy that parsed). The shape is checked
 * whole, since storage.local keeps it and Advanced lists it: lists that aren't lists of addresses would break the
 * options page, and long ones would fill the storage the queue needs.
 */
function valid(d: Partial<Defaults> | null | undefined): d is Defaults {
  const o = d?.operator;
  return !!d && d.v === 1 && !!o && at(o.relay, WS) && at(o.blossom, HTTP) && at(o.api, HTTP) && list(d.relays, WS) && list(d.mirrors, HTTP);
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
export function relayRows(stored: string[], d: Defaults | null): RelayRow[] {
  // a pairing kept before its lists were checked (store.ts) may still hold anything
  const written = addresses(stored);
  if (!d) return written.map((url, i) => ({ url, label: i === 0 ? 'Kefli' : `Backup ${i}`, operator: i === 0 }));
  let n = 0;
  const others = written.filter((u) => !sameRelay(u, d.operator.relay));
  return [
    { url: written.find((u) => sameRelay(u, d.operator.relay)) ?? d.operator.relay, label: 'Kefli', operator: true },
    ...others.map((url) => ({ url, label: d.relays.some((r) => sameRelay(r, url)) ? `Backup ${++n}` : 'Your relay', operator: false })),
  ];
}

/**
 * The fresh copy when it can be fetched in time, else the kept one; null only before the first fetch ever succeeds.
 * An answer longer than the operator ever sends is refused as it is read, so it is never held whole.
 */
export async function loadDefaults(store: Store, url: string, get: typeof fetch = fetch, timeoutMs = DEFAULTS_TIMEOUT_MS): Promise<Defaults | null> {
  try {
    const res = await timed(timeoutMs, capped(ANSWER_MAX_BYTES, get))(url, { cache: 'no-store' });
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
