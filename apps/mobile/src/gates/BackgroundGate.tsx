// The background worker's gate (mobile spec 4.8, FD 119; the local stack's build only): whether the task is
// registered, and a run of it on demand through expo-background-task's testing trigger, which runs the task only
// with Kefli in the background, so the tap waits five seconds for Home to be pressed first. The run's result, the
// sync's or its failure, shows here on return and goes to logcat under [kefli-gates].
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { BACKGROUND_SYNC, BACKGROUND_SYNC_MINUTES, lastBackgroundRun } from '../services/background';

const log = (r: unknown) => console.log(`[kefli-gates] ${JSON.stringify({ gate: 'background-worker', ...(r as object) })}`);
const WAIT_MS = 5_000;

export function BackgroundGate() {
  const [registered, setRegistered] = useState<boolean | null>(null);
  const [state, setState] = useState<'idle' | 'waiting' | 'triggered'>('idle');
  const [note, setNote] = useState('');
  const run = useSyncExternalStore(lastBackgroundRun.subscribe, lastBackgroundRun.get);
  useEffect(() => {
    TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC).then(setRegistered).catch(() => setRegistered(null));
  }, [state, run]);
  // the result arrives through lastBackgroundRun once the task has run; a trigger that returns without one ran in front
  useEffect(() => {
    if (run) log(run);
  }, [run]);
  const trigger = () => {
    setState('waiting');
    setNote(`Press Home now; the worker runs in ${WAIT_MS / 1000} s`);
    const before = lastBackgroundRun.get();
    setTimeout(async () => {
      try {
        const ok = await BackgroundTask.triggerTaskWorkerForTestingAsync();
        const ran = lastBackgroundRun.get() !== before;
        setNote(ran ? 'Ran' : ok ? 'Triggered, but Kefli was still in front, so the library scheduled a run instead of running one' : 'The trigger returned false');
        log({ triggered: ok, ran });
      } catch (e) {
        setNote(`Trigger failed: ${String((e as Error).message)}`);
        log({ error: String((e as Error).message) });
      }
      setState('triggered');
    }, WAIT_MS);
  };
  return (
    <View style={s.gate}>
      <Text style={s.h3}>Background worker</Text>
      <Text style={s.meta}>
        {registered === null ? 'Registration unknown' : registered ? `Registered, at least ${BACKGROUND_SYNC_MINUTES} minutes apart` : 'Not registered (no library on this phone)'}
      </Text>
      <Pressable onPress={trigger} disabled={state === 'waiting'} style={[s.btn, state === 'waiting' && s.off]}>
        <Text style={s.btnText}>{state === 'waiting' ? 'Waiting…' : 'Run the worker in 5 s (press Home)'}</Text>
      </Pressable>
      {!!note && <Text style={s.meta}>{note}</Text>}
      {run && (
        <Text style={run.result === 'failed' ? s.fail : s.meta}>
          Last run {new Date(run.at).toLocaleTimeString()}: {run.result} {run.detail}
        </Text>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  gate: { gap: 6, marginTop: 16 },
  h3: { fontSize: 15, fontWeight: '600' },
  meta: { fontSize: 13, color: '#5C5B56' },
  fail: { fontSize: 13, color: '#B42318' },
  btn: { backgroundColor: '#17171A', borderRadius: 12, paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  btnText: { color: '#F3F2EE', fontSize: 15, fontWeight: '600' },
  off: { opacity: 0.5 },
});
