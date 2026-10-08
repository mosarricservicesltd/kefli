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
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getNetworkStateAsync, NetworkStateType } from 'expo-network';
import { removeImages, syncImages, type ImagePorts } from './images';
import { runPendingParses } from './pending';
import { drainInbox } from './inbox';
import { pickUpSpools } from '../share/pickup';
import { xRetryDelay } from './xpost';
import { ShelfParser } from '../../modules/shelf-parser/src';
import type { ParserResult } from './page';
import { stageBlob } from './staging';
import { File } from 'expo-file-system';
import { imageFiles, textFiles } from './textFiles';
import { readStaged } from './staging';
import { store } from './store';
import { activeOwner } from '../data/library';
import { beginRestore, settleRestore } from '../data/restore';
import { disconnect } from '../data/devices';
import type { ConnectPorts } from './connect';

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
let reading: string | null = null;

/** The article open in the Reader: its text is fetched first and its remote position waits (4.5). */
export function setReading(hash: string | null): void {
  reading = hash;
}

const syncListeners = new Set<() => void>();

/** Whether a sync is running, for Saves' sync line (5.6). */
export const syncRunning = {
  get: () => syncing !== null,
  subscribe: (l: () => void) => (syncListeners.add(l), () => syncListeners.delete(l)),
};

/**
 * One sync (mobile spec 4.5): the outbox, then saves and deletions from the read relays, then their texts.
 * Triggered at start, on returning to the foreground and after a share; concurrent calls share one run.
 */
export function runSync(): Promise<SyncResult> {
  if (syncing) return syncing;
  const run = (async (): Promise<SyncResult> => {
    try {
      await runOutbox().catch(() => 0);
      // a queued restore (C§8) is this sync: lists, every read relay's saves and deletions, then the texts
      const restoring = activeOwner(store());
      if (restoring) beginRestore(store(), Math.floor(Date.now() / 1000), restoring);
      const r = await syncInbound({
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
        files: { ...textFiles, removeAll: removeAllFiles },
        openHash: () => reading,
      });
      const owner = store().get<{ pubkey: string }>("SELECT pubkey FROM identities WHERE role = 'active'")?.pubkey;
      if (owner) settleRestore(store(), Math.floor(Date.now() / 1000), owner);
      if (owner) await runInbox(owner).catch(() => undefined);
      if (owner) await imagesIfUnmetered(owner).catch(() => undefined);
      if (owner) await parsePending(owner).catch(() => undefined);
      return r;
    } finally {
      syncing = null;
      syncListeners.forEach((l) => l());
    }
  })();
  syncing = run;
  syncListeners.forEach((l) => l());
  return run;
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
      // shares a killed process left in the spool are saved before the sync sends them (8.5)
      .then(() => pickUpSpools().then((n) => n && log('pickup', { saved: n })).catch((e) => log('pickup', { error: String((e as Error).message) })))
      .then(runSync)
      .then(async (r) => log('sync', { owner: (await currentSigner())?.pubkey().slice(0, 12), ...r }))
      .catch((e) => log('sync', { error: String((e as Error).message) }));
  launchPlan()
    .then((p) => log('launch', p))
    .catch((e) => log('launch', { error: String((e as Error).message) }))
    .finally(sync);
  watchInbox();
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      sync();
      watchInbox();
    } else {
      unwatchInbox();
    }
  });
  return () => {
    sub.remove();
    unwatchInbox();
  };
}

/** The image service's ports on the phone. */
export function imagePorts(): ImagePorts {
  return {
    db: store(),
    now: () => Math.floor(Date.now() / 1000),
    fetch,
    nameOf: (url) => bytesToHex(phoneCrypto.sha256(utf8ToBytes(url))),
    files: imageFiles,
    readArticle: textFiles.readArticle,
  };
}

/** Everything a save holds on the phone: its text, blocks and images (4.5: a deletion removes them all). */
export function removeAllFiles(hash: string): void {
  textFiles.removeAll(hash);
  removeImages(imagePorts(), hash);
}

/** Phase 6 on an unmetered network only (4.5); metered networks fetch an article's images when it opens. */
async function imagesIfUnmetered(owner: string): Promise<void> {
  const n = await getNetworkStateAsync().catch(() => null);
  if (n?.type === NetworkStateType.WIFI || n?.type === NetworkStateType.ETHERNET) await syncImages(imagePorts(), owner);
}

/** Phase 7: pending parses, one at a time, then their sends (4.5). */
async function parsePending(owner: string): Promise<void> {
  const r = await runPendingParses({
    db: store(),
    now: () => Math.floor(Date.now() / 1000),
    page: { fetch, parse: (b, t, u) => ShelfParser.parse(b, t, u) as Promise<ParserResult> },
    x: { fetch },
    crypto: phoneCrypto,
    stage: stageBlob,
    unstage: (path) => {
      const f = new File(path);
      if (f.exists) f.delete();
    },
    writeText: textFiles.writeText,
    targets: async () => {
      const d = await loadDefaults();
      return { api: d.operator.api, blossom: d.operator.blossom, mirror: d.mirrors[0] };
    },
  }, owner);
  if (r.parsed + r.failed > 0) await runOutbox().catch(() => 0);
  // X posts whose check X didn't answer are tried again from 30 s, doubling to an hour (G3).
  if (xTimer) clearTimeout(xTimer);
  xTimer = null;
  xFailures = r.xWaiting > 0 ? xFailures + 1 : 0;
  if (r.xWaiting > 0) xTimer = setTimeout(() => runSync().catch(() => undefined), xRetryDelay(xFailures) * 1000);
}

let xFailures = 0;
let xTimer: ReturnType<typeof setTimeout> | null = null;

/** Connect's ports on the phone (5.5). */
export function connectPorts(owner: string): ConnectPorts {
  return {
    db: store(),
    now: () => Math.floor(Date.now() / 1000),
    owner,
    defaults: loadDefaults,
    signer: currentSigner,
    fetch,
    crypto: phoneCrypto,
    runOutbox,
  };
}

/** Disconnect (5.5): revoked at once; the record and DELETE /devices go with the outbox. */
export async function disconnectBrowser(owner: string, devicePubkey: string): Promise<void> {
  const d = await loadDefaults();
  disconnect(store(), Math.floor(Date.now() / 1000), owner, d.operator.api, devicePubkey);
  runOutbox().catch(() => 0);
}

const parserPorts = () => ({
  crypto: phoneCrypto,
  stage: stageBlob,
  unstage: (path: string) => {
    const f = new File(path);
    if (f.exists) f.delete();
  },
  writeText: textFiles.writeText,
  targets: async () => {
    const d = await loadDefaults();
    return { api: d.operator.api, blossom: d.operator.blossom, mirror: d.mirrors[0] };
  },
});

let inboxRun: Promise<void> | null = null;

/** Phase 4 (4.7): the inbox drained; anything it saved goes straight out. Concurrent calls share one run. */
export function runInbox(owner: string): Promise<void> {
  inboxRun ??= (async () => {
    try {
      const signer = await currentSigner();
      if (signer?.pubkey() !== owner) return;
      const r = await drainInbox({
        db: store(),
        now: () => Math.floor(Date.now() / 1000),
        signer,
        query: (url, filters) => pool.query(url, filters as never),
        fetch,
        markdown: (html, u) => ShelfParser.markdown(html, u) as Promise<ParserResult>,
        defaults: loadDefaults,
        ...parserPorts(),
      }, owner);
      console.log(`[shelf-inbox] ${JSON.stringify(r)}`);
      if (r.created || r.merged || r.unarchived) {
        await runOutbox().catch(() => 0);
        await parsePending(owner).catch(() => undefined);
      }
    } finally {
      inboxRun = null;
    }
  })();
  return inboxRun;
}

let inboxStop: (() => void) | null = null;
let inboxRetry: ReturnType<typeof setTimeout> | null = null;
let inboxSoon: ReturnType<typeof setTimeout> | null = null;
let inboxStarting = false;

/**
 * While Shelf is in front, a live subscription on the operator relay (4.7) drains the inbox within a second of a
 * wrap arriving. limit 0 asks for new wraps only; the drain itself reads back from the cursor. A dropped
 * subscription is opened again after 5 s.
 */
function watchInbox(): void {
  if (inboxStop || inboxRetry || inboxStarting) return;
  inboxStarting = true;
  (async () => {
    const [d, signer] = await Promise.all([loadDefaults(), currentSigner()]);
    if (!signer) return;
    const owner = signer.pubkey();
    const drop = () => {
      inboxStop = null;
      if (AppState.currentState === 'active') inboxRetry = setTimeout(() => ((inboxRetry = null), watchInbox()), 5000);
    };
    inboxStop = await pool.watch(d.operator.relay, [{ kinds: [1059], '#p': [owner], limit: 0 }] as never, () => {
      if (inboxSoon) clearTimeout(inboxSoon);
      inboxSoon = setTimeout(() => runInbox(owner).catch(() => undefined), 300);
    }, drop);
  })().catch(() => {
    inboxStop = null;
    if (AppState.currentState === 'active') inboxRetry = setTimeout(() => ((inboxRetry = null), watchInbox()), 5000);
  }).finally(() => {
    inboxStarting = false;
  });
}

function unwatchInbox(): void {
  inboxStop?.();
  inboxStop = null;
  if (inboxRetry) clearTimeout(inboxRetry);
  inboxRetry = null;
}
