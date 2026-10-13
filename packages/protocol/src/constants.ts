// Kinds, addresses and limits from the contract. Kind numbers and d namespaces never change after launch (C§10).

/** The contract version this code implements; test/contractVersion.test.ts holds it to the contract's header. */
export const CONTRACT_VERSION = '1.10';

export const KIND = {
  /** NIP-01 profile: a nostr user's name and picture for You (FD 12, G12). */
  metadata: 0,
  /** NIP-09 deletion. */
  deletion: 5,
  /** NIP-59 seal, around a pair-ack (C§4.4). */
  seal: 13,
  /** NIP-59 gift wrap: browser save requests and pair-acks (C§4.4). */
  giftWrap: 1059,
  /** NIP-65 relay list (C§3.1). */
  relayList: 10002,
  /** BUD-03 Blossom server list (C§4.2). */
  serverList: 10063,
  /** NIP-42 relay authentication. */
  auth: 22242,
  /** Blossom upload authorisation. */
  blossomAuth: 24242,
  /** NIP-98 HTTP authorisation (C§6). */
  httpAuth: 27235,
  /** NIP-78 app data: saves (C§4.1) and the connected-browsers record (C§4.9). */
  appData: 30078,
} as const;

/** Every save and every other Kefli record carries this t tag (C§4.1, v1.5). */
export const T_TAG = 'kefli';
export const D_PREFIX = 'kefli/';
export const ITEM_D_PREFIX = 'kefli/item/';
export const DEVICES_D = 'kefli/devices';

/** No client publishes an event over 16 KB serialised (C§3.3). */
export const MAX_EVENT_BYTES = 16_384;
/** An item event should stay under 4 KB (C§4.1); above it the client warns. */
export const ITEM_TARGET_BYTES = 4_096;
/** Kind 5 events name at most 50 addresses each (C§4.1). */
export const MAX_DELETIONS_PER_EVENT = 50;
