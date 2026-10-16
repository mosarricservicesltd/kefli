// The background worker (mobile spec 4.8, FD 116, FD 119): one expo-background-task, through WorkManager, runs the
// foreground's one sync about every 15 minutes with Kefli closed, so saves, the inbox and retries move and Advanced's
// "Kefli keeps trying until a backup server accepts it" is true as written. No foreground service runs for it and
// the battery-optimisation exemption is never asked for (FD 15): Android decides when, on a connected network and
// with battery to spare, and never while Kefli is in front (the library reschedules instead). The task is defined
// once, in the global scope (index.ts), since a run with Kefli closed starts the bundle, runs the task and stops
// without mounting a view; it is registered while the phone has a library and unregistered when the library goes
// (Delete my data, Sign out: app.ts keepBackgroundSync on each root change), so a phone with no library runs nothing,
// and a run that finds no library unregisters itself. WorkManager's WAKE_LOCK and RECEIVE_BOOT_COMPLETED are removed
// from the manifest (plugins/with-kefli-security.js): neither is used on the JobScheduler path, and after a reboot
// the worker is back at Kefli's next open, when WorkManager reconciles its jobs.
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

/** The task's name, the same in the registration, the definition and WorkManager's record. */
export const BACKGROUND_SYNC = 'kefli-background-sync';
/** The minimum WorkManager allows, in minutes; Android treats it as the least delay between runs, never a schedule. */
export const BACKGROUND_SYNC_MINUTES = 15;

export type BackgroundPorts = {
  /** The foreground's one sync (runner.ts syncOnce). */
  sync: () => Promise<unknown>;
  /** Whether the phone has a library to sync (data/library activeOwner). */
  hasLibrary: () => boolean;
};

/** What the last run in this process did, for the gates screen (gates/BackgroundGate.tsx). */
export type BackgroundRun = { at: number; result: 'success' | 'failed' | 'no_library'; detail: string };

let last: BackgroundRun | null = null;
const listeners = new Set<() => void>();
export const lastBackgroundRun = {
  get: () => last,
  subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
};
const record = (r: BackgroundRun) => {
  last = r;
  listeners.forEach((l) => l());
};

/**
 * The task's run: the sync, Success when it ends and Failed when it throws, so WorkManager's record says which. With
 * no library the run does nothing, unregisters the task, and counts as Success, since there was nothing to do.
 */
export async function runBackgroundSync(p: BackgroundPorts, now = Date.now()): Promise<BackgroundTask.BackgroundTaskResult> {
  if (!p.hasLibrary()) {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC).catch(() => undefined);
    record({ at: now, result: 'no_library', detail: 'no library on this phone; the task unregistered itself' });
    return BackgroundTask.BackgroundTaskResult.Success;
  }
  try {
    const r = await p.sync();
    record({ at: now, result: 'success', detail: JSON.stringify(r) });
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (e) {
    record({ at: now, result: 'failed', detail: String((e as Error).message) });
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
}

/**
 * Registered while the phone has a library, at the 15-minute minimum, and unregistered when it has none: called on
 * every root change (app.ts set), so a sign-in or New here registers it and Delete my data or Sign out removes it.
 * Says what it did; a registration the library refuses is logged and left for the next root change.
 */
export async function keepBackgroundSync(hasLibrary: boolean): Promise<'registered' | 'unregistered' | 'kept'> {
  const registered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC);
  if (hasLibrary && !registered) {
    await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC, { minimumInterval: BACKGROUND_SYNC_MINUTES });
    return 'registered';
  }
  if (!hasLibrary && registered) {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC);
    return 'unregistered';
  }
  return 'kept';
}

/**
 * Defines the task, in the global scope (index.ts): the ports are read at each run, never at definition, since the
 * bundle's other modules may not have loaded yet when this is called.
 */
export function defineBackgroundSync(ports: () => BackgroundPorts): void {
  TaskManager.defineTask(BACKGROUND_SYNC, () => runBackgroundSync(ports()));
}
