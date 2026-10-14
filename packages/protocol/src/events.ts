// Building and reading kind 30078 saves (contract 4.1) and the size ceiling every event obeys (3.3).

import { utf8ToBytes } from '@noble/hashes/utils.js';
import { ITEM_D_PREFIX, ITEM_TARGET_BYTES, KIND, MAX_EVENT_BYTES, T_TAG } from './constants';
import { isItemD, savedD } from './normalise';
import { parseItem, serialiseItem } from './item';
import type { ParsedItem } from './item';
import type { EventTemplate, NostrEvent, Signer } from './signer';

/**
 * An event over the limit that applied: the 16 KB ceiling every event keeps to (C§3.3), which may be reached, or a
 * tighter one such as a save request's 8 KB (C§4.4), which must be stayed under. limit names it.
 */
export class EventTooLargeError extends Error {
  constructor(readonly bytes: number, readonly limit: number = MAX_EVENT_BYTES) {
    super(limit === MAX_EVENT_BYTES
      ? `event would be ${bytes} bytes serialised, over the ${MAX_EVENT_BYTES}-byte ceiling`
      : `event would be ${bytes} bytes serialised, not under the ${limit}-byte limit`);
    this.name = 'EventTooLargeError';
  }
}

/** Bytes of the signed event as a relay receives it. id, pubkey and sig have fixed lengths, so this is exact before signing. */
export function signedSize(template: EventTemplate): number {
  const placeholder = { ...template, id: '0'.repeat(64), pubkey: '0'.repeat(64), sig: '0'.repeat(128) };
  return utf8ToBytes(JSON.stringify(placeholder)).length;
}

/** Signs only events within the ceiling, so nothing over 16 KB is ever signed or sent. */
export async function signWithinCeiling(signer: Signer, template: EventTemplate): Promise<NostrEvent> {
  const bytes = signedSize(template);
  if (bytes > MAX_EVENT_BYTES) throw new EventTooLargeError(bytes);
  return signer.signEvent(template);
}

export interface BuiltItem {
  event: NostrEvent;
  /** True above the 4 KB target for an item (C§4.1): published, but worth a warning. */
  overTarget: boolean;
}

/**
 * The kind 30078 for a save. hash is the save's own (fixed at first publish), not recomputed from the item's url, and
 * rides inside the encrypted item (C§4.1). With the library key its d is keyed (savedD, C§4.3, F5); without one it is
 * the unkeyed kefli/item/<hash> of saves before v1.10, which tests and fixtures still build. createdAt is the outbox's
 * max(now, last created_at + 1) (mobile spec 4.3).
 */
export async function buildItemEvent(signer: Signer, hash: string, item: ParsedItem, createdAt: number, key?: Uint8Array): Promise<BuiltItem> {
  if (!isItemD(ITEM_D_PREFIX + hash)) throw new Error('hash is not 64 lowercase hex characters');
  const d = key ? savedD(key, hash) : ITEM_D_PREFIX + hash;
  const content = await signer.nip44Encrypt(signer.pubkey(), serialiseItem({ item: { ...item.item, hash }, extra: item.extra }));
  const template: EventTemplate = { kind: KIND.appData, created_at: createdAt, tags: [['d', d], ['t', T_TAG]], content };
  const event = await signWithinCeiling(signer, template);
  return { event, overTarget: signedSize(template) > ITEM_TARGET_BYTES };
}

/**
 * The hash, address and decrypted item of a save event. The hash is the one the item carries (C§4.1); a save from
 * before v1.10 has none, and its unkeyed d is its hash. Throws for anything that isn't the signer's own save.
 * Takes verified events only: the relay pool's verifier checks signatures before this runs (mobile spec 4.4).
 */
export async function readItemEvent(signer: Signer, event: NostrEvent): Promise<{ hash: string; d: string; item: ParsedItem }> {
  if (event.kind !== KIND.appData) throw new Error('not kind 30078');
  if (event.pubkey !== signer.pubkey()) throw new Error('not this identity’s save');
  const d = event.tags.find((t) => t[0] === 'd')?.[1] ?? '';
  if (!isItemD(d)) throw new Error('not a save');
  if (!event.tags.some((t) => t[0] === 't' && t[1] === T_TAG)) throw new Error(`no t tag ${T_TAG}`);
  const item = parseItem(await signer.nip44Decrypt(signer.pubkey(), event.content));
  const carried = item.item.hash;
  const hash = typeof carried === 'string' && isItemD(ITEM_D_PREFIX + carried) ? carried : d.slice(ITEM_D_PREFIX.length);
  return { hash, d, item };
}
