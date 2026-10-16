// What the extension keeps (extension spec 7, contract 4.4): its device key and pairing in storage.local, nothing in
// storage.sync. A Store is chrome.storage.local in the build and a Map in the tests.
export interface Store {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export function chromeStore(area: chrome.storage.StorageArea): Store {
  return {
    async get<T>(key: string) {
      return (await area.get(key))[key] as T | undefined;
    },
    set: (key, value) => area.set({ [key]: value }),
    remove: (key) => area.remove(key),
  };
}

/** For the tests: a Map that copies through JSON, as chrome.storage stores values. */
export function memoryStore(): Store & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  const copy = (v: unknown) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  return {
    data,
    async get<T>(key: string) {
      return copy(data.get(key)) as T | undefined;
    },
    async set(key, value) {
      data.set(key, copy(value));
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

/** The longest relay or server address kept: the URL Standard sets none, and a real one is far shorter. */
export const ADDRESS_MAX = 2_048;
/** The most relays or servers a pairing keeps: a nostr user's own list can be long, but not this long. */
export const LIST_MAX = 100;

/**
 * A list of addresses from the phone or the operator as the extension keeps and shows it: strings only, none absurdly
 * long, at most LIST_MAX. A list that holds anything else would break Advanced and Copy debug info, and a huge one would
 * fill the storage.local the queue needs. Only the operator relay is ever sent to, so a list cut short loses nothing.
 */
export function addresses(l: unknown, max = LIST_MAX): string[] {
  return Array.isArray(l) ? l.filter((u): u is string => typeof u === 'string' && u.length <= ADDRESS_MAX).slice(0, max) : [];
}

/** The pairing record (contract 4.4): who this browser saves for, and where. */
export interface Pairing {
  v: 1;
  user_pubkey: string;
  write_relays: string[];
  blossom_servers: string[];
  token: string;
  label: string;
  paired_at: number;
}

/**
 * movesChecked is when the last look for a move that read its whole window began, which the next reads on from;
 * movesLooked when the last look began, whatever came of it; movesScan where a deep look stopped (move.ts).
 */
export const KEYS = {
  device: 'device', pairing: 'pairing', defaults: 'defaults', queue: 'queue', history: 'history', movesChecked: 'movesChecked', movesLooked: 'movesLooked', movesScan: 'movesScan',
} as const;
