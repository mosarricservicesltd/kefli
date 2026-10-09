// Merging an inbound save into the phone's copy (mobile spec 4.5). Pure, so every client that applies the same
// events, in any order, ends with the same row.

import { ITEM_D_PREFIX, KIND } from './constants';
import { isItemD } from './normalise';
import type { NostrEvent } from './signer';

/** The local row's versioning columns. createdAt is the created_at of the event this row last published or took. */
export interface LocalVersion {
  eventId: string | null;
  createdAt: number | null;
  /** A local change not yet published. */
  dirty: boolean;
  modifiedAt: number | null;
}

export interface RemoteVersion {
  id: string;
  created_at: number;
}

/**
 * - insert: no local row; the remote becomes it.
 * - take: the remote replaces the local row.
 * - keep: the local row stands and nothing needs sending.
 * - republish: the local row stands and its pending change must go out above the remote's created_at.
 */
export type MergeOutcome = 'insert' | 'take' | 'keep' | 'republish';

/** Whether a replaces b as the newer version of one address: later created_at, a tie to the lower id (NIP-01). */
export function replaces(a: RemoteVersion, b: RemoteVersion): boolean {
  return a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);
}

export function mergeItem(local: LocalVersion | null, remote: RemoteVersion): MergeOutcome {
  if (!local) return 'insert';
  if (local.eventId === remote.id) return 'keep';
  // A dirty row yields only to an event newer than its own change; otherwise its change goes out above it.
  if (local.dirty) return remote.created_at > (local.modifiedAt ?? 0) ? 'take' : 'republish';
  if (local.eventId === null || local.createdAt === null) return 'take';
  return replaces(remote, { id: local.eventId, created_at: local.createdAt }) ? 'take' : 'keep';
}

/**
 * Whether a kind 5 made at deletedAt removes the local row: it names the row's address at or after the row's
 * created_at (contract 4.1), and the row wasn't changed after it.
 */
export function deletionRemoves(local: LocalVersion, deletedAt: number): boolean {
  if (local.dirty && (local.modifiedAt ?? 0) > deletedAt) return false;
  return deletedAt >= (local.createdAt ?? 0);
}

/** The save hashes a verified kind 5 by owner deletes: its a tags naming 30078:<owner>:kefli/item/<64 hex>. */
export function deletedHashes(event: NostrEvent, owner: string): string[] {
  if (event.kind !== KIND.deletion || event.pubkey !== owner) return [];
  const prefix = `${KIND.appData}:${owner}:`;
  const out: string[] = [];
  for (const t of event.tags) {
    if (t[0] !== 'a' || typeof t[1] !== 'string' || !t[1].startsWith(prefix)) continue;
    const d = t[1].slice(prefix.length);
    if (isItemD(d)) out.push(d.slice(ITEM_D_PREFIX.length));
  }
  return [...new Set(out)];
}
