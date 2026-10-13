// The identity the app signs with (mobile spec 3.1–3.3), carrying out the resolver's plans (src/data/resolver.ts).
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { AppState } from 'react-native';
import { LocalSigner, NIP46_TIMEOUT_MS, Nip55Signer, SignerSlot, newMnemonic, secretKeyFromMnemonic, type SignerProvider } from '@kefli/protocol';
import { nip55Port } from '../../modules/kefli-nip55/src';
import { nip46Signer } from './nip46';
import { KefliKeystore, type KeyIdentity, type KeyRecord } from '../../modules/kefli-keystore/src';
import { KefliSystem } from '../../modules/kefli-system/src';
import { KefliVoice } from '../../modules/kefli-voice/src';
import { phoneCrypto } from '../crypto/port';
import { nativeSecp } from '../crypto/secp';
import type { SqlDb } from '../data/db';
import { moveJob } from '../data/move';
import { blockStoreRewrite, resolveLaunch, resolveShare, type LaunchPlan, type Origin } from '../data/resolver';
import {
  WELCOME_ANSWERED, blockStoreWritten, devicePrefs, getSetting, hasData, queueRestore, restorePrefs, restoreRunning, setBlockStoreWritten,
  setSetting, wipe,
} from '../data/settings';
import { ensureIdentityRow } from '../data/saves';
import { store } from './store';
import { Directory, Paths } from 'expo-file-system';

/** The current signer; a local key it lets go of is zeroed, and it goes after five minutes in the background (3.4). */
const slot = new SignerSlot();
AppState.addEventListener('change', (state) => (state === 'active' ? slot.foreground() : slot.background()));

const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/**
 * The key file, read again when the Keystore fails, as some phones' Keystores do just after boot (F21). A failure is
 * never no identity: after the third try it throws, so nothing is wiped and no new key is made over the file.
 */
async function readKeyFile(): Promise<KeyRecord | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await KefliKeystore.read();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(500 * attempt);
    }
  }
}

/** The active identity is the key file's first; a move's source, if any, follows it. */
async function activeIdentity(): Promise<KeyIdentity | null> {
  const r = await readKeyFile();
  return r?.identities[0] ?? null;
}

/**
 * The phone's signer for an identity in the key file (3.4): its own key, the signer app's, or the bunker's. A key
 * is read from the key file only here, when a signer is built from it (7.1). A signer app is reached out of sight
 * only (FD 104): sync, the outbox, shares and the inbox never put its screen in front of the person; withScreen() is
 * for what they start.
 */
async function signerFor(id: KeyIdentity): Promise<SignerProvider | null> {
  if (id.provider === 'nip55') return id.package ? new Nip55Signer(nip55Port, id.package, id.pubkey, NIP46_TIMEOUT_MS, false) : null;
  if (id.provider === 'nip46' && !id.bunker) return null;
  const secret = await KefliKeystore.readSecret(id.pubkey);
  if (!secret) return null;
  return id.provider === 'local' ? new LocalSigner(hexToBytes(secret), nativeSecp) : nip46Signer(id.bunker!, secret, id.pubkey);
}

/** Block Store's entry: the mnemonic, null when empty, undefined when the read failed. */
async function readBlockStore(): Promise<string | null | undefined> {
  try {
    return await KefliKeystore.blockStoreGet();
  } catch {
    return undefined;
  }
}

/**
 * Puts an identity's words in Block Store from the key file (3.3), recording the cloud flag they went with, so the
 * next launch can tell when end-to-end encryption has come or gone. False when the write failed; launch tries again.
 */
async function storeInBlockStore(pubkey: string): Promise<boolean> {
  try {
    const { cloud } = await KefliKeystore.blockStoreSetFrom(pubkey);
    setBlockStoreWritten(store(), pubkey, cloud);
    return true;
  } catch {
    return false;
  }
}

async function emptyBlockStore(): Promise<void> {
  await KefliKeystore.blockStoreRemove().then(() => setBlockStoreWritten(store(), null), () => undefined);
}

/**
 * At each launch with an identity (3.3, contract 2, F22): Block Store's entry is written again when it is missing,
 * or when end-to-end encryption has come or gone since it was written. It holds a move's source until the move ends,
 * otherwise the identity; a nostr app's identity has no words and nothing is written. A failure waits for the next
 * launch.
 */
async function refreshBlockStore(db: SqlDb, active: string): Promise<void> {
  const owner = moveJob(db)?.from ?? active;
  const check = await KefliKeystore.blockStoreCheck(owner);
  if (check && blockStoreRewrite({ ...check, written: blockStoreWritten(db, owner) })) await storeInBlockStore(owner);
}

/** A signer that may open the signer app's screen, for what the person started and is watching: Delete my data, a move. */
export function withScreen(s: SignerProvider): SignerProvider {
  return s instanceof Nip55Signer ? s.withScreen() : s;
}

export async function currentSigner(): Promise<SignerProvider | null> {
  const held = slot.get();
  if (held) return held;
  const id = await activeIdentity();
  const built = id ? await signerFor(id) : null;
  // another call may have built one meanwhile: that one stays, and this copy of the key goes
  const meanwhile = slot.get();
  if (meanwhile) {
    if (built instanceof LocalSigner) built.zero();
    return meanwhile;
  }
  slot.set(built);
  return built;
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
 * or is emptied when T is a nostr app and has none. A write that fails empties it too, so it never keeps S's words;
 * the next launch writes T's.
 */
export async function retireSourceKeys(from: string, to: string): Promise<void> {
  await KefliKeystore.wipe(from);
  const r = await KefliKeystore.read().catch(() => null);
  const local = r?.identities.find((i) => i.pubkey === to)?.provider === 'local';
  if (!local || !(await storeInBlockStore(to))) await emptyBlockStore();
}

/** A signer just signed in with becomes the current one (nostrSignIn.ts). */
export function setCurrentSigner(s: SignerProvider | null): void {
  slot.set(s);
}

/** Stores a mnemonic's key in the key file and the database. */
async function adopt(mnemonic: string, origin: Origin): Promise<LocalSigner> {
  const sk = await secretKeyFromMnemonic(mnemonic, phoneCrypto);
  const s = new LocalSigner(sk.slice(), nativeSecp);
  await KefliKeystore.write({ v: 1, identities: [{ pubkey: s.pubkey(), provider: 'local', sk: bytesToHex(sk), mnemonic, origin }] });
  sk.fill(0);
  ensureIdentityRow(store(), now(), s.pubkey(), origin, true);
  slot.set(s);
  return s;
}

/** Block Store's key on this phone (FD 79): the identity, welcome.answered, and a restore to run. */
async function adoptBlockStore(mnemonic: string): Promise<LocalSigner> {
  const s = await adopt(mnemonic, 'block_store');
  setSetting(store(), WELCOME_ANSWERED, '1');
  queueRestore(store(), now(), s.pubkey());
  return s;
}

/**
 * At launch: what to open, after wiping a database whose key is gone or adopting Block Store's key. A key file the
 * Keystore can't read for now rejects, and nothing is wiped (F21). With an identity, Block Store's entry is checked
 * again, out of launch's way.
 */
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
  if (id) refreshBlockStore(db, id.pubkey).catch(() => undefined);
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
  if (plan.use === 'mint' && plan.writeBlockStore) await storeInBlockStore(s.pubkey());
  return s;
}

/**
 * New here (5.2, FD 2): keeps a key an early share made, otherwise makes one and puts it in Block Store; then
 * Welcome is answered. Returns the identity's pubkey.
 */
export async function newHere(): Promise<string> {
  const s = (await currentSigner()) ?? (await (async () => {
    const made = await adopt(newMnemonic(phoneCrypto), 'new');
    await storeInBlockStore(made.pubkey());
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
 * S is written back without its secrets, which the key file keeps (KeyFile.write).
 */
export async function adoptRecovery(mnemonic: string, origin: 'recovery_code' | 'phone_pair' = 'recovery_code'): Promise<string> {
  const db = store();
  const early = await activeIdentity();
  const keepEarly = early?.origin === 'early_share' ? early : null;
  const sk = await secretKeyFromMnemonic(mnemonic, phoneCrypto);
  const s = new LocalSigner(sk.slice(), nativeSecp);
  const identities: KeyIdentity[] = [{ pubkey: s.pubkey(), provider: 'local', sk: bytesToHex(sk), mnemonic, origin }];
  if (keepEarly) identities.push(keepEarly);
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
  if (!keepEarly) await storeInBlockStore(s.pubkey());
  slot.set(s);
  return s.pubkey();
}

/**
 * Delete my data's step 3 (7.2): the signer's key in memory, the key file, Block Store's entry, the WebViews'
 * cookies, storage and cache, the database (its free pages too), every file under Paths.document/kefli (texts,
 * images, staged blobs), unfinished shares' spools, and the cache (page and image fetches, the lock-screen artwork).
 * Kefli starts as if just installed. The key file goes first: if a later step fails, the next launch finds no
 * identity and wipes the database, and Sign out can be run again.
 */
export async function wipeEverything(): Promise<void> {
  slot.set(null);
  await KefliKeystore.wipeAll();
  await emptyBlockStore();
  await KefliSystem.clearWebData();
  wipe(store());
  for (const d of [new Directory(Paths.document, 'kefli'), new Directory(Paths.document, 'share-spool')]) if (d.exists) d.delete();
  // the WebViews' own cache folders went through clearWebData, which they still have open
  for (const e of new Directory(Paths.cache).list()) if (!/^(WebView|org\.chromium)/.test(e.name)) e.delete();
  // the voice test log lives in external files, outside the folders above (F7)
  KefliVoice.clearLog();
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
  if (keepEarly) identities.push(keepEarly);
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
  if (!keepEarly) await emptyBlockStore();
  // the sign-in's signer could open the app's screen; from here the phone's own work reaches it out of sight (FD 104)
  slot.set(s instanceof Nip55Signer ? s.outOfSight() : s);
  return s.pubkey();
}
