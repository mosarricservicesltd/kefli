// The identity the app signs with (mobile spec 3.1–3.3), carrying out the resolver's plans (src/data/resolver.ts).
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { LocalSigner, newMnemonic, secretKeyFromMnemonic } from '@shelf/protocol';
import { ShelfKeystore, type KeyIdentity } from '../../modules/shelf-keystore/src';
import { phoneCrypto } from '../crypto/port';
import { nativeSecp } from '../crypto/secp';
import { resolveLaunch, resolveShare, type LaunchPlan, type Origin } from '../data/resolver';
import { WELCOME_ANSWERED, getSetting, hasData, queueRestore, restoreRunning, setSetting, wipe } from '../data/settings';
import { ensureIdentityRow } from '../data/saves';
import { store } from './store';

let signer: LocalSigner | null = null;
const now = () => Math.floor(Date.now() / 1000);

async function activeIdentity() {
  const r = await ShelfKeystore.read();
  return r?.identities.find((i) => i.provider === 'local' && i.sk) ?? null;
}

/** Block Store's entry: the mnemonic, null when empty, undefined when the read failed. */
async function readBlockStore(): Promise<string | null | undefined> {
  try {
    return await ShelfKeystore.blockStoreGet();
  } catch {
    return undefined;
  }
}

export async function currentSigner(): Promise<LocalSigner | null> {
  if (signer) return signer;
  const local = await activeIdentity();
  if (!local?.sk) return null;
  signer = new LocalSigner(hexToBytes(local.sk), nativeSecp);
  return signer;
}

/** Stores a mnemonic's key in the key file and the database. */
async function adopt(mnemonic: string, origin: Origin): Promise<LocalSigner> {
  const sk = await secretKeyFromMnemonic(mnemonic, phoneCrypto);
  const s = new LocalSigner(sk.slice(), nativeSecp);
  await ShelfKeystore.write({ v: 1, identities: [{ pubkey: s.pubkey(), provider: 'local', sk: bytesToHex(sk), mnemonic, origin }] });
  sk.fill(0);
  ensureIdentityRow(store(), now(), s.pubkey(), origin, true);
  signer = s;
  return s;
}

/** Block Store's shelf on this phone (FD 79): the identity, welcome.answered, and a restore to run. */
async function adoptBlockStore(mnemonic: string): Promise<LocalSigner> {
  const s = await adopt(mnemonic, 'block_store');
  setSetting(store(), WELCOME_ANSWERED, '1');
  queueRestore(store(), now(), s.pubkey());
  return s;
}

/** At launch: what to open, after wiping a database whose key is gone or adopting Block Store's shelf. */
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

/** The signer a share saves under (3.1): the identity, else Block Store's shelf, else a key the share mints. */
export async function ensureSigner(): Promise<LocalSigner> {
  const existing = await currentSigner();
  if (existing) return existing;
  const blockStore = await readBlockStore();
  const plan = resolveShare({ identity: null, blockStore });
  if (plan.use === 'block_store' && blockStore) return adoptBlockStore(blockStore);
  const mnemonic = newMnemonic(phoneCrypto);
  const s = await adopt(mnemonic, 'early_share');
  if (plan.use === 'mint' && plan.writeBlockStore) await ShelfKeystore.blockStoreSet(mnemonic).catch(() => undefined);
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
    await ShelfKeystore.blockStoreSet(mnemonic).catch(() => undefined);
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
 * A recovery code that found a shelf (5.3): its key stored, Welcome answered and the restore queued. Block Store
 * takes it (3.3), except after an early share, whose key S stays in the key file and in Block Store as the move's
 * source until the move's step 5 (C§4.8, built in week 5); its saves are kept under S meanwhile. Returns the pubkey.
 */
export async function adoptRecovery(mnemonic: string): Promise<string> {
  const db = store();
  const early = await activeIdentity();
  const keepEarly = early?.origin === 'early_share' ? early : null;
  const sk = await secretKeyFromMnemonic(mnemonic, phoneCrypto);
  const s = new LocalSigner(sk.slice(), nativeSecp);
  const identities: KeyIdentity[] = [{ pubkey: s.pubkey(), provider: 'local', sk: bytesToHex(sk), mnemonic, origin: 'recovery_code' }];
  if (keepEarly) {
    const words = await ShelfKeystore.readMnemonic(keepEarly.pubkey).catch(() => null);
    identities.push({ ...keepEarly, ...(words ? { mnemonic: words } : {}) });
  }
  await ShelfKeystore.write({ v: 1, identities });
  sk.fill(0);
  db.tx(() => {
    if (keepEarly) {
      db.run("UPDATE identities SET role = 'move_source' WHERE pubkey = ?", keepEarly.pubkey);
      db.run("INSERT OR IGNORE INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES (?, 'move', 'queued', 0, ?, ?, ?)",
        `move:${keepEarly.pubkey}`, JSON.stringify({ from: keepEarly.pubkey, to: s.pubkey() }), now(), now());
    }
    ensureIdentityRow(db, now(), s.pubkey(), 'recovery_code', true);
    setSetting(db, WELCOME_ANSWERED, '1');
    queueRestore(db, now(), s.pubkey());
  });
  if (!keepEarly) await ShelfKeystore.blockStoreSet(mnemonic).catch(() => undefined);
  signer = s;
  return s.pubkey();
}
