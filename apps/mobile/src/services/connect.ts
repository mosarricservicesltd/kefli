// Connect a browser (mobile spec 5.5, contract 4.4): a scanned QR or a typed code becomes a checked offer, and
// Connect queues post_device then pair_ack and runs the outbox while the button is busy. Any failed attempt is
// Can't connect, and the queued rows are withdrawn, so a browser never connects later behind the person's back.
// An offer counts only with the device key's proof over its nonce (C§4.4), which post_device forwards to the API;
// one without it, as from an extension before contract v1.11, reads as a wrong code. Ports keep it testable.
import { bytesToHex } from '@noble/hashes/utils.js';
import { checkOffer, derivePairCode, httpAuth, openOffer, readPairCode, type CryptoPort, type PairOffer, type SecpPort, type Signer } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { cancelConnect, connectState, queueConnect } from '../data/devices';
import { registerFirst } from '../data/saves';
import { SERVER_TIMEOUT_MS, serverFetch, serverHops } from '../net/http';

export type ConnectPorts = {
  db: SqlDb;
  now: () => number;
  owner: string;
  defaults: () => Promise<{ operator: { relay: string; blossom: string; api: string }; mirrors: string[] }>;
  signer: () => Promise<Signer | null>;
  fetch: typeof fetch;
  crypto: CryptoPort;
  runOutbox: () => Promise<unknown>;
  /** BIP-340 verify for the offer's proof; the phone passes its native one, the tests noble's. */
  verify?: SecpPort['verify'];
  /** The local stack's build (services/config.ts LOCAL_STACK), whose API a redirect may reach on loopback. */
  localStack?: boolean;
};

/**
 * The fetch for Kefli's API from these ports (net/http serverFetch): each redirect followed a hop at a time, never into
 * the phone's own network (on the local stack, loopback too), and the whole answer had within the API's 15 s; one that
 * goes past either reads as the API not answering. Left to OkHttp, a redirect handed the lookup and its NIP-98 header
 * to whatever answered at 192.168.1.1, and an API that never answered held Connect, or a phone's pairing, for good.
 */
export function apiFetch(p: Pick<ConnectPorts, 'fetch' | 'localStack'>): typeof fetch {
  return serverFetch(p.fetch, { hops: serverHops(p.localStack === true), timeoutMs: SERVER_TIMEOUT_MS });
}

type Operator = { relay: string; api: string };

export type OfferResult = { offer: PairOffer } | { problem: 'expired' | 'wrong' | 'offline' };

/** A checked offer, or why not: an expired one has its own state; anything else unusable reads as a wrong code. */
export function checked(o: Partial<PairOffer> | null, operator: Operator, now: number, verify?: SecpPort['verify']): OfferResult {
  const problem = checkOffer(o, operator, now, verify);
  if (problem === 'expired') return { problem: 'expired' };
  return problem ? { problem: 'wrong' } : { offer: o as PairOffer };
}

/** A QR's text, read as an offer (C§4.4). */
export function readScan(raw: string, operator: Operator, now: number, verify?: SecpPort['verify']): OfferResult {
  let o: Partial<PairOffer> | null;
  try {
    o = JSON.parse(raw);
  } catch {
    o = null;
  }
  return checked(o && typeof o === 'object' ? o : null, operator, now, verify);
}

const targetsOf = (d: Awaited<ReturnType<ConnectPorts['defaults']>>) => ({ api: d.operator.api, blossom: d.operator.blossom, mirror: d.mirrors[0] });

/** A still-queued register runs first (5.5): GET /pair-offers needs a registered user. */
export async function registered(p: Pick<ConnectPorts, 'db' | 'now' | 'owner' | 'defaults' | 'runOutbox'>): Promise<boolean> {
  const is = () => !!p.db.get<{ registered_at: number | null }>('SELECT registered_at FROM identities WHERE pubkey = ?', p.owner)?.registered_at;
  if (is()) return true;
  registerFirst(p.db, p.now(), p.owner, targetsOf(await p.defaults()));
  await p.runOutbox().catch(() => 0);
  return is();
}

/** A typed code (C§4.4): read leniently, stretched, fetched, opened and checked as a QR. */
export async function lookupCode(p: ConnectPorts, typed: string): Promise<OfferResult> {
  const code = readPairCode(typed);
  if (!code) return { problem: 'wrong' };
  const [d, signer] = await Promise.all([p.defaults(), p.signer()]);
  if (!signer || !(await registered(p))) return { problem: 'offline' };
  const { lookup, key } = await derivePairCode(code, p.crypto);
  const url = `${d.operator.api}/pair-offers/${lookup}`;
  let res: Response;
  try {
    res = await apiFetch(p)(url, { method: 'GET', headers: { Authorization: await httpAuth(signer, url, 'GET', null, p.crypto) } });
  } catch {
    return { problem: 'offline' };
  }
  if (res.status === 404) return { problem: 'wrong' };
  if (!res.ok) return { problem: 'offline' };
  const body = (await res.json().catch(() => null)) as { offer?: unknown } | null;
  const offer = typeof body?.offer === 'string' ? await openOffer(body.offer, key, p.crypto) : null;
  return checked(offer, d.operator, p.now(), p.verify);
}

/** Connect (5.5): resolves once the pair-ack is taken, or as soon as anything fails. */
export async function connectBrowser(p: ConnectPorts, offer: PairOffer): Promise<'connected' | 'failed'> {
  const d = await p.defaults();
  const token = bytesToHex(p.crypto.randomBytes(32));
  const pair = { device_pubkey: offer.device_pubkey, label: offer.label.trim(), nonce: offer.nonce, token, relay: offer.relay };
  const proof = { nonce: offer.nonce, ...offer.proof };
  const rows = p.db.tx(() => queueConnect(p.db, p.now(), p.owner, d.operator.api, pair, proof, registerFirst(p.db, p.now(), p.owner, targetsOf(d))));
  // A run already going when the rows were queued may end before reaching them, so up to three runs.
  for (let i = 0; 3 > i; i++) {
    await p.runOutbox().catch(() => 0);
    const state = connectState(p.db, p.owner, token, rows);
    if (state === 'connected') return 'connected';
    if (state === 'failed') break;
  }
  cancelConnect(p.db, p.now(), p.owner, d.operator.api, rows, pair.device_pubkey);
  return 'failed';
}
