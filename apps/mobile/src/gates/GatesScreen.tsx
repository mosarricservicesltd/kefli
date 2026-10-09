// Week-0 gates (mobile spec 12) on one screen. "Run all" runs the JavaScript gates and logs each result to
// logcat under [kefli-gates]; below them, eight covers drawn by Skia and every static font cut, for the eye.

import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Canvas, ImageSVG, Skia } from '@shopify/react-native-skia';
import { useFonts } from 'expo-font';
import { FONTS } from '../ui/fonts';
import { GATES, runGate, type GateResult } from './gates';
import { VoiceGate } from './VoiceGate';
import { IdentityGate } from './IdentityGate';

/* eslint-disable @typescript-eslint/no-require-imports */
const ShelfCover = require('../../../../shared/cover/cover-v1.js');
const COVERS: { id: string; hash: string }[] = require('../../../../shared/cover/fixtures.json').cases.slice(0, 8);

/* eslint-enable @typescript-eslint/no-require-imports */

const log = (r: unknown) => console.log(`[kefli-gates] ${JSON.stringify(r)}`);
const SIZE = 80;

function Covers() {
  const [ms, setMs] = useState<number | null>(null);
  const svgs = useMemo(() => {
    const t = Date.now();
    const out = COVERS.map((c) => Skia.SVG.MakeFromString(ShelfCover.svg(c.hash, { size: SIZE, depth: 3 })));
    setTimeout(() => setMs(Date.now() - t), 0);
    return out;
  }, []);
  useEffect(() => {
    if (ms !== null) log({ id: 'skia-covers', ok: svgs.every(Boolean), detail: `8 covers parsed in ${ms} ms`, ms });
  }, [ms, svgs]);
  return (
    <View>
      <Text style={s.h2}>Eight covers, Skia, depth 3</Text>
      <View style={s.covers}>
        {svgs.map((svg, i) => (
          <Canvas key={COVERS[i].id} style={{ width: SIZE, height: SIZE }}>
            {svg && <ImageSVG svg={svg} x={0} y={0} width={SIZE} height={SIZE} />}
          </Canvas>
        ))}
      </View>
      <Text style={s.meta}>{ms === null ? 'Drawing…' : `${svgs.filter(Boolean).length} of 8 parsed in ${ms} ms`}</Text>
    </View>
  );
}

function Fonts() {
  const [loaded, error] = useFonts(FONTS);
  useEffect(() => {
    if (loaded || error) log({ id: 'fonts', ok: loaded && !error, detail: error ? String(error) : `${Object.keys(FONTS).length} cuts loaded`, ms: 0 });
  }, [loaded, error]);
  if (error) return <Text style={s.fail}>Fonts failed: {String(error)}</Text>;
  if (!loaded) return <Text style={s.meta}>Loading fonts…</Text>;
  return (
    <View>
      <Text style={s.h2}>Fifteen font cuts</Text>
      {Object.keys(FONTS).map((f) => (
        <Text key={f} style={{ fontFamily: f, fontSize: f.startsWith('Literata-32') ? 32 : 17, marginVertical: 2 }}>
          {f.startsWith('MartianMono') ? '2:00 / 5:52' : `Saves ${f}`}
        </Text>
      ))}
      <Text style={s.meta}>Capital centring in a filled button (CS Components):</Text>
      <View style={s.row}>
        {['Archivo-600', 'Archivo-650', 'ArchivoExpanded-750'].map((f) => (
          <View key={f} style={s.btn}>
            <Text style={{ fontFamily: f, fontSize: 15, color: '#F3F2EE', lineHeight: 15 * 1.45 }}>SAVE Hg</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

export function GatesScreen() {
  const [results, setResults] = useState<Record<string, GateResult>>({});
  const [busy, setBusy] = useState(false);
  const runAll = async () => {
    setBusy(true);
    setResults({});
    for (const g of GATES) {
      const r = await runGate(g);
      log(r);
      setResults((prev) => ({ ...prev, [g.id]: r }));
      await new Promise((ok) => setTimeout(ok, 30));
    }
    setBusy(false);
  };
  const done = Object.values(results);
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Pressable onPress={runAll} disabled={busy} style={[s.btn, busy && s.off]}>
        <Text style={s.btnText}>{busy ? 'Running…' : 'Run all'}</Text>
      </Pressable>
      {done.length > 0 && (
        <Text style={s.meta}>
          {done.filter((r) => r.ok).length} of {GATES.length} passed
        </Text>
      )}
      {GATES.map((g) => {
        const r = results[g.id];
        return (
          <View key={g.id} style={s.gate}>
            <Text style={s.h3}>
              {r ? (r.ok ? '✓ ' : '✗ ') : '· '}
              {g.title}
            </Text>
            {r && <Text style={r.ok ? s.meta : s.fail}>{r.detail}</Text>}
          </View>
        );
      })}
      <IdentityGate />
      <VoiceGate />
      <Covers />
      <Fonts />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  page: { padding: 20, gap: 12, paddingBottom: 60 },
  h2: { fontSize: 17, fontWeight: '600', marginTop: 16, marginBottom: 8 },
  h3: { fontSize: 15, fontWeight: '600' },
  meta: { fontSize: 13, color: '#5C5B56' },
  fail: { fontSize: 13, color: '#B42318' },
  gate: { gap: 2 },
  covers: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  row: { flexDirection: 'row', gap: 8, marginTop: 8 },
  btn: { backgroundColor: '#17171A', borderRadius: 12, paddingHorizontal: 16, height: 44, alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-start' },
  btnText: { color: '#F3F2EE', fontSize: 15, fontWeight: '600' },
  off: { opacity: 0.5 },
});
