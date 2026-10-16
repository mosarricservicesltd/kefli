// The background worker (mobile spec 4.8, FD 119): registered while the phone has a library, at the 15-minute
// minimum, unregistered when the library goes, and its run the foreground's one sync, reported to WorkManager as
// Success or Failed. The two Expo libraries are mocked; the phone runs them.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

type Mock = { registered: Set<string>; calls: string[]; defined: Record<string, () => Promise<unknown>>; refuse?: string };
const mock: Mock = { registered: new Set(), calls: [], defined: {} };

jest.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  BackgroundTaskStatus: { Restricted: 1, Available: 2 },
  registerTaskAsync: async (name: string, options: { minimumInterval?: number }) => {
    mock.calls.push(`register ${name} ${JSON.stringify(options)}`);
    if (mock.refuse) throw new Error(mock.refuse);
    mock.registered.add(name);
  },
  unregisterTaskAsync: async (name: string) => {
    mock.calls.push(`unregister ${name}`);
    mock.registered.delete(name);
  },
  triggerTaskWorkerForTestingAsync: async () => true,
}), { virtual: true });
jest.mock('expo-task-manager', () => ({
  defineTask: (name: string, executor: () => Promise<unknown>) => {
    mock.calls.push(`define ${name}`);
    mock.defined[name] = executor;
  },
  isTaskRegisteredAsync: async (name: string) => mock.registered.has(name),
}), { virtual: true });

// eslint-disable-next-line @typescript-eslint/no-require-imports
const bg = require('../src/services/background') as typeof import('../src/services/background');
const { BACKGROUND_SYNC, BACKGROUND_SYNC_MINUTES, defineBackgroundSync, keepBackgroundSync, lastBackgroundRun, runBackgroundSync } = bg;

beforeEach(() => {
  mock.registered.clear();
  mock.calls.length = 0;
  mock.refuse = undefined;
});

describe('registration follows the library (4.8)', () => {
  test('a phone with a library registers the task once, at the 15-minute minimum', async () => {
    expect(BACKGROUND_SYNC_MINUTES).toBe(15);
    expect(await keepBackgroundSync(true)).toBe('registered');
    expect(mock.calls).toEqual([`register ${BACKGROUND_SYNC} {"minimumInterval":15}`]);
    // the next root change finds it registered and leaves it
    expect(await keepBackgroundSync(true)).toBe('kept');
    expect(mock.calls).toHaveLength(1);
  });

  test('a phone whose library has gone (Delete my data, Sign out) unregisters it, and one that never had one registers nothing', async () => {
    await keepBackgroundSync(true);
    expect(await keepBackgroundSync(false)).toBe('unregistered');
    expect(mock.registered.size).toBe(0);
    expect(mock.calls).toEqual([`register ${BACKGROUND_SYNC} {"minimumInterval":15}`, `unregister ${BACKGROUND_SYNC}`]);
    expect(await keepBackgroundSync(false)).toBe('kept');
    expect(mock.calls).toHaveLength(2);
  });

  test('a registration the library refuses throws to the caller, which logs it and leaves it for the next root change', async () => {
    mock.refuse = 'WorkManager not initialised';
    await expect(keepBackgroundSync(true)).rejects.toThrow('WorkManager not initialised');
    expect(mock.registered.size).toBe(0);
  });
});

describe("the task's run (4.8)", () => {
  const ports = (sync: () => Promise<unknown>, hasLibrary = true) => ({ sync, hasLibrary: () => hasLibrary });

  test('the sync that ends is Success, and the run is recorded for the gate', async () => {
    const seen: string[] = [];
    const off = lastBackgroundRun.subscribe(() => seen.push(lastBackgroundRun.get()!.result));
    expect(await runBackgroundSync(ports(async () => ({ events: 3, waiting: 0 })), 1_700_000_000_000)).toBe(1);
    expect(lastBackgroundRun.get()).toEqual({ at: 1_700_000_000_000, result: 'success', detail: '{"events":3,"waiting":0}' });
    expect(seen).toEqual(['success']);
    off();
  });

  test('a sync that throws is Failed, with why', async () => {
    expect(await runBackgroundSync(ports(async () => { throw new Error('relay refused'); }), 5)).toBe(2);
    expect(lastBackgroundRun.get()).toEqual({ at: 5, result: 'failed', detail: 'relay refused' });
  });

  test('a run with no library on the phone syncs nothing, unregisters the task and counts as Success', async () => {
    mock.registered.add(BACKGROUND_SYNC);
    let synced = 0;
    expect(await runBackgroundSync(ports(async () => { synced++; }, false), 9)).toBe(1);
    expect(synced).toBe(0);
    expect(mock.registered.size).toBe(0);
    expect(lastBackgroundRun.get()?.result).toBe('no_library');
  });

  test('the definition names the task and reads its ports at each run, never at definition', async () => {
    let made = 0;
    defineBackgroundSync(() => (made++, ports(async () => 'ran')));
    expect(mock.calls).toEqual([`define ${BACKGROUND_SYNC}`]);
    expect(made).toBe(0);
    expect(await mock.defined[BACKGROUND_SYNC]()).toBe(1);
    expect(made).toBe(1);
    expect(lastBackgroundRun.get()?.detail).toBe('"ran"');
  });
});

describe('the wiring on the phone (read from the source, as Node runs none of it)', () => {
  const src = (...p: string[]) => readFileSync(join(__dirname, '..', ...p), 'utf8');

  test('the task is defined in the global scope of the bundle, index.ts, with the runner\'s ports read at each run', () => {
    const index = src('index.ts');
    expect(index).toContain("import { defineBackgroundSync } from './src/services/background';");
    expect(index).toContain('defineBackgroundSync(backgroundPorts);');
    // before the router's entry, which mounts nothing in a headless run
    expect(index.indexOf('defineBackgroundSync(backgroundPorts);')).toBeLessThan(index.indexOf("import 'expo-router/entry';"));
    const runner = src('src', 'services', 'runner.ts');
    expect(runner).toContain("return { sync: () => syncOnce(), hasLibrary: () => activeOwner(store()) !== null };");
    // the foreground's own sync is the same function
    expect(runner).toMatch(/const sync = \(\) =>\s+syncOnce\(log\)/);
  });

  test('every root change keeps the registration in step with the library, so Delete my data and Sign out end it', () => {
    const app = src('src', 'services', 'app.ts');
    const set = app.slice(app.indexOf('const set = (s: AppState) => {'), app.indexOf('export function useApp'));
    expect(set).toContain('keepBackgroundSync(s.owner !== null)');
    expect(app).toContain("export function answerDeleted(): void {\n  set({ route: 'welcome', owner: null, restoreCard: false });");
    // Sign out ends at the same place
    expect(src('src', 'screens', 'NostrApp.tsx')).toMatch(/await signOut\(\);[\s\S]*?answerDeleted\(\);/);
  });

  test("the gate waits for Home before the trigger, since the library runs no task in front", () => {
    const gate = src('src', 'gates', 'BackgroundGate.tsx');
    expect(gate).toContain('BackgroundTask.triggerTaskWorkerForTestingAsync()');
    expect(gate).toMatch(/setTimeout\(async \(\) => \{[\s\S]*triggerTaskWorkerForTestingAsync[\s\S]*\}, WAIT_MS\);/);
    expect(src('src', 'gates', 'GatesScreen.tsx')).toContain('<BackgroundGate />');
  });
});
