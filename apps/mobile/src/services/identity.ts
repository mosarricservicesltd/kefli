// The identity the app signs with (mobile spec 3.1–3.3), carrying out the resolver's plans (src/data/resolver.ts).
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { LocalSigner, Nip55Signer, newMnemonic, secretKeyFromMnemonic, type SignerProvider } from '@kefli/protocol';
import { nip55Port } from '../../modules/kefli-nip55/src';
import { nip46Signer } from './nip46';
import { KefliKeystore, type KeyIdentity } from '../../modules/kefli-keystore/src';
import { phoneCrypto } from '../crypto/port';
import { nativeSecp } from '../crypto/secp';
import { resolveLaunch, resolveShare, type LaunchPlan, type Origin } from '../data/resolver';
import { WELCOME_ANSWERED, devicePrefs, getSetting, hasData, queueRestore, restorePrefs, restoreRunning, setSetting, wipe } from '../data/settings';
import { ensureIdentityRow } from '../data/saves';
import { store } from './store';
import { Directory, Paths } from 'expo-file-system';

let signer: SignerProvider | null = null;
const now = () => Math.floor(Date.now() / 1000);

/** The active identity is the key file's first; a move's source, if any, follows it. */
async function activeIdentity(): Promise<KeyIdentity | null> {
  const r = await KefliKeystore.read();
  return r?.identities[0] ?? null;
}

/** The signer for an identity in the key file (3.4): its own key, the signer app's, or the bunker's. */
function signerFor(id: KeyIdentity): SignerProvider | null {
  if (id.provider === 'local') return id.sk ? new LocalSigner(hexToBytes(id.sk), nativeSecp) : null;
  if (id.provider === 'nip55') return id.package ? new Nip55Signer(nip55Port, id.package, id.pubkey) : null;
  return id.bunker && id.client ? nip46Signer(id.bunker, id.client, id.pubkey) : null;
}

/** Block Store's entry: the mnemonic, null when empty, undefined when the read failed. */
async function readBlockStore(): Promise<string | null | undefined> {
  try {
    return await KefliKeystore.blockStoreGet();
  } catch {
    return undefined;
  }
}

export async function currentSigner(): Promise<SignerProvider | null> {
  if (signer) return signer;
  const id = await activeIdentity();
  signer = id ? signerFor(id) : null;
  return signer;
}

/** The signer for any identity in the key file: the active one, or a move's source (C§4.8). */
export async function signerOf(pubkey: string): Promise<SignerProvider | null> {
  const current = await currentSigner();
  if (current?.pubkey() === pubkey) return current;
  const r = await KefliKeystore.read().catch(() => null);
  const id = r?.identities.find((i) => i.pubkey === pubkey);
  return id ? signerFor(id) : null;
}

/**
 * The move's last act on the keys (C§4.8 step 5, 3.3): S leaves the key file, and Block Store takes T's mnemonic,
 * or is emptied when T is a nostr app and has none.
 */
export async function retireSourceKeys(from: string, to: string): Promise<void> {
  await KefliKeystore.wipe(from);
  const r = await KefliKeystore.read().catch(() => null);
  const words = r?.identities.find((i) => i.pubkey === to)?.provider === 'local' ? await KefliKeystore.readMnemonic(to).catch(() => null) : null;
  if (words) await KefliKeystore.blockStoreSet(words).catch(() => undefined);
  else await KefliKeystore.blockStoreRemove().catch(() => undefined);
}

/** A signer just signed in with becomes the current one (nostrSignIn.ts). */
export function setCurrentSigner(s: SignerProvider | null): void {
  signer = s;
}

/** Stores a mnemonic's key in the key file and the database. */
async function adopt(mnemonic: string, origin: Origin): Promise<LocalSigner> {
  const sk = await secretKeyFromMnemonic(mnemonic, phoneCrypto);
  const s = new LocalSigner(sk.slice(), nativeSecp);
  await KefliKeystore.write({ v: 1, identities: [{ pubkey: s.pubkey(), provider: 'local', sk: bytesToHex(sk), mnemonic, origin }] });
  sk.fill(0);
  ensureIdentityRow(store(), now(), s.pubkey(), origin, true);
  signer = s;
  return s;
}

/** Block Store's key on this phone (FD 79): the identity, welcome.answered, and a restore to run. */
async function adoptBlockStore(mnemonic: string): Promise<LocalSigner> {
  const s = await adopt(mnemonic, 'block_store');
  setSetting(store(), WELCOME_ANSWERED, '1');
  queueRestore(store(), now(), s.pubkey());
  return s;
}

/** At launch: what to open, after wiping a database whose key is gone or adopting Block Store's key. */
export async function launch(): Promise<LaunchPlan> {
  const db = store();
  const id = await activeIdentity();
  const blockStore = id ? null : await readBlockStore();
  const plan = resolveLaunch({
    identity: id ? { pubkey: id.pubkey, origin: (id.origin ?? 'new') as Origin } : null,
    dbHasData: hasData(db),
    welcomeAnswered: getSetting(db, WELCOME_ANSWERED) === '1',
    blockStore,
    restoreRunning: restoreRunning(db),
  });
  if (plan.wipeDb) wipe(db);
  if (plan.adoptBlockStore && blockStore) await adoptBlockStore(blockStore);
  return plan;
}

/** The signer a share saves under (3.1): the identity, else Block Store's key, else a key the share mints. */
export async function ensureSigner(): Promise<SignerProvider> {
  const existing = await currentSigner();
  if (existing) return existing;
  const blockStore = await readBlockStore();
  const plan = resolveShare({ identity: null, blockStore });
  if (plan.use === 'block_store' && blockStore) return adoptBlockStore(blockStore);
  const mnemonic = newMnemonic(phoneCrypto);
  const s = await adopt(mnemonic, 'early_share');
  if (plan.use === 'mint' && plan.writeBlockStore) await KefliKeystore.blockStoreSet(mnemonic).catch(() => undefined);
  return s;
}

/**
 * New here (5.2, FD 2): keeps a key an early share made, otherwise makes one and puts it in Block Store; then
 * Welcome is answered. Returns the identity's pubkey.
 */
export async function newHere(): Promise<string> {
  const s = (await currentSigner()) ?? (await (async () => {
    const mnemonic = newMnemonic(phoneCrypto);
    const made = await adopt(mnemonic, 'new');
    await KefliKeystore.blockStoreSet(mnemonic).catch(() => undefined);
    return made;
  })());
  setSetting(store(), WELCOME_ANSWERED, '1');
  return s.pubkey();
}

/** The pubkey a recovery code gives, for the first pass (5.3); nothing is stored. */
export async function pubkeyOfCode(mnemonic: string): Promise<string> {
  const sk = await secretKeyFromMnemonic(mnemonic, phoneCrypto);
  const pk = new LocalSigner(sk.slice(), nativeSecp).pubkey();
  sk.fill(0);
  return pk;
}

/**
 * A recovery code that found a library, or a mnemonic another phone handed over (5.3): its key stored, Welcome answered and the restore queued. Block Store
 * takes it (3.3), except after an early share, whose key S stays in the key file and in Block Store as the move's
 * source until the move's step 5 (C§4.8, built in week 5); its saves are kept under S meanwhile. Returns the pubkey.
 */
export async function adoptRecovery(mnemonic: string, origin: 'recovery_code' | 'phone_pair' = 'recovery_code'): Promise<string> {
  const db = store();
  const early = await activeIdentity();
  const keepEarly = early?.origin === 'early_share' ? early : null;
  const sk = await secretKeyFromMnemonic(mnemonic, phoneCrypto);
  const s = new LocalSigner(sk.slice(), nativeSecp);
  const identities: KeyIdentity[] = [{ pubkey: s.pubkey(), provider: 'local', sk: bytesToHex(sk), mnemonic, origin }];
  if (keepEarly) {
    const words = await KefliKeystore.readMnemonic(keepEarly.pubkey).catch(() => null);
    identities.push({ ...keepEarly, ...(words ? { mnemonic: words } : {}) });
  }
  await KefliKeystore.write({ v: 1, identities });
  sk.fill(0);
  db.tx(() => {
    if (keepEarly) {
      db.run("UPDATE identities SET role = 'move_source' WHERE pubkey = ?", keepEarly.pubkey);
      db.run("INSERT OR IGNORE INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES (?, 'move', 'queued', 0, ?, ?, ?)",
        `move:${keepEarly.pubkey}`, JSON.stringify({ from: keepEarly.pubkey, to: s.pubkey() }), now(), now());
    }
    ensureIdentityRow(db, now(), s.pubkey(), origin, true);
    setSetting(db, WELCOME_ANSWERED, '1');
    queueRestore(db, now(), s.pubkey());
  });
  if (!keepEarly) await KefliKeystore.blockStoreSet(mnemonic).catch(() => undefined);
  signer = s;
  return s.pubkey();
}

/**
 * Delete my data's step 3 (7.2): the key file, Block Store's entry, the database and every file under
 * Paths.document/kefli (texts, images, staged blobs), and the lock-screen artwork cache. Kefli starts as if just
 * installed.
 */
export async function wipeEverything(): Promise<void> {
  const r = await KefliKeystore.read().catch(() => null);
  for (const id of r?.identities ?? []) await KefliKeystore.wipe(id.pubkey).catch(() => undefined);
  await KefliKeystore.blockStoreRemove().catch(() => undefined);
  wipe(store());
  for (const d of [new Directory(Paths.document, 'kefli'), new Directory(Paths.cache, 'artwork')]) if (d.exists) d.delete();
  signer = null;
}

/**
 * Sign out (FD 105): the library and its signer leave this phone, and nothing is deleted anywhere else. The key file's
 * entries, the database and the files go as for Delete my data, but the reader and voice settings stay, since they
 * belong to the phone. Kefli starts at Welcome.
 */
export async function signOut(): Promise<void> {
  const kept = devicePrefs(store());
  await wipeEverything();
  restorePrefs(store(), kept);
}

/**
 * Signing in with the user's nostr app (5.3, C§2): the identity stored with how to reach their app, Welcome
 * answered, the restore queued, and Block Store's entry removed, since this identity has no mnemonic. After an early
 * share, the early key stays as the move's source, Block Store with it, until the move ends (C§4.8, week 5).
 */
export async function adoptNostr(s: SignerProvider, how: Pick<KeyIdentity, 'provider' | 'package' | 'bunker' | 'client'>): Promise<string> {
  const db = store();
  const early = await activeIdentity();
  const keepEarly = early?.origin === 'early_share' ? early : null;
  const identities: KeyIdentity[] = [{ pubkey: s.pubkey(), origin: 'nostr_signin', ...how }];
  if (keepEarly) {
    const words = await KefliKeystore.readMnemonic(keepEarly.pubkey).catch(() => null);
    identities.push({ ...keepEarly, ...(words ? { mnemonic: words } : {}) });
  }
  await KefliKeystore.write({ v: 1, identities });
  db.tx(() => {
    if (keepEarly) {
      db.run("UPDATE identities SET role = 'move_source' WHERE pubkey = ?", keepEarly.pubkey);
      db.run("INSERT OR IGNORE INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES (?, 'move', 'queued', 0, ?, ?, ?)",
        `move:${keepEarly.pubkey}`, JSON.stringify({ from: keepEarly.pubkey, to: s.pubkey() }), now(), now());
    }
    ensureIdentityRow(db, now(), s.pubkey(), 'nostr_signin', false, how.provider);
    setSetting(db, WELCOME_ANSWERED, '1');
    queueRestore(db, now(), s.pubkey());
  });
  if (!keepEarly) await KefliKeystore.blockStoreRemove().catch(() => undefined);
  signer = s;
  return s.pubkey();
}
