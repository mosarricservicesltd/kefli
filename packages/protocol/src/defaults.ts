// The operator's defaults.json (C§3.1): its shape, so the phone and the extension refuse the same copies and keep the
// last one that parsed, or the one baked into the build, instead.

export type Defaults = {
  v: 1;
  operator: { relay: string; blossom: string; api: string };
  relays: string[];
  indexer: string[];
  mirrors: string[];
};

const WS = /^wss?:\/\//;
const HTTP = /^https?:\/\//;

const at = (x: unknown, scheme: RegExp): x is string => typeof x === 'string' && scheme.test(x);
const list = (xs: unknown, min: number, scheme: RegExp): xs is string[] =>
  Array.isArray(xs) && xs.length >= min && xs.every((x) => at(x, scheme));

/**
 * Whether operator.api is a base every API path can be joined to with a slash (C§6): an http(s) address ending
 * without one. Written with a slash at its end, the API answered every call's doubled slash with a redirect, which a
 * client reads as the API not answering, so register, the browsers' calls, GET /account, Connect and pairing a phone
 * all failed quietly; a copy with one is refused instead (flow decision 119).
 */
export function apiBaseOk(api: unknown): api is string {
  return at(api, HTTP) && !api.endsWith('/');
}

/**
 * A defaults.json as C§3.1 describes it: v 1, the operator's relay over ws(s) and its blob server and API over
 * http(s), relays at least two, indexer and mirrors at least one each, and operator.api with no trailing slash.
 */
export function validDefaults(d: unknown): d is Defaults {
  const x = d as Partial<Defaults> | null | undefined;
  const o = x?.operator;
  return !!x && x.v === 1 && !!o && at(o.relay, WS) && at(o.blossom, HTTP) && apiBaseOk(o.api)
    && list(x.relays, 2, WS) && list(x.indexer, 1, WS) && list(x.mirrors, 1, HTTP);
}
