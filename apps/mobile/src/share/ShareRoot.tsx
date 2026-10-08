// The share surface for the week-0 gate (mobile spec 8.5): what arrived, how long it took to reach the screen,
// and the two ways out. Done (or the 4 s countdown) returns to the app shared from; Read now also opens
// Shelf on the Reader (flow decision 39). Shelf's real share sheet replaces this in week 1.
import { useEffect, useMemo, useRef, useState } from 'react';
import { saveLink, type SaveStep } from '../services/save';
import { release } from '../data/outbox';
import { runOutbox } from '../services/runner';
import { store } from '../services/store';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { itemHash } from '@shelf/protocol';
import { motion } from '@shelf/tokens';
import { ShelfShare } from '../../modules/shelf-share/src';
import { activeSpools, firstLink } from './pickup';

const log = (r: unknown) => console.log(`[shelf-gates] ${JSON.stringify(r)}`);


export default function ShareRoot({ spoolId }: { spoolId?: string }) {
  const entry = useMemo(() => (spoolId ? ShelfShare.read(spoolId) : null), [spoolId]);
  // this sheet's spool is its own; the start-up pickup leaves it alone
  useEffect(() => {
    if (!spoolId) return;
    activeSpools.add(spoolId);
    return () => void activeSpools.delete(spoolId);
  }, [spoolId]);
  const url = firstLink(entry?.text ?? null);
  const hash = useMemo(() => {
    try {
      return url ? itemHash(url) : null;
    } catch {
      return null;
    }
  }, [url]);
  const [left, setLeft] = useState<number>(motion.countdown.share);
  const [steps, setSteps] = useState<SaveStep[]>([]);
  const [saving, setSaving] = useState(true);
  const done = useRef(false);
  const held = useRef<number[]>([]);
  const unmounted = useRef(false);

  // The sheet closed without Undo: its rows go to the queue and the outbox starts sending.
  const releaseHeld = () => {
    if (!held.current.length) return;
    release(store(), held.current);
    held.current = [];
    runOutbox()
      .then((n) => console.log(`[shelf-save] ${JSON.stringify({ step: 'sent', ok: true, detail: `${n} outbox rows sent` })}`))
      .catch((e) => console.log(`[shelf-save] ${JSON.stringify({ step: 'sent', ok: false, detail: String((e as Error).message) })}`));
  };

  // A sheet that ends without closing (its activity destroyed) counts as closed without Undo.
  useEffect(() => () => {
    unmounted.current = true;
    if (!done.current) releaseHeld();
  }, []);

  // The spool goes once the save is written; until then a process that dies leaves it for the start-up pickup.
  const saved = useRef(false);
  const dropSpool = () => {
    if (spoolId && saved.current && done.current) ShelfShare.deleteSpool(spoolId);
  };

  const finish = (mode: 'host' | 'read') => {
    if (done.current) return;
    done.current = true;
    dropSpool();
    releaseHeld();
    log({ id: 'share-finish', ok: true, detail: mode, ms: 0 });
    ShelfShare.finish(mode, mode === 'read' ? hash : null);
  };

  useEffect(() => {
    const shownMs = entry ? Date.now() - entry.receivedAt : -1;
    log({ id: 'share-activity', ok: !!entry, detail: entry ? `spooled to first render ${shownMs} ms; referrer ${entry.referrer}; link ${url ? 'found' : 'none'}; ${ShelfShare.listSpools().length} spool(s) waiting` : `no spool for ${spoolId}`, ms: shownMs });
    if (!url) {
      setSaving(false);
      return;
    }
    // Week 1's slice: the whole save runs here, then the countdown starts.
    saveLink(url, (st) => {
      console.log(`[shelf-save] ${JSON.stringify(st)}`);
      setSteps((prev) => [...prev, st]);
    })
      .then((r) => {
        held.current = r.held;
        saved.current = true;
        dropSpool();
        // Unmounted before the save finished: release at once rather than leave the rows held.
        if (done.current || unmounted.current) releaseHeld();
        console.log(`[shelf-save] ${JSON.stringify({ step: 'done', ok: true, detail: `d shelf/item/${r.hash}, ${r.held.length} rows held` })}`);
      })
      .catch((e) => {
        console.log(`[shelf-save] ${JSON.stringify({ step: 'error', ok: false, detail: String((e as Error).message) })}`);
        setSteps((prev) => [...prev, { step: 'error', ok: false, detail: String((e as Error).message) }]);
      })
      .finally(() => setSaving(false));
  }, []);
  // RULED: a sheet that leaves the screen (locked, or another app on top) closes without Undo, since Undo can't be
  // pressed there: its rows are released and sent at once rather than waiting for a countdown that doesn't run
  // with the screen off (stage 1 gate, share then lock; mobile spec 4.8).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') finish('host');
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    if (saving) return;
    const t = setInterval(() => setLeft((l) => l - 100), 100);
    return () => clearInterval(t);
  }, [saving]);
  useEffect(() => {
    if (left <= 0) finish('host');
  }, [left]);

  return (
    <View style={s.scrim}>
      <View style={s.card}>
        <Text style={s.title}>{!url ? 'Nothing to save' : saving ? 'Saving to Shelf' : 'Saved to Shelf'}</Text>
        <Text style={s.meta} numberOfLines={2}>
          {url ?? entry?.text ?? 'The share carried no text.'}
        </Text>
        {hash && <Text style={s.meta}>d: shelf/item/{hash.slice(0, 16)}…</Text>}
        {steps.map((st, i) => (
          <Text key={i} style={[s.meta, !st.ok && { color: '#B42318' }]}>
            {st.ok ? '✓' : '✗'} {st.step}: {st.detail}
          </Text>
        ))}
        {saving && <Text style={s.meta}>Saving…</Text>}
        <View style={s.row}>
          <Pressable style={[s.btn, s.ghost]} onPress={() => finish('host')}>
            <Text style={s.ghostText}>Done</Text>
          </Pressable>
          {hash && (
            <Pressable style={s.btn} onPress={() => finish('read')}>
              <Text style={s.btnText}>Read now</Text>
            </Pressable>
          )}
        </View>
        <View style={s.track}>
          <View style={[s.fill, { width: `${Math.max(0, (left / motion.countdown.share) * 100)}%` }]} />
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  scrim: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'transparent' },
  card: { margin: 12, marginBottom: 48, padding: 20, gap: 8, borderRadius: 20, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#DEDCD5' },
  title: { fontSize: 17, fontWeight: '600', color: '#17171A' },
  meta: { fontSize: 13, color: '#5C5B56' },
  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
  btn: { height: 44, paddingHorizontal: 16, borderRadius: 12, backgroundColor: '#17171A', alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#F3F2EE', fontSize: 15, fontWeight: '600' },
  ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: '#8C8A83' },
  ghostText: { color: '#17171A', fontSize: 15 },
  track: { height: 2, backgroundColor: '#DEDCD5', marginTop: 12, overflow: 'hidden' },
  fill: { height: 2, backgroundColor: '#17171A' },
});
