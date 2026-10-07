// The share surface for the week-0 gate (mobile spec 8.5): what arrived, how long it took to reach the screen,
// and the two ways out. Done (or the 4 s countdown) returns to the app shared from; Read now also opens
// Shelf on the Reader (flow decision 39). Shelf's real share sheet replaces this in week 1.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { itemHash } from '@shelf/protocol';
import { motion } from '@shelf/tokens';
import { ShelfShare } from '../../modules/shelf-share/src';

const log = (r: unknown) => console.log(`[shelf-gates] ${JSON.stringify(r)}`);

function firstLink(text: string | null): string | null {
  const all = text?.match(/https?:\/\/[^\s<>"]+/g) ?? [];
  return all.length ? all[all.length - 1] : null;
}

export default function ShareRoot({ spoolId }: { spoolId?: string }) {
  const entry = useMemo(() => (spoolId ? ShelfShare.read(spoolId) : null), [spoolId]);
  const url = firstLink(entry?.text ?? null);
  const hash = useMemo(() => {
    try {
      return url ? itemHash(url) : null;
    } catch {
      return null;
    }
  }, [url]);
  const [left, setLeft] = useState<number>(motion.countdown.share);
  const done = useRef(false);

  const finish = (mode: 'host' | 'read') => {
    if (done.current) return;
    done.current = true;
    if (spoolId) ShelfShare.deleteSpool(spoolId);
    log({ id: 'share-finish', ok: true, detail: mode, ms: 0 });
    ShelfShare.finish(mode, mode === 'read' ? hash : null);
  };

  useEffect(() => {
    const shownMs = entry ? Date.now() - entry.receivedAt : -1;
    log({ id: 'share-activity', ok: !!entry, detail: entry ? `spooled to first render ${shownMs} ms; referrer ${entry.referrer}; link ${url ? 'found' : 'none'}; ${ShelfShare.listSpools().length} spool(s) waiting` : `no spool for ${spoolId}`, ms: shownMs });
    const t = setInterval(() => setLeft((l) => l - 100), 100);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (left <= 0) finish('host');
  }, [left]);

  return (
    <View style={s.scrim}>
      <View style={s.card}>
        <Text style={s.title}>{url ? 'Saved to Shelf' : 'Nothing to save'}</Text>
        <Text style={s.meta} numberOfLines={2}>
          {url ?? entry?.text ?? 'The share carried no text.'}
        </Text>
        {hash && <Text style={s.meta}>d: shelf/item/{hash.slice(0, 16)}…</Text>}
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
