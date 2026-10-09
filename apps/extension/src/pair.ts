// Pairing from the browser's side (contract 4.4): an offer as a QR and a typed code, posted sealed to the operator, then
// a wait on the operator relay for the phone's pair-ack, which only the device key can open.
import { bytesToHex } from '@noble/hashes/utils.js';
import { Relay } from 'nostr-tools/relay';
import { httpAuth } from '../../../packages/protocol/src/nip98';
import {
  acceptPairAck, derivePairCode, newPairCode, sealOffer, type PairAck, type PairOffer,
} from '../../../packages/protocol/src/pairing';
import type { CryptoPort } from '../../../packages/protocol/src/ports';
import type { LocalSigner, NostrEvent } from '../../../packages/protocol/src/signer';
import { unwrap } from '../../../packages/protocol/src/wrap';
import type { Defaults } from './defaults';
import type { Pairing } from './store';

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
}

/** A fresh offer, posted sealed under its typed code with POST /pair-offers, signed by the device key (NIP-98). */
export async function postOffer(device: LocalSigner, defaults: Defaults, label: string, crypto: CryptoPort, now: number, get: typeof fetch = fetch): Promise<Offer> {
  const offer: PairOffer = { v: 1, device_pubkey: device.pubkey(), relay: defaults.operator.relay, nonce: bytesToHex(crypto.randomBytes(16)), expires: now + OFFER_LIFE, label };
  const code = newPairCode(crypto);
  const { lookup, key } = await derivePairCode(code, crypto);
  const url = `${defaults.operator.api}/pair-offers`;
  const body = JSON.stringify({ v: 1, lookup, offer: await sealOffer(offer, key, crypto) });
  const res = await get(url, { method: 'POST', body, headers: { Authorization: await httpAuth(device, url, 'POST', body, crypto), 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`pair-offers answered ${res.status}`);
  return { offer, code, qr: JSON.stringify(offer) };
}

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** The record kept once the phone has answered. */
export function pairingFrom(ack: PairAck, label: string, now: number): Pairing {
  return { v: 1, user_pubkey: ack.user_pubkey, write_relays: ack.write_relays, blossom_servers: ack.blossom_servers, token: ack.token, label, paired_at: now };
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
 * Waits on the operator relay for the pair-ack. Gift wraps are served only after NIP-42 AUTH by the key they name, so a
 * subscription the relay closes as auth-required authenticates and asks again. onTrouble fires when the relay can't
 * be reached, so the page can say so and try again.
 */
export async function listenForAck(relayUrl: string, device: LocalSigner, nonce: string, since: number, onAck: (ack: PairAck) => void, onTrouble: () => void): Promise<Listening> {
  const relay = await Relay.connect(relayUrl);
  const sign = (evt: Parameters<LocalSigner['signEvent']>[0]) => device.signEvent(evt) as never;
  relay.onauth = sign;
  relay.onclose = onTrouble;
  let stopped = false;
  const subscribe = () =>
    relay.subscribe([{ kinds: [1059], '#p': [device.pubkey()], since: since - 172_800 - 300 }], {
      onevent: (e) => void ackFor(device, e as NostrEvent, nonce).then((ack) => ack && !stopped && onAck(ack)),
      onclose: (reason) => {
        if (stopped || !reason.includes('auth-required')) return;
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
