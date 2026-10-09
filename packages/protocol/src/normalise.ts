// The d tag of a save (C§4.3). normalise itself is the reference in shared/normalise.ts, which every
// port tests against shared/normalise.fixtures.json; this module adds the hash and the address.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { normalise } from '../../../shared/normalise';
import { ITEM_D_PREFIX } from './constants';

export { normalise, NotALinkError } from '../../../shared/normalise';

const ITEM_D = new RegExp(`^${ITEM_D_PREFIX}[0-9a-f]{64}$`);   // the prefix is letters and slashes only

/** Lowercase hex SHA-256 of the normalised URL: the save's hash, which also draws its cover. */
export function itemHash(url: string, canonical?: string | null): string {
  return bytesToHex(sha256(utf8ToBytes(normalise(url, canonical))));
}

/** The d tag for a save of this URL: kefli/item/<hash>. */
export function itemD(url: string, canonical?: string | null): string {
  return ITEM_D_PREFIX + itemHash(url, canonical);
}

/** True when d addresses a save, as opposed to another kefli/ record such as kefli/devices (C§4.1). */
export function isItemD(d: string): boolean {
  return ITEM_D.test(d);
}
export { urlParts } from '../../../shared/normalise';
