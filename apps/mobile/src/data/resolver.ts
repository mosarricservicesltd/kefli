// The identity resolver (mobile spec 3.1, 3.3; contract 2; flow decisions 6 and 79), as pure decisions: the
// identity service (src/services/identity.ts) gathers the facts, carries out the plan, and is tested on the phone.

export type Origin = 'new' | 'early_share' | 'block_store' | 'recovery_code' | 'phone_pair' | 'nostr_signin';

export type LaunchFacts = {
  /**
   * The key file's active identity, or null when there is none: no file, a lost key or a file it can't open (3.2).
   * A Keystore that fails for now is never none; launch fails instead, before any of this (F21).
   */
  identity: { pubkey: string; origin: Origin } | null;
  /** The database holds data from an identity. */
  dbHasData: boolean;
  welcomeAnswered: boolean;
  /** Block Store's entry: a mnemonic, null when read empty, or undefined when the read failed. */
  blockStore: string | null | undefined;
  restoreRunning: boolean;
};

export type LaunchPlan = {
  /** A database with no readable key file is wiped first (7.1). */
  wipeDb: boolean;
  route: 'welcome' | 'welcome-early' | 'saves';
  restoreCard: boolean;
  /** Store Block Store's mnemonic as a block_store identity, set welcome.answered and queue a restore (FD 79). */
  adoptBlockStore: boolean;
};

export function resolveLaunch(f: LaunchFacts): LaunchPlan {
  const wipeDb = !f.identity && f.dbHasData;
  if (f.identity) {
    if (f.identity.origin === 'early_share' && !f.welcomeAnswered) return { wipeDb, route: 'welcome-early', restoreCard: false, adoptBlockStore: false };
    return { wipeDb, route: 'saves', restoreCard: f.restoreRunning, adoptBlockStore: false };
  }
  if (f.blockStore) return { wipeDb, route: 'saves', restoreCard: true, adoptBlockStore: true };
  return { wipeDb, route: 'welcome', restoreCard: false, adoptBlockStore: false };
}

export type ShareFacts = { identity: { pubkey: string } | null; blockStore: string | null | undefined };

/**
 * Which key a share saves under (3.1). An existing identity; else Block Store's mnemonic, adopted as block_store
 * with welcome.answered set and a restore queued; else a key the share mints itself (early_share), written to
 * Block Store only when the entry was read as empty, never after a failed read.
 */
export type SharePlan = { use: 'existing' } | { use: 'block_store' } | { use: 'mint'; writeBlockStore: boolean };

export function resolveShare(f: ShareFacts): SharePlan {
  if (f.identity) return { use: 'existing' };
  if (f.blockStore) return { use: 'block_store' };
  return { use: 'mint', writeBlockStore: f.blockStore === null };
}

export type BlockStoreFacts = {
  /** Block Store's entry against the identity's words, or null when the read failed. */
  entry: 'empty' | 'same' | 'other' | null;
  /** Whether Block Store reports end-to-end encryption available now, or null when the check failed. */
  e2ee: boolean | null;
  /** The cloud flag this phone last wrote the identity's words with, or null with no record of a write. */
  written: boolean | null;
};

/**
 * Whether launch writes the identity's words to Block Store again (3.3, contract 2, F22): the entry is missing (a
 * write that failed, or one never made), or its cloud flag no longer matches end-to-end encryption, rechecked at
 * each launch. Never over another key's entry, which may be the way back to another library, nor after a failed
 * read.
 */
export function blockStoreRewrite(f: BlockStoreFacts): boolean {
  if (f.entry === 'empty') return true;
  return f.entry === 'same' && f.e2ee !== null && f.written !== f.e2ee;
}
