// Voice (mobile spec 5.8, FD 24, FD 36, FD 89; prototype voice): the phone's offline voices for the language of the
// last article played, as radios, each with a sample played outside the session; Default speed, the one speed value;
// the note on adding voices. The sample's play glyph becomes the equaliser while it plays. Loading is a momentary
// read, so it shows nothing; the screen is the same offline. With fewer than two voices You has no row to open it.
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { motion, radius } from '@kefli/tokens';
import { ambient, quickIn } from '@kefli/tokens/reanimated';
import type { PhoneVoice } from '../../modules/kefli-voice/src';
import { getSetting, setSetting } from '../data/settings';
import { useApp } from '../services/app';
import { store } from '../services/store';
import { textFiles } from '../services/textFiles';
import { listPhoneVoices, playSample, setDefaultRate } from '../services/voice';
import { Icon } from '../ui/Icon';
import { useLive } from '../ui/live';
import { Press, pressLayer } from '../ui/Press';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { useTheme } from '../ui/theme';
import { VOICE_ID, chosen, lastPlayedLang, languageOf, named, voicesFor, type Named } from '../voice/choice';
import { RATES, rateLabel, readRate } from '../voice/clock';
import { OnbShell } from './Onb';

/** One equaliser bar on scaleY from the bottom (motion.ambient.eq); still under reduced motion. */
function Bar({ color, delay }: { color: string; delay: number }) {
  const y = useSharedValue(0.5);
  const still = useReducedMotion();
  useEffect(() => {
    if (still) return;
    y.value = 0.34;
    y.value = withDelay(delay, withRepeat(withSequence(withTiming(1, ambient.eq), withTiming(0.34, ambient.eq)), -1));
  }, [y, delay, still]);
  const st = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - y.value) * 6 }, { scaleY: y.value }] }));
  return <Animated.View style={[{ width: 3, height: 12, borderRadius: 1, backgroundColor: color }, st]} />;
}

function Equaliser({ color }: { color: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 12 }}>
      {[0, 1, 2].map((i) => <Bar key={i} color={color} delay={i * motion.ambient.breathe.phase} />)}
    </View>
  );
}

function Radio({ on }: { on: boolean }) {
  const { c } = useTheme();
  const o = useSharedValue(on ? 1 : 0);
  useEffect(() => {
    o.value = withTiming(on ? 1 : 0, quickIn);
  }, [on, o]);
  const sel = useAnimatedStyle(() => ({ opacity: o.value }));
  return (
    <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: c.muted }}>
      <Animated.View style={[{ position: 'absolute', top: -2, left: -2, right: -2, bottom: -2, borderRadius: 11, borderWidth: 2, borderColor: c.fill, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center' }, sel]}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: c.fill }} />
      </Animated.View>
    </View>
  );
}

function VoiceRow({ v, on, first, sampling, pick, sample }: { v: Named; on: boolean; first: boolean; sampling: boolean; pick: () => void; sample: () => void }) {
  const { c } = useTheme();
  return (
    <View style={{ minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingLeft: 16, paddingRight: 8 }}>
      {!first && <View style={{ position: 'absolute', left: 50, right: 0, top: 0, height: 1, backgroundColor: c.line }} />}
      <Press accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={v.label} onPress={pick} layer={pressLayer(c.text)}
        style={{ flex: 1, minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Radio on={on} />
        <T style={[ui(15, 'label', 1.3), { flex: 1 }]}>{v.label}</T>
      </Press>
      <Press accessibilityRole="button" accessibilityLabel={S.voice.sampleOf(v.label)} onPress={sample} layer={pressLayer(c.text)}
        style={{ width: 48, height: 48, borderRadius: radius.button, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
        {sampling ? <Equaliser color={c.text} /> : <Icon name="play" size={16} color={c.text} solid />}
      </Press>
    </View>
  );
}

function Stepper({ rate, step }: { rate: number; step: (d: -1 | 1) => void }) {
  const { c } = useTheme();
  const i = (RATES as readonly number[]).indexOf(rate);
  const btn = (d: -1 | 1, label: string, glyph: string, off: boolean) => (
    <Press accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: off }} disabled={off} onPress={() => step(d)} layer={pressLayer(c.text)}
      style={{ width: 48, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center', opacity: off ? 0.45 : 1 }}>
      <T style={ui(20, 'meta', 1)}>{glyph}</T>
    </Press>
  );
  return (
    <View style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, paddingLeft: 16, paddingRight: 8 }}>
      <T style={ui(15, 'meta', 1.3)}>{S.voice.defaultSpeed}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', height: 48, borderRadius: radius.button, backgroundColor: c.background }}>
        {btn(-1, S.voice.slower, '−', i <= 0)}
        <T accessibilityLiveRegion="polite" style={[ui(15, 'title', 1.2), { minWidth: 48, textAlign: 'center', fontVariant: ['tabular-nums'] }]}>{rateLabel(rate)}</T>
        {btn(1, S.voice.faster, '+', i >= RATES.length - 1)}
      </View>
    </View>
  );
}

/** The voices the screen and You's row show, rechecked whenever either comes into view. */
export function usePhoneVoices(owner: string): { voices: Named[]; lang: string | null } {
  const [all, setAll] = useState<{ voices: PhoneVoice[]; defaultLocale: string | null }>({ voices: [], defaultLocale: null });
  useFocusEffect(useCallback(() => {
    let live = true;
    listPhoneVoices(true).then((r) => live && setAll(r));
    return () => {
      live = false;
    };
  }, []));
  const played = useLive(() => (owner ? lastPlayedLang(store(), owner) : null), ['listen_history', 'items'], [owner]);
  const lang = played ?? all.defaultLocale;
  return { voices: named(voicesFor(all.voices, lang, all.defaultLocale), S.voice.short), lang };
}

/** The opening of the last article played, for samples in its language. */
function sampleText(owner: string, lang: string | null, voice: Named): string {
  const hash = owner ? store().get<{ hash: string }>(
    'SELECT i.hash FROM listen_history h JOIN items i ON i.id = h.item WHERE i.owner = ? ORDER BY h.last_played_at DESC LIMIT 1', owner)?.hash : undefined;
  const first = hash && languageOf(lang) === languageOf(voice.locale) ? textFiles.readArticle(hash)?.sentences[0]?.text : undefined;
  return first && first.length > 12 ? first.slice(0, 200) : S.voice.sampleLine;
}

export default function Voice() {
  const { c } = useTheme();
  const owner = useApp()?.owner ?? '';
  const { voices, lang } = usePhoneVoices(owner);
  const id = useLive(() => getSetting(store(), VOICE_ID), ['settings'], []);
  const rate = useLive(() => readRate(getSetting(store(), 'voice.speed')), ['settings'], []);
  const [sampling, setSampling] = useState<string | null>(null);
  const current = chosen(voices, id);

  const sample = (v: Named) => {
    setSampling(v.id);
    playSample(v.id, sampleText(owner, lang, v)).finally(() => setSampling((s) => (s === v.id ? null : s)));
  };
  const step = (d: -1 | 1) => {
    const i = (RATES as readonly number[]).indexOf(rate);
    setDefaultRate(RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 1 : i) + d))]);
  };

  return (
    <OnbShell title={S.voice.title}>
      <T muted style={[ui(15, 'body', 1.45), { marginBottom: 24 }]}>{S.voice.lead}</T>
      <View accessibilityRole="radiogroup" accessibilityLabel={S.voice.title}
        style={{ marginBottom: 20, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
        {voices.map((v, i) => (
          <VoiceRow key={v.id} v={v} first={i === 0} on={current?.id === v.id} sampling={sampling === v.id}
            pick={() => setSetting(store(), VOICE_ID, v.id)} sample={() => sample(v)} />
        ))}
      </View>
      <View style={{ marginBottom: 8, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
        <Stepper rate={rate} step={step} />
      </View>
      <T muted style={ui(13, 'body', 1.45)}>{S.voice.note}</T>
    </OnbShell>
  );
}
