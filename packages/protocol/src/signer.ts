// The signer interface (contract section 2, mobile spec 3.4) and the local key's implementation.
// Every seal, self-encryption, unwrap and NIP-42 AUTH goes through Signer.

import { getEventHash, type Event as NostrEvent, type EventTemplate } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { conversationKey, nobleSecp, signEventWith } from './secp';
import type { SecpPort } from './secp';

export type { NostrEvent, EventTemplate };

export interface Signer {
  /** Hex, x-only. */
  pubkey(): string;
  capabilities(): Promise<{ nip44: boolean }>;
  signEvent(e: EventTemplate): Promise<NostrEvent>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
}

/** Kefli's own extension of the contract interface. */
export interface SignerProvider extends Signer {
  kind: 'local' | 'nip55' | 'nip46';
  /** Gates inbox drains (mobile spec 4.7). */
  canActInBackground(): Promise<boolean>;
}

/** The local key. Caches the self-encryption conversation key; zero() wipes the secret and the cache. */
export class LocalSigner implements SignerProvider {
  readonly kind = 'local' as const;
  readonly #sk: Uint8Array;
  readonly #pk: string;
  #selfKey: Uint8Array | null = null;
  #zeroed = false;

  readonly #secp: SecpPort;

  /** secp defaults to noble; the phone passes kefli-secp. */
  constructor(secretKey: Uint8Array, secp: SecpPort = nobleSecp) {
    if (secretKey.length !== 32) throw new RangeError('a secret key is 32 bytes');
    this.#sk = secretKey;
    this.#secp = secp;
    this.#pk = secp.publicKey(secretKey);
  }

  pubkey(): string {
    return this.#pk;
  }

  async capabilities() {
    return { nip44: true };
  }

  async canActInBackground() {
    return true;
  }

  async signEvent(e: EventTemplate): Promise<NostrEvent> {
    return signEventWith(this.#secp, e, this.#secret());
  }

  async nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return nip44.encrypt(plaintext, this.#conversationKey(peer));
  }

  async nip44Decrypt(peer: string, ciphertext: string): Promise<string> {
    return nip44.decrypt(ciphertext, this.#conversationKey(peer));
  }

  zero(): void {
    this.#sk.fill(0);
    this.#selfKey?.fill(0);
    this.#selfKey = null;
    this.#zeroed = true;
  }

  #secret(): Uint8Array {
    if (this.#zeroed) throw new Error('this signer has been zeroed');
    return this.#sk;
  }

  #conversationKey(peer: string): Uint8Array {
    if (peer !== this.#pk) return conversationKey(this.#secp, this.#secret(), peer);
    this.#selfKey ??= conversationKey(this.#secp, this.#secret(), this.#pk);
    return this.#selfKey;
  }
}

/** How long the phone keeps its own key in memory once in the background (mobile spec 3.4). */
export const BACKGROUND_ZERO_MS = 5 * 60_000;

/**
 * The phone's current signer (mobile spec 3.4, 7.1). A local key the slot lets go of is zeroed: when another signer
 * takes its place, when it is dropped (Sign out, Delete my data, the end of a move), and after five minutes in the
 * background, checked again on return in case the timer was held up. The next caller builds a fresh one from the
 * key file. A signer app or a bunker holds no secret of the user's here, so the background leaves it in place.
 */
export class SignerSlot {
  #signer: SignerProvider | null = null;
  #away: number | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly idleMs = BACKGROUND_ZERO_MS) {}

  get(): SignerProvider | null {
    return this.#signer;
  }

  set(s: SignerProvider | null): void {
    if (this.#signer !== s && this.#signer instanceof LocalSigner) this.#signer.zero();
    this.#signer = s;
  }

  /** The app left the foreground at now (ms). */
  background(now = Date.now()): void {
    if (this.#away !== null) return;
    this.#away = now;
    this.#timer = setTimeout(() => this.#idle(), this.idleMs);
  }

  /** The app is back in front at now (ms). */
  foreground(now = Date.now()): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#away !== null && now - this.#away >= this.idleMs) this.#idle();
    this.#away = null;
  }

  #idle(): void {
    if (this.#signer instanceof LocalSigner) this.set(null);
  }
}

/**
 * Whether a signer app's answer is the event it was asked to sign: the same kind, time, tags and content under the
 * asked key, an id that is the event's hash, and a signature verify accepts. Without the check, whatever answers
 * for the signer could hand back an event of its own making.
 */
export function signedAsAsked(
  asked: EventTemplate & { pubkey: string }, e: NostrEvent, verify: (sig: string, id: string, pubkey: string) => boolean,
): boolean {
  if (typeof e !== 'object' || e === null || typeof e.id !== 'string' || typeof e.sig !== 'string') return false;
  if (e.pubkey !== asked.pubkey || e.kind !== asked.kind || e.created_at !== asked.created_at || e.content !== asked.content) return false;
  if (JSON.stringify(e.tags) !== JSON.stringify(asked.tags)) return false;
  if (!/^[0-9a-f]{64}$/.test(e.id) || !/^[0-9a-f]{128}$/.test(e.sig)) return false;
  return getEventHash(e) === e.id && verify(e.sig, e.id, e.pubkey);
}
