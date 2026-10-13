// Drains the outbox with the real network (mobile spec 4.3): after a share's rows are released and at start,
// through the relay pool (4.4).
import { AppState } from 'react-native';
import { phonePagePorts } from './pagePorts';
import { verifyEventWith } from '@kefli/protocol';
import { phoneCrypto } from '../crypto/port';
import { nativeSecp } from '../crypto/secp';
import { RelayPool } from '../net/pool';
import { LOCAL_STACK, loadDefaults, type Defaults } from './config';
import { currentSigner, retireSourceKeys, setCurrentSigner, signerOf, withScreen } from './identity';
import { launchPlan } from './launchState';
import { drain } from './send';
import { syncInbound, syncOwner, type SyncPorts, type SyncResult } from './sync';
import { runMove, type MoveOutcome } from './move';
import { moveJob } from '../data/move';
import { deriveArticle } from '../reader/blocks';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { getNetworkStateAsync, NetworkStateType } from 'expo-network';
import { removeImages, syncImages, type ImagePorts } from './images';
import { runPendingParses } from './pending';
import { drainInbox } from './inbox';
import { pickUpSpools } from '../share/pickup';
import { xRetryDelay } from './xpost';
import { KefliParser } from '../../modules/kefli-parser/src';
import type { ParserResult } from './page';
import { stageBlob } from './staging';
import { File } from 'expo-file-system';
import { imageFiles, textFiles } from './textFiles';
import { readStaged } from './staging';
import { store } from './store';
import { activeOwner } from '../data/library';
import { beginRestore, settleRestore } from '../data/restore';
import { queueImported } from '../data/saves';
import { takeImport } from './nostrSignIn';
import { disconnect } from '../data/devices';
import type { ConnectPorts } from './connect';
import type { ShowPorts } from './phonePair';
import type { AddRelayPorts } from './addRelay';
import { dailyCheck } from './nostrCheck';
import { KefliKeystore } from '../../modules/kefli-keystore/src';

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
        // a move's source still signs its own rows, and seals a moved browser's pair-ack (C§4.8)
        signer: signerOf,
        fetch,
        crypto: phoneCrypto,
        defaults: () => d,
        publish: (url, event) => pool.publish(url, event),
        readBlob: readStaged,
        query: (url, filters) => pool.query(url, filters),
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
      const r = await syncInbound(syncPorts());
      const owner = store().get<{ pubkey: string }>("SELECT pubkey FROM identities WHERE role = 'active'")?.pubkey;
      if (owner) settleRestore(store(), Math.floor(Date.now() / 1000), owner);
      // early saves move into the library just brought back, after the restore's first pass (C§4.8, FD 6)
      if (owner) await runMoveJob().catch((e) => console.log(`[kefli-move] ${JSON.stringify({ error: String((e as Error).message) })}`));
      // links a sign-in chose to bring in join after the restore's first pass (FD 82)
      const imported = owner ? takeImport(store(), owner) : null;
      if (owner && imported) {
        const d = await loadDefaults();
        queueImported(store(), owner, imported.links, imported.at, { api: d.operator.api, blossom: d.operator.blossom, mirror: d.mirrors[0] });
      }
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

function syncPorts(): SyncPorts {
  return {
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
  };
}

let moving: Promise<MoveOutcome> | null = null;
const moveListeners = new Set<(moved: number, total: number) => void>();
const doneListeners = new Set<(owner: string) => void>();

/** A move that has finished: the phone's identity is now T (app.ts follows it). */
export function onMoveDone(l: (owner: string) => void): () => void {
  doneListeners.add(l);
  return () => doneListeners.delete(l);
}

/** The move's "N of M" (5.8 sw-moving). */
export function onMoveProgress(l: (moved: number, total: number) => void): () => void {
  moveListeners.add(l);
  return () => moveListeners.delete(l);
}

/** Runs or resumes a queued move (C§4.8, 4.10); concurrent calls share one run. */
export function runMoveJob(): Promise<MoveOutcome> {
  moving ??= (async (): Promise<MoveOutcome> => {
    try {
      const job = moveJob(store());
      if (!job) {
        const ids = store().all<{ role: string; origin: string }>('SELECT role, origin FROM identities');
        const jobs = store().all<{ kind: string; state: string }>('SELECT kind, state FROM jobs');
        if (ids.length > 1) console.log(`[kefli-move] ${JSON.stringify({ outcome: 'no job', ids, jobs })}`);
        return 'done';
      }
      // the person watches a move run, so the new nostr app may ask on its screen (FD 104)
      const [source, target] = await Promise.all([signerOf(job.from), signerOf(job.to)].map((p) => p.then((s) => s && withScreen(s))));
      if (!source || !target) {
        console.log(`[kefli-move] ${JSON.stringify({ outcome: 'waiting', missing: !source ? 'source key' : 'target key' })}`);
        return 'waiting';
      }
      const r = await runMove({
        db: store(),
        now: () => Math.floor(Date.now() / 1000),
        source,
        target,
        defaults: loadDefaults,
        query: (url, filters) => pool.query(url, filters as never),
        publish: (url, event) => pool.publish(url, event),
        fetch,
        crypto: phoneCrypto,
        readStaged,
        stage: stageBlob,
        spoken: (hash) => {
          const md = textFiles.readText(hash);
          return md === null ? null : deriveArticle(md).spoken;
        },
        collect: async (owner, signer) => void (await syncOwner(syncPorts(), owner, signer)),
        runOutbox,
        drainSourceInbox: async () => void (await drainInbox({
          db: store(), now: () => Math.floor(Date.now() / 1000), signer: source,
          query: (url, filters) => pool.query(url, filters as never), fetch,
          markdown: (html, u) => KefliParser.markdown(html, u) as Promise<ParserResult>, defaults: loadDefaults, ...parserPorts(),
        }, job.from)),
        retireKeys: () => retireSourceKeys(job.from, job.to),
        report: (n, m) => moveListeners.forEach((l) => l(n, m)),
      }, job);
      console.log(`[kefli-move] ${JSON.stringify({ outcome: r, step: moveJob(store())?.step ?? 'done' })}`);
      if (r === 'done') {
        // the key file now starts with T, the signer every later call reads
        setCurrentSigner(null);
        doneListeners.forEach((l) => l(job.to));
      }
      return r;
    } finally {
      moving = null;
    }
  })();
  return moving;
}

/**
 * The app's sync triggers (4.5): start and each return to the foreground, always after the launch resolver,
 * so a sync never runs before Block Store's key is adopted. Returns the cleanup, for useEffect.
 */
export function startSync(): () => void {
  const log = (tag: string, v: unknown) => console.log(`[kefli-${tag}] ${JSON.stringify(v)}`);
  const sync = () =>
    launchPlan()
      .catch(() => null)
      // shares a killed process left in the spool are saved before the sync sends them (8.5)
      .then(() => pickUpSpools().then((n) => n && log('pickup', { saved: n })).catch((e) => log('pickup', { error: String((e as Error).message) })))
      .then(runSync)
      .then(async (r) => log('sync', { owner: (await currentSigner())?.pubkey().slice(0, 12), ...r }))
      // an earlier sign-in with a nostr app is checked at most once a day, out of sight (FD 104)
      .then(() => dailyCheck().catch((e) => log('nostr-check', { error: String((e as Error).message) })))
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
    page: phonePagePorts(),
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
        markdown: (html, u) => KefliParser.markdown(html, u) as Promise<ParserResult>,
        defaults: loadDefaults,
        ...parserPorts(),
      }, owner);
      console.log(`[kefli-inbox] ${JSON.stringify(r)}`);
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
 * While Kefli is in front, a live subscription on the operator relay (4.7) drains the inbox within a second of a
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

/** Add another device's ports (5.8): the user's key signs the offer, which carries the mnemonic from the key file. */
export function phonePorts(owner: string): ShowPorts {
  return { ...connectPorts(owner), mnemonic: () => KefliKeystore.readMnemonic(owner).catch(() => null) };
}

/** Advanced's relay rows (5.8, FD 76): each relay in the identity's 10002, answering or not. */
export async function relayStatus(url: string): Promise<boolean> {
  return pool.relay(url).then(() => true, () => false);
}

/** Add a relay's ports (FD 113): the pool connects and publishes the check. */
export function addRelayPorts(): AddRelayPorts {
  return {
    db: store(), now: () => Math.floor(Date.now() / 1000), defaults: loadDefaults,
    connect: (url) => pool.relay(url), publish: (url, event) => pool.publish(url, event),
  };
}
