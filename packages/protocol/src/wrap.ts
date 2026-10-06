// NIP-59 gift wraps composed through Signer (mobile spec 3.4): the seal is signed and encrypted by the
// sender's Signer, the wrap by a fresh key made here. Used for browser save requests and pair-acks (C§4.4).

import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { KIND, MAX_EVENT_BYTES } from './constants';
import { EventTooLargeError, signedSize } from './events';
import type { EventTemplate, NostrEvent, Signer } from './signer';

/** A rumor: an event with an id but no signature, so it can't be shown to anyone as signed (NIP-59). */
export interface Rumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

/** NIP-59 lets seal and wrap times lie up to two days in the past, so they say nothing about when it was sent. */
export const WRAP_BACKDATE_MAX = 172_800;

function backdated(now: number, random: (n: number) => Uint8Array): number {
  const r = random(4);
  const n = ((r[0] << 24) | (r[1] << 16) | (r[2] << 8) | r[3]) >>> 0;
  return now - (n % WRAP_BACKDATE_MAX);
}

export function makeRumor(pubkey: string, t: EventTemplate): Rumor {
  const r = { pubkey, created_at: t.created_at, kind: t.kind, tags: t.tags, content: t.content };
  return { ...r, id: getEventHash(r) };
}

export interface WrapOptions {
  now?: number;
  /** Random bytes for the backdating; defaults to globalThis.crypto. */
  random?: (n: number) => Uint8Array;
  /** Refuse wraps of this many bytes or more (the save request's 8 KB, C§4.4); the 16 KB ceiling always applies. */
  maxBytes?: number;
}

/**
 * Wrap a rumor for recipient: seal (kind 13) signed by sender, wrap (kind 1059) signed by a fresh key.
 * Returns the wrap and its key, which the extension keeps to Undo with a kind 5 (C§4.4).
 */
export async function giftWrap(sender: Signer, recipient: string, template: EventTemplate, opts: WrapOptions = {}) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const random = opts.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const rumor = makeRumor(sender.pubkey(), template);
  const seal = await sender.signEvent({
    kind: KIND.seal,
    created_at: backdated(now, random),
    tags: [],
    content: await sender.nip44Encrypt(recipient, JSON.stringify(rumor)),
  });
  const wrapKey = generateSecretKey();
  const wrapTemplate: EventTemplate = {
    kind: KIND.giftWrap,
    created_at: backdated(now, random),
    tags: [['p', recipient]],
    content: nip44.encrypt(JSON.stringify(seal), nip44.utils.getConversationKey(wrapKey, recipient)),
  };
  const bytes = signedSize(wrapTemplate);
  // The save request must be under its limit (C§4.4: under 8 KB); the ceiling may be reached (C§3.3).
  if (bytes > MAX_EVENT_BYTES || (opts.maxBytes !== undefined && bytes >= opts.maxBytes)) throw new EventTooLargeError(bytes);
  return { wrap: finalizeEvent(wrapTemplate, wrapKey), wrapKey, wrapPubkey: getPublicKey(wrapKey), rumor };
}

export class UnwrapError extends Error {
  constructor(reason: string) {
    super(`not a valid gift wrap: ${reason}`);
    this.name = 'UnwrapError';
  }
}

/** Open a wrap addressed to recipient. Checks both signatures, the rumor's id, and that the rumor's author is the seal's signer. */
export async function unwrap(recipient: Signer, wrap: NostrEvent): Promise<{ rumor: Rumor; seal: NostrEvent }> {
  if (wrap.kind !== KIND.giftWrap) throw new UnwrapError('not kind 1059');
  if (!verifyEvent(wrap)) throw new UnwrapError('wrap signature');
  let seal: NostrEvent;
  let rumor: Rumor;
  try {
    seal = JSON.parse(await recipient.nip44Decrypt(wrap.pubkey, wrap.content));
  } catch {
    throw new UnwrapError('wrap does not decrypt');
  }
  if (seal.kind !== KIND.seal || !verifyEvent(seal)) throw new UnwrapError('seal');
  try {
    rumor = JSON.parse(await recipient.nip44Decrypt(seal.pubkey, seal.content));
  } catch {
    throw new UnwrapError('seal does not decrypt');
  }
  if (rumor.pubkey !== seal.pubkey) throw new UnwrapError('rumor author is not the seal signer');
  if (getEventHash(rumor) !== rumor.id) throw new UnwrapError('rumor id');
  return { rumor, seal };
}
