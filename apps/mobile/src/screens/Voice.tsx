// Voice (mobile spec 5.8, FD 24, FD 36, FD 89, FD 109; prototype voice, voice-langs): a chip per language, the phone's
// own first and then those among the saves, drawn with two or more; the chosen language's offline voices as radios,
// each with a sample played outside the session, picking one for that language only; Default speed, the one speed
// value; the note on adding voices. The sample's play glyph becomes the equaliser while it plays. Loading is a
// momentary read, so it shows nothing; the screen is the same offline. You has no row to open it while no language
// has two voices.
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
import { choiceFor, chosen, langName, lastPlayedIn, libraryLangs, named, voiceKeyFor, voiceLangs, voicesFor, type Named } from '../voice/choice';
import { RATES, rateLabel, readRate } from '../voice/clock';
import { Segment } from '../ui/Segment';
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

export type VoiceLang = { lang: string; name: string; voices: Named[]; chosen: Named | null };

/** The languages and their voices that the screen and You's row show, rechecked whenever either comes into view. */
export function useVoiceLangs(owner: string): VoiceLang[] {
  const [all, setAll] = useState<{ voices: PhoneVoice[]; defaultLocale: string | null }>({ voices: [], defaultLocale: null });
  useFocusEffect(useCallback(() => {
    let live = true;
    listPhoneVoices(true).then((r) => live && setAll(r));
    return () => {
      live = false;
    };
  }, []));
  const library = useLive(() => (owner ? libraryLangs(store(), owner) : []), ['items'], [owner]);
  // a string, so useLive sees the same value while nothing changed
  const picks = useLive(() => JSON.stringify(store().all<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key LIKE 'voice.id%'")), ['settings'], []);
  const get = (k: string) => (JSON.parse(picks) as { key: string; value: string }[]).find((r) => r.key === k)?.value ?? null;
  return voiceLangs(all.voices, all.defaultLocale, library).map((lang) => {
    const voices = named(voicesFor(all.voices, lang, all.defaultLocale), S.voice.short);
    return { lang, name: langName(all.voices, lang), voices, chosen: chosen(voices, choiceFor(get, all.voices, lang)) };
  });
}

/** The opening of the last article played in this voice's language, for its sample, else the sample line. */
function sampleText(owner: string, lang: string): string {
  const hash = owner ? lastPlayedIn(store(), owner, lang) : null;
  const first = hash ? textFiles.readArticle(hash)?.sentences[0]?.text : undefined;
  return first && first.length > 12 ? first.slice(0, 200) : S.voice.sampleLine;
}

export default function Voice() {
  const { c } = useTheme();
  const owner = useApp()?.owner ?? '';
  const langs = useVoiceLangs(owner);
  const rate = useLive(() => readRate(getSetting(store(), 'voice.speed')), ['settings'], []);
  const [sampling, setSampling] = useState<string | null>(null);
  const [langPick, setLangPick] = useState<string | null>(null);
  const shown = langs.find((l) => l.lang === langPick) ?? langs[0];

  const sample = (v: Named) => {
    setSampling(v.id);
    playSample(v.id, sampleText(owner, v.locale)).finally(() => setSampling((s) => (s === v.id ? null : s)));
  };
  const step = (d: -1 | 1) => {
    const i = (RATES as readonly number[]).indexOf(rate);
    setDefaultRate(RATES[Math.max(0, Math.min(RATES.length - 1, (i < 0 ? 1 : i) + d))]);
  };

  return (
    <OnbShell title={S.voice.title}>
      <T muted style={[ui(15, 'body', 1.45), { marginBottom: 24 }]}>{S.voice.lead}</T>
      {langs.length > 1 && (
        <View accessibilityRole="tablist" accessibilityLabel={S.voice.language} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
          {langs.map((l) => <Segment key={l.lang} label={l.name} on={l.lang === shown?.lang} onPress={() => setLangPick(l.lang)} />)}
        </View>
      )}
      {shown && (
        <View accessibilityRole="radiogroup" accessibilityLabel={S.voice.voiceFor(shown.name)}
          style={{ marginBottom: 20, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
          {shown.voices.map((v, i) => (
            <VoiceRow key={v.id} v={v} first={i === 0} on={shown.chosen?.id === v.id} sampling={sampling === v.id}
              pick={() => setSetting(store(), voiceKeyFor(shown.lang), v.id)} sample={() => sample(v)} />
          ))}
        </View>
      )}
      <View style={{ marginBottom: 8, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
        <Stepper rate={rate} step={step} />
      </View>
      <T muted style={ui(13, 'body', 1.45)}>{S.voice.note}</T>
    </OnbShell>
  );
}
