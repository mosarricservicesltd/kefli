// NIP-09 deletions: saves (contract 4.1) and a consumed wrap (4.4).

import { KIND, MAX_DELETIONS_PER_EVENT } from './constants';
import { signWithinCeiling } from './events';
import type { NostrEvent, Signer } from './signer';

/** The a-tag address of a save. */
export function itemAddress(pubkey: string, d: string): string {
  return `${KIND.appData}:${pubkey}:${d}`;
}

/** Kind 5s for these d tags, at most 50 addresses each, each with ["k","30078"]. */
export async function buildDeletions(signer: Signer, ds: string[], createdAt: number): Promise<NostrEvent[]> {
  const out: NostrEvent[] = [];
  for (let i = 0; i < ds.length; i += MAX_DELETIONS_PER_EVENT) {
    const tags = ds.slice(i, i + MAX_DELETIONS_PER_EVENT).map((d) => ['a', itemAddress(signer.pubkey(), d)]);
    tags.push(['k', String(KIND.appData)]);
    out.push(await signWithinCeiling(signer, { kind: KIND.deletion, created_at: createdAt, tags, content: '' }));
  }
  return out;
}

/** The kind 5 removing a wrap: by the recipient once consumed, or by the wrap key for the extension's Undo. */
export function buildWrapDeletion(signer: Signer, wrapId: string, createdAt: number): Promise<NostrEvent> {
  return signWithinCeiling(signer, { kind: KIND.deletion, created_at: createdAt, tags: [['e', wrapId], ['k', String(KIND.giftWrap)]], content: '' });
}

/**
 * Whether a save is deleted: some kind 5 by the same author names its address at or after its created_at
 * (contract 4.1, 8). Takes verified events only: a forged kind 5 would otherwise drop saves.
 */
export function isDeleted(save: Pick<NostrEvent, 'pubkey' | 'created_at'>, d: string, deletions: NostrEvent[]): boolean {
  const address = itemAddress(save.pubkey, d);
  return deletions.some(
    (e) => e.kind === KIND.deletion && e.pubkey === save.pubkey && e.created_at >= save.created_at && e.tags.some((t) => t[0] === 'a' && t[1] === address),
  );
}
