// The signer interface (contract section 2, mobile spec 3.4) and the local key's implementation.
// Every seal, self-encryption, unwrap and NIP-42 AUTH goes through Signer.

import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import type { Event as NostrEvent, EventTemplate } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';

export type { NostrEvent, EventTemplate };

export interface Signer {
  /** Hex, x-only. */
  pubkey(): string;
  capabilities(): Promise<{ nip44: boolean }>;
  signEvent(e: EventTemplate): Promise<NostrEvent>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
}

/** Shelf's own extension of the contract interface. */
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

  constructor(secretKey: Uint8Array) {
    if (secretKey.length !== 32) throw new RangeError('a secret key is 32 bytes');
    this.#sk = secretKey;
    this.#pk = getPublicKey(secretKey);
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
    return finalizeEvent(e, this.#secret());
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
    if (peer !== this.#pk) return nip44.utils.getConversationKey(this.#secret(), peer);
    this.#selfKey ??= nip44.utils.getConversationKey(this.#secret(), this.#pk);
    return this.#selfKey;
  }
}
