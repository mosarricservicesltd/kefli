// Drains the outbox with the real network (mobile spec 4.3): after a share's rows are released and at start,
// through the relay pool (4.4).
import { AppState } from 'react-native';
import { verifyEventWith } from '@shelf/protocol';
import { phoneCrypto } from '../crypto/port';
import { nativeSecp } from '../crypto/secp';
import { RelayPool } from '../net/pool';
import { LOCAL_STACK, loadDefaults, type Defaults } from './config';
import { currentSigner } from './identity';
import { launchPlan } from './launchState';
import { drain } from './send';
import { syncInbound, type SyncResult } from './sync';
import { textFiles } from './textFiles';
import { readStaged } from './staging';
import { store } from './store';

let running: Promise<number> | null = null;
let defaults: Defaults | null = null;

// One pool per process (mobile spec 4.4). ws:// only while the defaults point at the local stack.
export const pool = new RelayPool({
  verify: (e) => verifyEventWith(nativeSecp, e),
  signer: currentSigner,
  allowInsecure: LOCAL_STACK,
});

/** Sends whatever is due; concurrent calls share one run. Returns how many rows were sent. */
export function runOutbox(): Promise<number> {
  running ??= (async () => {
    try {
      defaults = await loadDefaults();
      const d = defaults;
      return await drain({
        db: store(),
        now: () => Math.floor(Date.now() / 1000),
        signer: async (pubkey) => {
          const s = await currentSigner();
          return s?.pubkey() === pubkey ? s : null;
        },
        fetch,
        crypto: phoneCrypto,
        defaults: () => d,
        publish: (url, event) => pool.publish(url, event),
        readBlob: readStaged,
      });
    } finally {
      running = null;
    }
  })();
  return running;
}

let syncing: Promise<SyncResult> | null = null;

/**
 * One sync (mobile spec 4.5): the outbox, then saves and deletions from the read relays, then their texts.
 * Triggered at start, on returning to the foreground and after a share; concurrent calls share one run.
 */
export function runSync(): Promise<SyncResult> {
  syncing ??= (async () => {
    try {
      await runOutbox().catch(() => 0);
      return await syncInbound({
        db: store(),
        now: () => Math.floor(Date.now() / 1000),
        signer: async (pubkey) => {
          const s = await currentSigner();
          return s?.pubkey() === pubkey ? s : null;
        },
        query: (url, filters) => pool.query(url, filters as never),
        fetch,
        crypto: phoneCrypto,
        defaults: loadDefaults,
        files: textFiles,
      });
    } finally {
      syncing = null;
    }
  })();
  return syncing;
}

/**
 * The app's sync triggers (4.5): start and each return to the foreground, always after the launch resolver,
 * so a sync never runs before Block Store's key is adopted. Returns the cleanup, for useEffect.
 */
export function startSync(): () => void {
  const log = (tag: string, v: unknown) => console.log(`[shelf-${tag}] ${JSON.stringify(v)}`);
  const sync = () =>
    launchPlan()
      .catch(() => null)
      .then(runSync)
      .then(async (r) => log('sync', { owner: (await currentSigner())?.pubkey().slice(0, 12), ...r }))
      .catch((e) => log('sync', { error: String((e as Error).message) }));
  launchPlan()
    .then((p) => log('launch', p))
    .catch((e) => log('launch', { error: String((e as Error).message) }))
    .finally(sync);
  const sub = AppState.addEventListener('change', (state) => state === 'active' && sync());
  return () => sub.remove();
}
