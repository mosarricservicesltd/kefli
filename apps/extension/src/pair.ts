// Pairing from the browser's side (contract 4.4): an offer as a QR and a typed code, posted sealed to the operator, then
// a wait on the operator relay for the phone's pair-ack, which only the device key can open.
import { bytesToHex } from '@noble/hashes/utils.js';
import { Relay } from 'nostr-tools/relay';
import { httpAuth } from '../../../packages/protocol/src/nip98';
import {
  acceptPairAck, derivePairCode, deviceProofTemplate, newPairCode, sealOffer, signStatement, type PairAck, type PairOffer,
} from '../../../packages/protocol/src/pairing';
import type { CryptoPort } from '../../../packages/protocol/src/ports';
import type { LocalSigner, NostrEvent } from '../../../packages/protocol/src/signer';
import { unwrap } from '../../../packages/protocol/src/wrap';
import type { Defaults } from './defaults';
import { ANSWER_MAX_BYTES, capped, timed } from './save';
import { addresses, type Pairing } from './store';

/** An offer lives five minutes (contract 4.4). */
export const OFFER_LIFE = 300;

const BRANDS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'], [/OPR\/|Opera/, 'Opera'], [/Vivaldi/, 'Vivaldi'], [/Firefox\//, 'Firefox'], [/Chrome\//, 'Chrome'],
];
const PLATFORMS: [RegExp, string][] = [
  [/Mac OS X|Macintosh/, 'a Mac'], [/Windows/, 'a Windows PC'], [/CrOS/, 'a Chromebook'], [/Linux/, 'a Linux PC'],
];

/**
 * How the phone names this browser: brand and platform, never a hostname or user name (contract 4.4). Brave says it is
 * Brave only through userAgentData; Firefox has none, so the user agent string stands in (mockup build notes).
 */
export function browserLabel(ua: string, uaBrands: string[] = []): string {
  const brand = uaBrands.includes('Brave') ? 'Brave' : BRANDS.find(([re]) => re.test(ua))?.[1] ?? 'This browser';
  const platform = PLATFORMS.find(([re]) => re.test(ua))?.[1] ?? 'a computer';
  return `${brand} on ${platform}`;
}

export interface Offer {
  offer: PairOffer;
  /** The typed code, eight characters, shown as XXXX-XXXX. */
  code: string;
  /** What the QR carries: the offer's JSON. */
  qr: string;
  /** Whether the operator has it yet. */
  posted: boolean;
}

/**
 * A fresh offer, made here and not yet posted. It carries the device key's proof over its nonce (contract 4.4), which
 * the phone forwards in POST /devices, so the operator authorises this key only for a phone that has this offer.
 */
export async function newOffer(device: LocalSigner, defaults: Defaults, label: string, crypto: CryptoPort, now: number): Promise<Offer> {
  const nonce = bytesToHex(crypto.randomBytes(16));
  const proof = await signStatement(device, deviceProofTemplate(defaults.operator.api, nonce, now));
  const offer: PairOffer = { v: 1, device_pubkey: device.pubkey(), relay: defaults.operator.relay, nonce, expires: now + OFFER_LIFE, label, proof };
  return { offer, code: newPairCode(crypto), qr: JSON.stringify(offer), posted: false };
}

/**
 * How long POST /pair-offers may take: past it the page shows it can't connect and tries again, as it does when the
 * post fails, rather than staying blank with no code for as long as the operator holds the request.
 */
export const OFFER_POST_TIMEOUT_MS = 15_000;

/** Posts the offer sealed under its typed code with POST /pair-offers, signed by the device key (NIP-98). */
export async function postOffer(device: LocalSigner, defaults: Defaults, o: Offer, crypto: CryptoPort, get: typeof fetch = fetch, timeoutMs = OFFER_POST_TIMEOUT_MS): Promise<void> {
  const { lookup, key } = await derivePairCode(o.code, crypto);
  const url = `${defaults.operator.api}/pair-offers`;
  const body = JSON.stringify({ v: 1, lookup, offer: await sealOffer(o.offer, key, crypto) });
  const post = timed(timeoutMs, capped(ANSWER_MAX_BYTES, get));
  const res = await post(url, { method: 'POST', body, headers: { Authorization: await httpAuth(device, url, 'POST', body, crypto), 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`pair-offers answered ${res.status}`);
  o.posted = true;
}

/** An offer with less than this left isn't shown again after trouble; a new one is made. */
export const OFFER_REUSE_MIN = 60;

/**
 * One try at showing a code (F42): the offer from the last try while it has a minute or more left, else a new one; the
 * wait on the relay first, and the offer posted only once that is up, and only once. A page that can't reach the relay
 * then tries again every ten seconds without posting anything, so it can't use up the operator's 30 offers an hour.
 * Resolves with the offer to show and the wait; rejects on trouble, with the offer kept in `last` for the next try.
 */
export async function tryPairing(
  last: { offer: Offer | null },
  make: () => Promise<Offer>,
  listen: (o: Offer) => Promise<Listening>,
  post: (o: Offer) => Promise<void>,
  now: number,
): Promise<{ offer: Offer; listening: Listening }> {
  if (!last.offer || last.offer.offer.expires - now < OFFER_REUSE_MIN) last.offer = await make();
  const offer = last.offer;
  const listening = await listen(offer);
  try {
    if (!offer.posted) await post(offer);
  } catch (e) {
    listening.stop();
    throw e;
  }
  return { offer, listening };
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The record kept once the phone has answered, its lists as the extension keeps them (store.ts addresses). */
export function pairingFrom(ack: PairAck, label: string, now: number): Pairing {
  return { v: 1, user_pubkey: ack.user_pubkey, write_relays: addresses(ack.write_relays), blossom_servers: addresses(ack.blossom_servers), token: String(ack.token), label, paired_at: now };
}

/** An opened wrap that is this offer's pair-ack, or null for anything else on the p tag. */
export async function ackFor(device: LocalSigner, wrap: NostrEvent, nonce: string): Promise<PairAck | null> {
  try {
    const { rumor, seal } = await unwrap(device, wrap);
    const v = acceptPairAck(rumor, seal, { offerNonce: nonce, pairedUser: null });
    return v.ok ? v.ack : null;
  } catch {
    return null;
  }
}

export interface Listening {
  stop(): void;
}

/**
 * How long the page waits for the operator relay to open: a relay that takes the connection and never opens it left the
 * page blank, with no code and no line saying it can't connect, for as long as it held on.
 */
export const LISTEN_CONNECT_MS = 10_000;

/**
 * Waits on the operator relay for the pair-ack. Gift wraps are served only after NIP-42 AUTH by the key they name, so a
 * subscription the relay closes as auth-required authenticates and asks again. onTrouble fires when the relay can't
 * be reached, so the page can say so and try again.
 */
export async function listenForAck(relayUrl: string, device: LocalSigner, nonce: string, since: number, onAck: (ack: PairAck) => void, onTrouble: () => void, connectMs = LISTEN_CONNECT_MS): Promise<Listening> {
  const relay = await Relay.connect(relayUrl, { timeout: connectMs });
  const sign = (evt: Parameters<LocalSigner['signEvent']>[0]) => device.signEvent(evt) as never;
  relay.onauth = sign;
  relay.onclose = onTrouble;
  let stopped = false;
  const subscribe = () =>
    relay.subscribe([{ kinds: [1059], '#p': [device.pubkey()], since: since - 172_800 - 300 }], {
      onevent: (e) => void ackFor(device, e as NostrEvent, nonce).then((ack) => ack && !stopped && onAck(ack)),
      onclose: (reason) => {
        // a relay's CLOSED may carry anything as its reason
        if (stopped || !String(reason).includes('auth-required')) return;
        relay.auth(sign).then(subscribe, onTrouble);
      },
    });
  subscribe();
  return {
    stop() {
      stopped = true;
      relay.onclose = null;
      relay.close();
    },
  };
}
