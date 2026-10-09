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

export const KEYS = { device: 'device', pairing: 'pairing', defaults: 'defaults', queue: 'queue', history: 'history', movesChecked: 'movesChecked' } as const;
