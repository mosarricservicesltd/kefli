// Speed read (mobile spec 5.6, FD 21, FD 36, FD 71, MS Reader; prototype rsvp-start, rsvp, rsvp-paused, rsvp-done,
// rsvp-done-archived): one word at a time at a fixed point, its focus letter on the article's spoken-word wash and the
// ticks in its ink. It opens paused on its word; a tap starts or pauses it, and paused it shows the sentence. A
// horizontal drag moves the word a third of the finger's distance, up to 24 px, and past 40 px or 500 px/s moves one
// sentence (right: back). − and + set 200 to 700 wpm, remembered. At the end, Back to article and Archive (or Back to
// Unread), which leaves Speed read and the Reader together. It fades over the Reader, 250 ms in and 200 out, and ✕ or
// Back returns to the Reader at its word.
//
// RULED: hosted by the Reader as a full-screen layer, the only place it opens from, rather than above the navigator;
// nothing that raises a toast runs while it is open.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { FadeIn, FadeOut, runOnJS, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { fontFamily, radius, type as TY } from '@kefli/tokens';
import { release } from '@kefli/tokens/reanimated';
import type { Sentence } from '@kefli/protocol';
import type { LibRow } from '../data/library';
import { getSetting, setSetting } from '../data/settings';
import type { Block } from '../reader/blocks';
import type { ReaderColors } from '../reader/palette';
import { WPM_KEY, WPM_MAX, WPM_MIN, WPM_STEP, delay, minLeft, moveSentence, orpSplit, readWpm, sentenceAt, stream } from '../reader/rsvp';
import { store } from '../services/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { Press, pressLayer } from '../ui/Press';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { alpha } from '../ui/theme';
import { hostOf } from './SaveRow';

const WORD = TY.readerWord;

function Word({ w, P }: { w: string; P: ReaderColors }) {
  const [a, b, c] = orpSplit(w);
  // RULED: the line is 1.4 of the size, not the token's 1.1: Android crops glyphs to the line box, which cut
  // Literata's descenders off ("they"); the frame is 120 px either way
  const base = { fontFamily: fontFamily.readerWord.regular, fontSize: WORD.fontSize, lineHeight: Math.round(WORD.fontSize * 1.4), color: P.text, includeFontPadding: false };
  return (
    <View style={{ flexDirection: 'row', width: '100%', alignItems: 'center' }}>
      <T style={[base, { flex: 1, textAlign: 'right' }]} numberOfLines={1}>{a}</T>
      <View style={{ backgroundColor: P.hl, borderRadius: 3, paddingHorizontal: 2, marginHorizontal: -2 }}>
        <T style={[base, { fontFamily: fontFamily.readerWord.focus }]}>{b}</T>
      </View>
      <T style={[base, { flex: 1, textAlign: 'left' }]} numberOfLines={1}>{c}</T>
    </View>
  );
}

export function SpeedRead({ row, P, sentences, blocks, start, onExit, onArchive }: {
  row: LibRow; P: ReaderColors; sentences: Sentence[]; blocks: Pick<Block, 'firstWord' | 'words'>[]; start: number;
  /** Leaves at a word: the Reader stands at it and the position is written. */
  onExit: (word: number) => void;
  /** Archive, or Back to Unread for an archived article: leaves Speed read and the Reader together. */
  onArchive: (word: number) => void;
}) {
  const insets = useSafeAreaInsets();
  const st = useMemo(() => stream(sentences, blocks), [sentences, blocks]);
  const n = st.tokens.length;
  const [idx, setIdx] = useState(() => Math.max(0, Math.min(start, n - 1)));
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);
  const [wpm, setWpm] = useState(() => readWpm(getSetting(store(), WPM_KEY)));
  const ramp = useRef(0);
  const idxRef = useRef(idx);
  idxRef.current = idx;

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => (onExit(idxRef.current), true));
    return () => sub.remove();
  }, [onExit]);

  // each word replaces the last at the fixed point, held for its time
  useEffect(() => {
    if (!playing || done) return;
    const t = setTimeout(() => {
      if (idx >= n - 1) {
        setPlaying(false);
        setDone(true);
        return;
      }
      ramp.current++;
      setIdx(idx + 1);
    }, delay(st.tokens[idx], ramp.current, wpm));
    return () => clearTimeout(t);
  }, [playing, done, idx, wpm, n, st]);

  const toggle = () => {
    if (done) return;
    ramp.current = 0;
    setStarted(true);
    setPlaying((p) => !p);
  };
  const sentence = (dir: -1 | 1) => {
    ramp.current = 0;
    setDone(false);
    setIdx((i) => moveSentence(st, i, dir));
  };
  const stepWpm = (d: number) => {
    const next = Math.max(WPM_MIN, Math.min(WPM_MAX, wpm + d));
    ramp.current = 0;
    setWpm(next);
    setSetting(store(), WPM_KEY, String(next));
  };

  // the drag moves the word with the finger at a third of the distance, up to 24 px
  const dx = useSharedValue(0);
  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-12, 12])
    .onChange((e) => {
      dx.value = Math.max(-24, Math.min(24, e.translationX / 3));
    })
    .onEnd((e) => {
      if (e.translationX > 40 || e.velocityX > 500) {
        dx.value = 0;
        runOnJS(sentence)(-1);
      } else if (e.translationX < -40 || e.velocityX < -500) {
        dx.value = 0;
        runOnJS(sentence)(1);
      } else {
        dx.value = withSpring(0, { ...release, velocity: e.velocityX / 3 });
      }
    });
  const tap = Gesture.Tap().onEnd(() => runOnJS(toggle)());
  const wordStyle = useAnimatedStyle(() => ({ transform: [{ translateX: dx.value }] }));

  const [s0, s1] = sentenceAt(st, idx);
  const hint = playing ? S.rsvp.hintPlaying : started ? S.rsvp.hintPaused : S.rsvp.hintStart;
  const line = n > 1 ? idx / (n - 1) : 1;
  const colours = { fill: P.fill, onFill: P.onFill, bg: P.bg, text: P.text, edge: alpha(P.muted, 0.35) };
  const iconBtn = (label: string, icon: 'skipback' | 'skipfwd', onPress: () => void) => (
    <Press accessibilityRole="button" accessibilityLabel={label} onPress={onPress} layer={pressLayer(P.text, 'reader')}
      style={{ width: 48, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={24} color={P.text} />
    </Press>
  );
  const stepBtn = (label: string, glyph: string, d: number, off: boolean) => (
    <Press accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: off }} disabled={off} onPress={() => stepWpm(d)} layer={pressLayer(P.text, 'reader')}
      style={{ width: 48, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center', opacity: off ? 0.45 : 1 }}>
      <T style={[ui(20, 'meta', 1), { color: P.text }]}>{glyph}</T>
    </Press>
  );

  return (
    <Animated.View entering={FadeIn.duration(250)} exiting={FadeOut.duration(200)}
      style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 45, backgroundColor: P.bg, paddingTop: insets.top }}>
      <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8 }}>
        <Press accessibilityRole="button" accessibilityLabel={S.rsvp.exit} onPress={() => onExit(idx)} layer={pressLayer(P.text, 'reader')}
          style={{ width: 48, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="x" size={22} color={P.text} />
        </Press>
        <T style={[ui(13, 'body', 1.3), { flex: 1, textAlign: 'center', color: P.muted, fontVariant: ['tabular-nums'] }]}>{S.rsvp.minLeft(minLeft(st, idx, wpm))}</T>
        <View style={{ width: 48 }} />
      </View>
      <View style={{ height: 2, backgroundColor: alpha(P.muted, 0.2), overflow: 'hidden' }}>
        <View style={{ width: `${line * 100}%`, height: 2, backgroundColor: P.ink }} />
      </View>
      <GestureDetector gesture={Gesture.Race(pan, tap)}>
        <View accessible accessibilityRole="button" accessibilityLabel={done ? S.rsvp.doneTitle : st.tokens[idx]?.w} accessibilityHint={done ? undefined : hint}
          style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 16 }}>
          {done ? (
            <Animated.View entering={FadeIn.duration(250)} style={{ alignItems: 'center' }}>
              <T style={[ui(20, 'emptyHeading', 1.3, -0.01), { color: P.text, marginBottom: 8 }]}>{S.rsvp.doneTitle}</T>
              <T style={[ui(15, 'body', 1.45), { color: P.muted, marginBottom: 16 }]}>{S.rsvp.doneLine(row.site ?? hostOf(row.url), wpm)}</T>
              <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'center' }}>
                <Button label={S.rsvp.exit} kind="secondary" colors={colours} style={{ paddingHorizontal: 16 }} onPress={() => onExit(idx)} />
                {row.state === 'archived'
                  ? <Button label={S.rsvp.backToUnread} icon="restore" colors={colours} style={{ paddingHorizontal: 16 }} onPress={() => onArchive(idx)} />
                  : <Button label={S.rsvp.archive} icon="archive" colors={colours} style={{ paddingHorizontal: 16 }} onPress={() => onArchive(idx)} />}
              </View>
            </Animated.View>
          ) : (
            <View>
              <View style={{ height: 120, justifyContent: 'center', borderTopWidth: 1, borderBottomWidth: 1, borderColor: alpha(P.muted, 0.18) }}>
                <View style={{ position: 'absolute', top: 0, left: '50%', marginLeft: -1, width: 2, height: 14, backgroundColor: P.ink }} />
                <View style={{ position: 'absolute', bottom: 0, left: '50%', marginLeft: -1, width: 2, height: 14, backgroundColor: P.ink }} />
                <Animated.View style={wordStyle}><Word w={st.tokens[idx]?.w ?? ''} P={P} /></Animated.View>
              </View>
              <T importantForAccessibility={playing ? 'no-hide-descendants' : 'auto'}
                style={{ minHeight: 112, marginTop: 24, fontFamily: fontFamily.reader.regular, fontSize: 17, lineHeight: 25.5, color: P.muted, textAlign: 'center', opacity: playing ? 0 : 1 }}>
                {st.tokens.slice(s0, s1).map((t, k) => (s0 + k === idx
                  ? <T key={k} style={{ color: P.text, backgroundColor: P.hl }}>{t.w}</T>
                  : `${t.w}`)).flatMap((x, k) => (k ? [' ', x] : [x]))}
              </T>
              <T style={[ui(13, 'body', 1.3), { textAlign: 'center', color: P.muted, marginTop: 12 }]}>{hint}</T>
            </View>
          )}
        </View>
      </GestureDetector>
      <View style={{ alignItems: 'center', gap: 16, paddingTop: 12, paddingHorizontal: 16, paddingBottom: 24 + insets.bottom }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 24 }}>
          {iconBtn(S.rsvp.prev, 'skipback', () => sentence(-1))}
          <Press accessibilityRole="button" accessibilityLabel={playing ? S.rsvp.pause : S.rsvp.play} disabled={done} onPress={toggle} layer={pressLayer(P.onFill, 'fill')}
            style={{ width: 64, height: 64, borderRadius: 32, backgroundColor: P.fill, alignItems: 'center', justifyContent: 'center', opacity: done ? 0.45 : 1 }}>
            <Icon name={playing ? 'pause' : 'play'} size={24} color={P.onFill} solid />
          </Press>
          {iconBtn(S.rsvp.next, 'skipfwd', () => sentence(1))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', height: 48, borderRadius: radius.button }}>
          {stepBtn(S.rsvp.slower, '−', -WPM_STEP, wpm <= WPM_MIN)}
          <T accessibilityLiveRegion="polite" style={[ui(15, 'title', 1.2), { minWidth: 48, paddingHorizontal: 4, textAlign: 'center', color: P.text, fontVariant: ['tabular-nums'] }]}>{S.rsvp.wpm(wpm)}</T>
          {stepBtn(S.rsvp.faster, '+', WPM_STEP, wpm >= WPM_MAX)}
        </View>
      </View>
    </Animated.View>
  );
}
