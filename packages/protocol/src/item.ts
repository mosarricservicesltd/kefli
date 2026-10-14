// The save item JSON, the plaintext inside a kind 30078 save (C§4.1). Clients ignore unknown fields
// and refuse to write a version they don't understand (C§10); unknown fields are kept in extra and
// written back, so a newer client's additions survive an older client's edit.

export const ITEM_VERSION = 1;

export type ItemState = 'unread' | 'archived';
export type SourceKind = 'web' | 'nostr-article' | 'nostr-note';

export interface ItemText {
  /** Hex SHA-256 of the ciphertext blob. */
  sha256: string;
  /** Base64 of the 32-byte AES-256-GCM key. */
  key: string;
  /** Base64 of the 12-byte nonce. */
  nonce: string;
  /** The operator server and the mirror that holds the blob. */
  servers: string[];
}

export interface Item {
  v: 1;
  url: string;
  canonical: string | null;
  title: string | null;
  site: string | null;
  byline: string | null;
  /** The save's own time, Unix seconds. */
  saved_at: number;
  state: ItemState;
  /** Reading position as a fraction of words (C§4.1). */
  progress: number;
  words: number | null;
  lang: string | null;
  text: ItemText | null;
  text_hash: string | null;
  hero: string | null;
  /** v1 clients write web only (flow decision 82). */
  source_kind: SourceKind;
  source_ref?: string;
  /** Reserved for server voices; always null in v1. */
  audio_pref: null;
  /**
   * The save's hash (C§4.1, v1.10): sha256 of its normalised URL when first saved, which draws its cover and, keyed,
   * makes its address. Absent from saves before v1.10, whose unkeyed d is their hash.
   */
  hash?: string;
}

const KNOWN = new Set([
  'v', 'url', 'canonical', 'title', 'site', 'byline', 'saved_at', 'state', 'progress', 'words', 'lang',
  'text', 'text_hash', 'hero', 'source_kind', 'source_ref', 'audio_pref', 'hash',
]);

export class ItemVersionError extends Error {
  constructor(v: unknown) {
    super(`item version ${String(v)} is not one this client can write`);
    this.name = 'ItemVersionError';
  }
}

export interface ParsedItem {
  item: Item;
  /** Fields this client doesn't know, kept to be written back unchanged. */
  extra: Record<string, unknown>;
}

/**
 * How deep an item's JSON may nest: an item is three deep (text.servers), and a newer client's fields can add some.
 * Deeper is refused before it is parsed, since parsing and writing back such JSON recurse once a level: 5,000 levels,
 * well inside a 16 KB event, overflowed the stack that sync and every republish of the save run on.
 */
export const ITEM_MAX_DEPTH = 32;

/** The deepest nesting of arrays and objects in JSON text, counted without parsing it (strings skipped). */
export function jsonDepth(json: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++; // backslash: the next character is escaped
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) max = Math.max(max, ++depth);
    else if (c === 0x5d || c === 0x7d) depth--;
  }
  return max;
}

/** Parse decrypted item JSON. Throws on JSON that isn't an object with a url, or nests deeper than ITEM_MAX_DEPTH. */
export function parseItem(json: string): ParsedItem {
  if (jsonDepth(json) > ITEM_MAX_DEPTH) throw new TypeError('item nests too deep');
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new TypeError('item is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.url !== 'string') throw new TypeError('item has no url');
  const extra: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(o)) if (!KNOWN.has(k)) extra[k] = val;
  return { item: o as unknown as Item, extra };
}

/** Serialise for encryption, with unknown fields written back. Refuses any version but 1 (C§10). */
export function serialiseItem({ item, extra }: ParsedItem): string {
  if (item.v !== ITEM_VERSION) throw new ItemVersionError(item.v);
  return JSON.stringify({ ...extra, ...item });
}

/** The word reached, from progress and words (C§4.1): a missing or non-numeric progress counts as 0. */
export function wordReached(item: Pick<Item, 'progress' | 'words'>): number {
  const p = typeof item.progress === 'number' && Number.isFinite(item.progress) ? item.progress : 0;
  return item.words ? Math.round(p * item.words) : 0;
}

/** progress from the word reached (C§4.1): 0 when words is null or 0, otherwise min(1, w ÷ words). */
export function progressAt(wordIndex: number, words: number | null): number {
  return words ? Math.min(1, wordIndex / words) : 0;
}
