// The identity service (src/services/identity.ts) on Node, its native modules stood in for: the key file as the
// Kotlin module answers (secrets left out of read, kept by write), Block Store, the WebView clear, and the files in
// a temporary folder.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex } from '@noble/hashes/utils.js';
import { BACKGROUND_ZERO_MS, LocalSigner, nobleSecp, secretKeyFromMnemonic } from '@kefli/protocol';
import { nodeCrypto } from '@kefli/protocol/node';
import { migrate } from '../src/data/schema';
import { BLOCK_STORE_WRITTEN, getSetting, hasData, setSetting } from '../src/data/settings';
import { ensureIdentityRow } from '../src/data/saves';
import type { SqlDb } from '../src/data/db';
import { memoryDb } from './sqlite';

type Identity = Record<string, string>;
type World = {
  db: SqlDb; root: string; record: { v: 1; identities: Identity[] } | null; readFails: number;
  blockStore: string | null; e2ee: boolean; calls: string[]; appState: ((s: string) => void) | null;
};
const mockWorld = {} as World;

const SECRETS = ['mnemonic', 'sk', 'client'];
const strip = (i: Identity) => Object.fromEntries(Object.entries(i).filter(([k]) => !SECRETS.includes(k)));
const find = (pubkey: string) => mockWorld.record?.identities.find((i) => i.pubkey === pubkey);

const mockNatives: Record<string, Record<string, (...a: never[]) => unknown>> = {
  KefliKeystore: {
    read: async () => {
      mockWorld.calls.push('read');
      if (mockWorld.readFails > 0) {
        mockWorld.readFails--;
        throw new Error('keystore not ready');
      }
      return mockWorld.record && JSON.stringify({ v: 1, identities: mockWorld.record.identities.map(strip) });
    },
    readMnemonic: async (pk: string) => find(pk)?.mnemonic ?? null,
    readSecret: async (pk: string) => {
      mockWorld.calls.push('readSecret');
      const i = find(pk);
      return (i?.provider === 'nip46' ? i?.client : i?.sk) ?? null;
    },
    write: async (json: string) => {
      const next = JSON.parse(json) as { v: 1; identities: Identity[] };
      for (const i of next.identities) {
        const old = find(i.pubkey);
        if (old?.provider === i.provider) for (const s of SECRETS) if (!(s in i) && old[s]) i[s] = old[s];
      }
      mockWorld.calls.push('write');
      mockWorld.record = next;
    },
    wipe: async () => undefined,
    wipeAll: async () => {
      mockWorld.calls.push('wipeAll');
      mockWorld.record = null;
    },
    blockStoreGet: async () => mockWorld.blockStore,
    blockStoreRemove: async () => {
      mockWorld.blockStore = null;
    },
    blockStoreCheck: async (pk: string) => {
      mockWorld.calls.push(`check ${pk.slice(0, 4)}`);
      const words = find(pk)?.mnemonic;
      if (!words) return null;
      return { entry: mockWorld.blockStore === null ? 'empty' : mockWorld.blockStore === words ? 'same' : 'other', e2ee: mockWorld.e2ee };
    },
    blockStoreSetFrom: async (pk: string) => {
      mockWorld.calls.push(`set ${pk.slice(0, 4)}`);
      mockWorld.blockStore = find(pk)!.mnemonic;
      return { cloud: mockWorld.e2ee };
    },
  },
  KefliSystem: {
    clearWebData: async () => {
      mockWorld.calls.push('clearWebData');
    },
  },
  KefliVoice: { clearLog: () => undefined, addListener: () => undefined },
  KefliNip55: {},
  KefliSecp: {},
};

jest.mock('expo-modules-core', () => ({ requireNativeModule: (name: string) => mockNatives[name] }), { virtual: true });
jest.mock('react-native', () => ({ AppState: { addEventListener: (_: string, f: (s: string) => void) => (mockWorld.appState = f) } }), { virtual: true });
jest.mock('../src/services/store', () => ({ store: () => mockWorld.db }));
jest.mock('../src/crypto/port', () => ({ phoneCrypto: jest.requireActual('@kefli/protocol/node').nodeCrypto }));
jest.mock('../src/crypto/secp', () => ({ nativeSecp: jest.requireActual('@kefli/protocol').nobleSecp }));
jest.mock('../src/services/nip46', () => ({ nip46Signer: () => null }));
jest.mock('expo-file-system', () => {
  const fs = jest.requireActual('node:fs');
  const path = jest.requireActual('node:path');
  class Entry {
    readonly uri: string;
    constructor(parent: Entry | string, name?: string) {
      const base = typeof parent === 'string' ? parent : parent.uri;
      this.uri = name ? path.join(base, name) : base;
    }
    get name() {
      return path.basename(this.uri);
    }
    get exists() {
      return fs.existsSync(this.uri);
    }
    delete() {
      fs.rmSync(this.uri, { recursive: true });
    }
    list() {
      return fs.readdirSync(this.uri).map((n: string) => new Entry(this, n));
    }
  }
  return {
    Directory: Entry,
    Paths: {
      get document() {
        return new Entry(path.join(mockWorld.root, 'files'));
      },
      get cache() {
        return new Entry(path.join(mockWorld.root, 'cache'));
      },
    },
  };
}, { virtual: true });

type Identity_ = typeof import('../src/services/identity');
let id: Identity_;
const MNEMONIC = 'leader monkey parrot ring guide accident before fence cannon height naive bean';

async function localIdentity(origin = 'new'): Promise<string> {
  const sk = await secretKeyFromMnemonic(MNEMONIC, nodeCrypto);
  const pubkey = new LocalSigner(sk.slice(), nobleSecp).pubkey();
  mockWorld.record = { v: 1, identities: [{ pubkey, provider: 'local', sk: bytesToHex(sk), mnemonic: MNEMONIC, origin }] };
  ensureIdentityRow(mockWorld.db, 1, pubkey, origin as never, true);
  return pubkey;
}

const settled = async () => {
  for (let i = 0; i < 20; i++) await new Promise((ok) => setImmediate(ok));
};
const zeroed = (s: LocalSigner) => s.nip44Encrypt(s.pubkey(), 'x').then(() => false, (e: Error) => e.message.includes('zeroed'));

beforeEach(() => {
  jest.resetModules();
  const db = memoryDb();
  migrate(db);
  Object.assign(mockWorld, { db, root: mkdtempSync(join(tmpdir(), 'kefli-id-')), record: null, readFails: 0, blockStore: null, e2ee: true, calls: [], appState: null });
  id = require('../src/services/identity');
});
afterEach(() => {
  jest.useRealTimers();
  rmSync(mockWorld.root, { recursive: true, force: true });
});

describe('a Keystore that fails for now is never no identity (mobile spec 3.2, F21)', () => {
  test('launch reads the key file again, and neither wipes nor routes to Welcome', async () => {
    const pk = await localIdentity();
    mockWorld.readFails = 2;
    const plan = await id.launch();
    expect(plan).toMatchObject({ wipeDb: false, route: 'saves' });
    expect(hasData(mockWorld.db)).toBe(true);
    expect((await id.currentSigner())?.pubkey()).toBe(pk);
  });

  test('a Keystore still failing fails launch and the share: nothing wiped, no key made over the file', async () => {
    await localIdentity();
    mockWorld.readFails = 99;
    await expect(id.launch()).rejects.toThrow('keystore not ready');
    expect(hasData(mockWorld.db)).toBe(true);
    await expect(id.ensureSigner()).rejects.toThrow('keystore not ready');
    expect(mockWorld.calls).not.toContain('write');
  });
});

describe('Block Store at each launch (mobile spec 3.3, F22)', () => {
  test('an entry a failed write left missing is written, with the cloud flag recorded; a matching one is left', async () => {
    const pk = await localIdentity();
    await id.launch();
    await settled();
    expect(mockWorld.blockStore).toBe(MNEMONIC);
    expect(getSetting(mockWorld.db, BLOCK_STORE_WRITTEN)).toBe(`${pk} 1`);
    mockWorld.calls = [];
    jest.resetModules();
    id = require('../src/services/identity');
    await id.launch();
    await settled();
    expect(mockWorld.calls.filter((c) => c.startsWith('set'))).toEqual([]);
  });

  test('an entry written before the screen lock was set is written again once end-to-end encryption is there', async () => {
    const pk = await localIdentity();
    mockWorld.blockStore = MNEMONIC;
    setSetting(mockWorld.db, BLOCK_STORE_WRITTEN, `${pk} 0`);
    await id.launch();
    await settled();
    expect(mockWorld.calls).toContain(`set ${pk.slice(0, 4)}`);
    expect(getSetting(mockWorld.db, BLOCK_STORE_WRITTEN)).toBe(`${pk} 1`);
  });

  test('another key’s entry is never written over', async () => {
    await localIdentity();
    mockWorld.blockStore = 'other words';
    await id.launch();
    await settled();
    expect(mockWorld.blockStore).toBe('other words');
  });

  test('during a move the entry belongs to the move’s source', async () => {
    const pk = await localIdentity('early_share');
    mockWorld.db.run("INSERT INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES ('move:s', 'move', 'queued', 0, ?, 1, 1)",
      JSON.stringify({ from: 'cd'.repeat(32), to: pk }));
    await id.launch();
    await settled();
    expect(mockWorld.calls).toContain('check cdcd');
  });
});

describe('the key in memory (mobile spec 3.4, 7.1, F47)', () => {
  test('a signer is built from readSecret, since read returns no secret', async () => {
    const pk = await localIdentity();
    const s = await id.currentSigner();
    expect(s?.pubkey()).toBe(pk);
    expect(mockWorld.calls).toContain('readSecret');
  });

  test('Sign out zeroes the key in memory', async () => {
    await localIdentity();
    const s = (await id.currentSigner()) as LocalSigner;
    mkdirSync(join(mockWorld.root, 'cache'), { recursive: true });
    await id.signOut();
    expect(await zeroed(s)).toBe(true);
    expect(await id.currentSigner()).toBeNull();
  });

  test('five minutes in the background zero it; the next call builds a fresh one', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    await localIdentity();
    const s = (await id.currentSigner()) as LocalSigner;
    mockWorld.appState!('background');
    jest.advanceTimersByTime(BACKGROUND_ZERO_MS);
    mockWorld.appState!('active');
    expect(await zeroed(s)).toBe(true);
    const again = await id.currentSigner();
    expect(again).not.toBe(s);
    expect(again?.pubkey()).toBe(s.pubkey());
  });

  test('an early share kept beside a recovery code is written back without its secrets, which the key file keeps', async () => {
    const early = await localIdentity('early_share');
    const other = 'abandon '.repeat(11) + 'about';
    await id.adoptRecovery(other);
    const kept = mockWorld.record!.identities.find((i) => i.pubkey === early)!;
    expect(kept.mnemonic).toBe(MNEMONIC);
    expect(kept.sk).toBeDefined();
  });
});

describe('Delete my data and Sign out leave nothing behind (mobile spec 7.2, F28)', () => {
  test('the key file, the WebViews, the cache and unfinished shares go; the WebViews’ own folders are left to their clear', async () => {
    await localIdentity();
    const files = (p: string) => join(mockWorld.root, p);
    for (const d of ['files/kefli/texts', 'files/share-spool', 'cache/http-cache', 'cache/artwork', 'cache/WebView/Default']) mkdirSync(files(d), { recursive: true });
    writeFileSync(files('files/share-spool/1.json'), '{"text":"a shared link"}');
    writeFileSync(files('cache/http-cache/journal'), 'https://example.org/private-matter');
    writeFileSync(files('cache/loose.tmp'), 'x');
    await id.wipeEverything();
    expect(mockWorld.calls).toEqual(expect.arrayContaining(['wipeAll', 'clearWebData']));
    expect(mockWorld.record).toBeNull();
    expect(existsSync(files('files/share-spool'))).toBe(false);
    expect(existsSync(files('files/kefli'))).toBe(false);
    expect(readdirSync(files('cache'))).toEqual(['WebView']);
    expect(statSync(files('cache/WebView/Default')).isDirectory()).toBe(true);
    expect(hasData(mockWorld.db)).toBe(false);
  });
});
