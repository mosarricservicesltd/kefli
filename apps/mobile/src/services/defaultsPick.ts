// Which defaults.json to use (contract 3.1, F1), without the platform, so it runs in tests: fetched at each start
// and at least once a day, the last copy that parsed kept, and otherwise the copy baked into the build, so restore,
// sync and sending all go on with the operator's API unreachable (contract 8). A fetch is tried at most every five
// minutes after one fails, and gives up after ten seconds.
import { ANSWER_MAX_BYTES, serverFetch, serverHops } from '../net/http';

export type Defaults = {
  v: 1;
  operator: { relay: string; blossom: string; api: string };
  relays: string[];
  indexer: string[];
  mirrors: string[];
};

const DAY = 86_400_000;
const RETRY = 300_000;
const TIMEOUT = 10_000;

const strings = (xs: unknown, min: number) => Array.isArray(xs) && xs.length >= min && xs.every((x) => typeof x === 'string' && x.length > 0);

/** A defaults.json as contract 3.1 describes it: relays at least two, indexer and mirrors at least one. */
export function validDefaults(d: unknown): d is Defaults {
  const x = d as Partial<Defaults> | null;
  return !!x && x.v === 1 && !!x.operator?.relay && !!x.operator.blossom && !!x.operator.api
    && strings(x.relays, 2) && strings(x.indexer, 1) && strings(x.mirrors, 1);
}

export type DefaultsPorts = {
  url: string;
  baked: Defaults | null;
  fetch: typeof fetch;
  read: () => string | null;
  write: (json: string) => void;
  now: () => number;
  /** The local stack's build (services/config.ts LOCAL_STACK), whose API a redirect of defaults.json may reach on loopback. */
  localStack?: boolean;
};

export type DefaultsState = { fresh: Defaults | null; fetchedAt: number; failedAt: number; inflight: Promise<Defaults | null> | null };
export const freshState = (): DefaultsState => ({ fresh: null, fetchedAt: 0, failedAt: -Infinity, inflight: null });

/**
 * A fresh copy, or null. Asked as a blob server is (net/http serverFetch): no cookies, each redirect followed by hand
 * and never into the phone's own network (on the local stack, loopback too), ten seconds over the headers and the
 * whole body, raced as well as signalled, and at most an answer's cap of it read, as the extension reads its copy (its
 * defaults.ts). Asked with the platform's fetch, as it was, it went with the cookies of the jar the WebViews share, its
 * redirects were followed wherever OkHttp went, the phone's own network included, and its body was read whole, whatever
 * its size, before it was checked.
 */
async function fetchDefaults(p: DefaultsPorts): Promise<Defaults | null> {
  if (!p.url) return null;
  try {
    const get = serverFetch(p.fetch, { hops: serverHops(p.localStack === true), timeoutMs: TIMEOUT, maxBytes: ANSWER_MAX_BYTES });
    const res = await get(p.url, { method: 'GET' });
    const d: unknown = res.ok ? await res.json() : null;
    return validDefaults(d) ? d : null;
  } catch {
    return null;
  }
}

function kept(p: DefaultsPorts): Defaults | null {
  try {
    const d: unknown = JSON.parse(p.read() ?? 'null');
    return validDefaults(d) ? d : null;
  } catch {
    return null;
  }
}

/** The defaults to use now: a fresh copy when one is due and answers, else the kept copy, else the baked one. */
export async function pickDefaults(p: DefaultsPorts, s: DefaultsState): Promise<Defaults> {
  const now = p.now();
  const due = !s.fresh || now - s.fetchedAt >= DAY;
  if (due && now - s.failedAt >= RETRY) {
    s.inflight ??= fetchDefaults(p).finally(() => { s.inflight = null; });
    const d = await s.inflight;
    if (d) {
      s.fresh = d;
      s.fetchedAt = now;
      p.write(JSON.stringify(d));
    } else {
      s.failedAt = now;
    }
  }
  const d = s.fresh ?? kept(p) ?? p.baked;
  if (!d) throw new Error('no defaults: none fetched, kept or baked into this build');
  return d;
}
