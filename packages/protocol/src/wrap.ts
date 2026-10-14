// NIP-59 gift wraps composed through Signer (mobile spec 3.4): the seal is signed and encrypted by the
// sender's Signer, the wrap by a fresh key made here. Used for browser save requests and pair-acks (C§4.4).

import { generateSecretKey, getEventHash } from 'nostr-tools/pure';
import { v2 as nip44 } from 'nostr-tools/nip44';
import { KIND, MAX_EVENT_BYTES } from './constants';
import { EventTooLargeError, signedSize } from './events';
import { isSignerFailure } from './remoteSigners';
import { conversationKey, nobleSecp, signEventWith, verifyEventWith } from './secp';
import type { SecpPort } from './secp';
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
  /** For the wrap's own key; defaults to noble. */
  secp?: SecpPort;
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
  const secp = opts.secp ?? nobleSecp;
  const wrapKey = generateSecretKey();
  const wrapTemplate: EventTemplate = {
    kind: KIND.giftWrap,
    created_at: backdated(now, random),
    tags: [['p', recipient]],
    content: nip44.encrypt(JSON.stringify(seal), conversationKey(secp, wrapKey, recipient)),
  };
  const bytes = signedSize(wrapTemplate);
  // The save request must be under its limit (C§4.4: under 8 KB); the ceiling may be reached (C§3.3).
  if (bytes > MAX_EVENT_BYTES) throw new EventTooLargeError(bytes);
  if (opts.maxBytes !== undefined && bytes >= opts.maxBytes) throw new EventTooLargeError(bytes, opts.maxBytes);
  const wrap = signEventWith(secp, wrapTemplate, wrapKey);
  return { wrap, wrapKey, wrapPubkey: wrap.pubkey, rumor };
}

export class UnwrapError extends Error {
  constructor(reason: string) {
    super(`not a valid gift wrap: ${reason}`);
    this.name = 'UnwrapError';
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** The fields NIP-01 gives every event, typed as it types them; a rumor shaped otherwise can't be hashed or read. */
function isRumorShape(r: unknown): r is Rumor {
  if (!isRecord(r) || !Array.isArray(r.tags)) return false;
  const typed = typeof r.id === 'string' && typeof r.pubkey === 'string' && typeof r.kind === 'number' && typeof r.created_at === 'number';
  return typed && typeof r.content === 'string' && r.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === 'string'));
}

/** verifyEventWith, false for an event it can't serialise (a field of the wrong type), which it would throw for. */
function verifies(secp: SecpPort, event: unknown): boolean {
  try {
    return isRecord(event) && verifyEventWith(secp, event as unknown as NostrEvent);
  } catch {
    return false;
  }
}

/**
 * Open a wrap addressed to recipient. Checks both signatures, the rumor's id, and that the rumor's author is the seal's
 * signer. Anyone can send a wrap, so whatever it holds that isn't a seal around a rumor of NIP-01's shape (null, a
 * number, an array, a tag that isn't strings) is an UnwrapError too, never a TypeError a caller would take for the
 * signer not answering and wait on.
 */
export async function unwrap(recipient: Signer, wrap: NostrEvent, secp: SecpPort = nobleSecp): Promise<{ rumor: Rumor; seal: NostrEvent }> {
  if (wrap.kind !== KIND.giftWrap) throw new UnwrapError('not kind 1059');
  if (!verifies(secp, wrap)) throw new UnwrapError('wrap signature');
  let seal: NostrEvent;
  let rumor: unknown;
  // a signer that couldn't answer (out of sight, timed out, declined) says nothing about the wrap: its error goes
  // through as it is, so the caller can wait and ask again rather than file the wrap as not ours (F3)
  try {
    seal = JSON.parse(await recipient.nip44Decrypt(wrap.pubkey, wrap.content));
  } catch (e) {
    if (isSignerFailure(e)) throw e;
    throw new UnwrapError('wrap does not decrypt');
  }
  if (!isRecord(seal) || seal.kind !== KIND.seal || !verifies(secp, seal)) throw new UnwrapError('seal');
  try {
    rumor = JSON.parse(await recipient.nip44Decrypt(seal.pubkey, seal.content));
  } catch (e) {
    if (isSignerFailure(e)) throw e;
    throw new UnwrapError('seal does not decrypt');
  }
  if (!isRumorShape(rumor)) throw new UnwrapError('rumor');
  if (rumor.pubkey !== seal.pubkey) throw new UnwrapError('rumor author is not the seal signer');
  if (!hashes(rumor)) throw new UnwrapError('rumor id');
  return { rumor, seal };
}

function hashes(rumor: Rumor): boolean {
  try {
    return getEventHash(rumor) === rumor.id;
  } catch {
    return false;
  }
}

const PROBE = 'kefli-wrap-probe';

/**
 * Whether the recipient's signer opens a wrap's outer layer now: a ciphertext made here to its key from a fresh one,
 * as any wrap is, which it is asked to decrypt. After a wrap the signer didn't open (it timed out, or declined out of
 * sight), this tells a signer that isn't answering, whose other wraps would fail the same way, from one that only
 * won't open that wrap, which anyone can send to look like a signer that isn't answering.
 */
export async function opensWraps(recipient: Signer, pubkey = recipient.pubkey(), secp: SecpPort = nobleSecp): Promise<boolean> {
  const key = generateSecretKey();
  const content = nip44.encrypt(PROBE, conversationKey(secp, key, pubkey));
  try {
    return (await recipient.nip44Decrypt(secp.publicKey(key), content)) === PROBE;
  } catch {
    return false;
  }
}
