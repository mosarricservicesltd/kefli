// Listen (mobile spec 5.7, FD 52, FD 68, FD 111, FD 115; prototype listen, listen-ready, listen-first, listen-empty,
// listen-scrolled, listen-reader, listen-cued, listen-scrub): Now playing, led by the article's 3:1 cover band, with
// the word meter's ruler, the spoken sentence's marks and the controls, always there: with no session it holds the
// article a row's body put there, else the last played article still in Unread, else the top of Unread, ready at its
// stored position. Its ruler seeks, by a tap or a sideways drag. Then Unread, the saves with their text, with Play all.
// A row's cover plays it and its body puts it in the card; the card's title opens the Reader, whose Back returns here
// (listen-reader). The mini takes over once the card has mostly scrolled away.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo, ScrollView, View, useWindowDimensions,
  type AccessibilityActionEvent, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useReducedMotion, useSharedValue } from 'react-native-reanimated';
import { router, useFocusEffect, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius } from '@kefli/tokens';
import { minutes, minutesLeft, progressOf, rowByHash, type LibRow } from '../data/library';
import { listenRows, readyRow, type Ready } from '../data/listen';
import { useApp } from '../services/app';
import {
  closeVoice, cycleRate, playAll, putInPlayer, readySession, seekStored, seekTo, skip, skipStored, toggle, toggleRow, unplayable, useVoice, type Session,
} from '../services/voice';
import { store } from '../services/store';
import { Button } from '../ui/Button';
import { Cover } from '../ui/Cover';
import { ShelfCover } from '../ui/cover';
import { Icon, type IconName } from '../ui/Icon';
import { useLive } from '../ui/live';
import { Press, pressLayer } from '../ui/Press';
import { S } from '../ui/strings';
import { T, mono13, ui } from '../ui/text';
import { setToastFloor } from '../ui/toast';
import { TAB_BAR_HEIGHT } from '../ui/TabBar';
import { alpha, useTheme } from '../ui/theme';
import { cardInView, cardOnScreen, clock, meter, positionClocks, rateLabel, ruler, seconds, sentenceOf, stepWord, wordAt } from '../voice/clock';
import { S_PLAYER, setListenCardShowing } from './Player';
import { hostOf } from './SaveRow';
import { Head } from './TabHead';

/** The ruler's touch area (FD 115): 48 pt tall, the 30-pt ruler and the space just above and below it. */
const RULER_H = 30;
const RULER_SLOP = (48 - RULER_H) / 2;
const KNOB = 12;

/** Whether a screen reader is on, kept current. */
function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isScreenReaderEnabled().then(setOn).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setOn);
    return () => sub.remove();
  }, []);
  return on;
}

/**
 * The word meter's ruler, which seeks (FD 115): a tap jumps to its point; a drag that starts sideways (8 pt across
 * before 12 pt down) shows a knob on the line, the line filled to it, and its time in the left clock (onScrub), then
 * jumps where it is let go (onSeek). A drag that starts downwards fails, so the list scrolls, and a cancelled drag
 * changes nothing. The knob and the line follow the finger on the UI thread, so word events don't move them, and the
 * line stays where it was let go until the place reaches it. For a screen reader it is an adjustable control stepping
 * a twentieth of the article.
 */
function Ruler({ s, word, ink, onScrub, onSeek }: { s: Session; word: number; ink: string; onScrub: (w: number | null) => void; onSeek: (w: number) => void }) {
  const { c } = useTheme();
  const dur = seconds(s.totalWords, s.wps, s.rate);
  const r = ruler(dur);
  const p = s.totalWords ? Math.min(1, word / s.totalWords) : 0;
  const pct = (at: number) => `${at * 100}%` as const;
  const [w, setW] = useState(0);
  const x = useSharedValue(0); // the finger, during a drag
  const rest = useSharedValue(0); // the line's end otherwise: the place, or where a tap or drag landed until it arrives
  const on = useSharedValue(0); // a drag under way
  const sec = useSharedValue(-1); // the clock's second under the knob, so JS hears of a drag only when it changes
  // each seek, so the line and the screen reader's value catch up even when the word moved to is the one already shown
  const [seeks, setSeeks] = useState(0);
  useLayoutEffect(() => {
    rest.value = p * w;
  }, [p, w, seeks]); // eslint-disable-line react-hooks/exhaustive-deps
  const cb = useRef({ onScrub, onSeek });
  cb.current = { onScrub, onSeek };
  const move = useCallback((wd: number) => cb.current.onScrub(wd), []);
  const seek = useCallback((wd: number) => {
    cb.current.onSeek(wd);
    setSeeks((n) => n + 1);
  }, []);
  const done = useCallback(() => cb.current.onScrub(null), []);
  // RULED: TalkBack's double-tap on a control with no click becomes a touch at its centre, which would seek to the
  // middle; with a screen reader on, the tap is off and the control moves by its steps (a drag still works).
  const sr = useScreenReader();
  const { totalWords: total, wps, rate } = s;
  const gesture = useMemo(() => {
    const clampX = (px: number) => {
      'worklet';
      return Math.max(0, Math.min(w, px));
    };
    const at = (px: number) => {
      'worklet';
      return wordAt(w ? clampX(px) / w : 0, total);
    };
    const track = (px: number) => {
      'worklet';
      x.value = clampX(px);
      const wd = at(px);
      const t = seconds(wd, wps, rate);
      if (t !== sec.value) {
        sec.value = t;
        runOnJS(move)(wd);
      }
    };
    const pan = Gesture.Pan()
      .activeOffsetX([-8, 8])
      .failOffsetY([-12, 12])
      .onStart((e) => {
        on.value = 1;
        sec.value = -1;
        track(e.x);
      })
      .onUpdate((e) => track(e.x))
      .onEnd((e, ok) => {
        if (!ok) return;
        rest.value = clampX(e.x);
        runOnJS(seek)(at(e.x));
      })
      .onFinalize(() => {
        on.value = 0;
        runOnJS(done)();
      });
    // a still press seeks however long it is held, as the prototype's does
    const tap = Gesture.Tap().maxDistance(8).maxDuration(10_000).enabled(!sr).onEnd((e, ok) => {
      if (!ok) return;
      rest.value = clampX(e.x);
      runOnJS(seek)(at(e.x));
    });
    return Gesture.Race(pan, tap);
  }, [w, total, wps, rate, sr, move, seek, done]); // eslint-disable-line react-hooks/exhaustive-deps
  const knobStyle = useAnimatedStyle(() => ({ opacity: on.value, transform: [{ translateX: x.value - KNOB / 2 }] }));
  const fill = useAnimatedStyle(() => ({ transform: [{ translateX: (on.value ? x.value : rest.value) - w }] }));
  // The value a screen reader hears: while playing it moves on only by whole steps of a twentieth, and with a seek, a
  // pause or play, or another article, so a focused control isn't read out every second; paused it is the place.
  const twentieth = total ? Math.floor((word * 20) / total) : 0;
  const [heard, setHeard] = useState(word);
  useEffect(() => setHeard(word), [s.hash, s.playing, twentieth, seeks]); // eslint-disable-line react-hooks/exhaustive-deps
  const [elapsed, all] = positionClocks(s.playing ? heard : word, total, wps, rate);
  const step = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'increment') seek(stepWord(word, total, 1));
    else if (e.nativeEvent.actionName === 'decrement') seek(stepWord(word, total, -1));
  };
  return (
    <GestureDetector gesture={gesture}>
      <View
        accessible accessibilityRole="adjustable" accessibilityLabel={S.listen.position} accessibilityValue={{ text: S.listen.positionValue(elapsed, all) }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]} onAccessibilityAction={step}
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
        style={{ height: RULER_H + 2 * RULER_SLOP, paddingVertical: RULER_SLOP, marginVertical: -RULER_SLOP }}
      >
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: RULER_H }}>
          {r.numbers.map((n, i) => (
            <T key={n.label} style={[mono13, { position: 'absolute', top: 0, left: pct(n.at), color: c.muted, lineHeight: 13, transform: [{ translateX: i === 0 ? 0 : -6 }] }]}>{n.label}</T>
          ))}
          {r.ticks.map((t, i) => (
            <View key={i} style={{ position: 'absolute', bottom: 3, left: pct(t.at), width: 1, height: t.major ? 10 : 5, backgroundColor: t.major ? c.muted : c.lineStrong }} />
          ))}
          <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, borderRadius: 999, backgroundColor: alpha(c.muted, 0.22), overflow: 'hidden' }}>
            <Animated.View style={[{ width: w, height: 3, borderRadius: 999, backgroundColor: ink }, fill]} />
          </View>
          <Animated.View
            pointerEvents="none"
            style={[{ position: 'absolute', left: 0, bottom: 1.5 - KNOB / 2, width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: ink, boxShadow: `0px 0px 0px 2px ${c.surface}` }, knobStyle]}
          />
        </View>
      </View>
    </GestureDetector>
  );
}

/** One mark per word of the spoken sentence, lit as the voice reaches it; unlit without word timing (FD 68, FD 91 (h)). */
function WordMeter({ s, ink }: { s: Session; ink: string }) {
  const { c } = useTheme();
  const i = sentenceOf(s.firstWords, s.word);
  const sent = s.sentences[i];
  const m = sent ? meter(sent.firstWord, sent.wordStarts.length, s.word, s.wordTiming) : { marks: 0, lit: 0 };
  // centred, but a sentence too long for the row keeps its first marks (prototype .wmeter, safe center)
  const [w, setW] = useState(0);
  const fits = m.marks * 5 - 2 <= w;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" onLayout={(e) => setW(e.nativeEvent.layout.width)}
      style={{ flex: 1, minWidth: 0, height: 14, flexDirection: 'row', alignItems: 'center', justifyContent: fits ? 'center' : 'flex-start', gap: 2, overflow: 'hidden' }}>
      {Array.from({ length: m.marks }, (_, k) => (
        <View key={k} style={{ width: 3, height: 14, borderRadius: 1, backgroundColor: k < m.lit ? ink : alpha(c.muted, 0.24), transform: [{ scaleY: k < m.lit ? 1 : 0.5 }] }} />
      ))}
    </View>
  );
}

function Ctl({ icon, label, onPress, size = 48 }: { icon: IconName; label: string; onPress: () => void; size?: number }) {
  const { c } = useTheme();
  return (
    <Press accessibilityRole="button" accessibilityLabel={label} onPress={onPress} layer={pressLayer(c.text)} style={{ width: size, height: size, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={24} color={c.text} />
    </Press>
  );
}

/** The card: a session, or with none (ready) the article it holds, whose controls start it or move its position (FD 111). */
function NowPlaying({ s, row, ready, onLayout }: { s: Session; row: LibRow | undefined; ready?: Ready; onLayout: (e: LayoutChangeEvent) => void }) {
  const { c } = useTheme();
  const label = ready ? (ready.last ? S.listen.lastPlayed : S.listen.upNext) : s.playing ? S.listen.nowPlaying : S.listen.paused;
  const onSkip = (d: 15 | -15) => (ready ? skipStored(ready.row, d) : skip(d));
  const { width } = useWindowDimensions();
  const ink = ShelfCover.lineInk(s.hash, c.surface, c.text);
  // the word under a drag, shown in the left clock; then the word sought, until the voice or the store reports it
  const [scrub, setScrub] = useState<number | null>(null);
  const [sought, setSought] = useState<number | null>(null);
  useEffect(() => setSought(null), [s.word, s.hash]);
  const onSeek = (w: number) => setSought(ready ? seekStored(ready.row, w, s.totalWords) : seekTo(w));
  const word = sought ?? s.word;
  const t = seconds(scrub ?? word, s.wps, s.rate);
  const d = seconds(s.totalWords, s.wps, s.rate);
  return (
    <View onLayout={onLayout} style={{ marginTop: 4, marginHorizontal: 16, marginBottom: 22, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
      <Cover hash={s.hash} size={(width - 34) / 3} cols={3} square />
      <View style={{ paddingTop: 14, paddingHorizontal: 16, paddingBottom: 12 }}>
        <T style={[ui(13, 'groupLabel', 1.45), { color: c.muted, marginBottom: 6, paddingRight: 48 }]}>{label}</T>
        {!s.playing && !ready && (
          <Press accessibilityRole="button" accessibilityLabel={S_PLAYER.close} onPress={closeVoice} layer={pressLayer(c.muted)} style={{ position: 'absolute', top: 4, right: 4, width: 48, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="x" size={20} color={c.muted} />
          </Press>
        )}
        <Press accessibilityRole="button" onPress={() => router.push(`/reader/${s.hash}`)} layer={pressLayer(c.text)} style={{ minHeight: 48, marginBottom: 4, justifyContent: 'center' }}>
          <T style={ui(17, 'heading', 1.3, -0.01)}>{s.title}</T>
        </Press>
        <T muted style={[ui(13, 'body', 1.45), { marginBottom: 12 }]}>{row?.site ?? (row ? hostOf(row.url) : '')}</T>
        <Ruler s={s} word={word} ink={ink} onScrub={setScrub} onSeek={onSeek} />
        {/* the ruler's touch area runs a little into this row, which takes no touches */}
        <View pointerEvents="none" style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6, marginBottom: 4 }}>
          <T style={[mono13, { color: c.muted }]}>{clock(t)}</T>
          <WordMeter s={s} ink={ink} />
          <T style={[mono13, { color: c.muted }]}>{clock(d)}</T>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }} />
          <Ctl icon="back15" label={S_PLAYER.back15} onPress={() => onSkip(-15)} />
          <Press accessibilityRole="button" accessibilityLabel={s.playing ? S_PLAYER.pause : S_PLAYER.play} onPress={ready ? () => toggleRow(ready.row) : toggle} layer={pressLayer(c.onFill, 'fill')}
            style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center', marginHorizontal: 8 }}>
            <Icon name={s.playing ? 'pause' : 'play'} size={24} color={c.onFill} solid />
          </Press>
          <Ctl icon="fwd15" label={S_PLAYER.fwd15} onPress={() => onSkip(15)} />
          <View style={{ flex: 1, alignItems: 'flex-end' }}>
            <Press accessibilityRole="button" accessibilityLabel={S_PLAYER.speed(rateLabel(s.rate))} onPress={cycleRate} layer={pressLayer(c.text)}
              style={{ height: 36, minWidth: 52, paddingHorizontal: 12, borderRadius: radius.control, backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' }}>
              <T style={[ui(13, 'title', 1), { fontVariant: ['tabular-nums'] }]}>{rateLabel(s.rate)}</T>
            </Press>
          </View>
        </View>
      </View>
    </View>
  );
}

/** A Listen row (prototype .lrow): the leading play button wears the article's cover; the body puts it in the card (FD 115). */
function ListenRow({ r, on, onCue }: { r: LibRow; on: boolean; onCue: (r: LibRow) => void }) {
  const { c } = useTheme();
  const ink = ShelfCover.lineInk(r.hash, c.background, c.text);
  const p = progressOf(r);
  const left = p > 0 && 1 > p ? minutesLeft(r) : null;
  const mins = minutes(r.words);
  const title = r.title ?? hostOf(r.url);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 12, paddingBottom: 13 }}>
      <Press accessibilityRole="button" accessibilityLabel={on ? S.listen.pause(title) : S.listen.play(title)} onPress={() => toggleRow(r)} layer={pressLayer(c.onFill, 'fill')} style={{ width: 48, height: 48, borderRadius: radius.control }}>
        <Cover hash={r.hash} size={48} radius={radius.control} />
        <View style={{ position: 'absolute', left: 9, top: 9, width: 30, height: 30, borderRadius: 15, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center', boxShadow: `0px 0px 0px 1.5px ${c.onFill}` }}>
          <Icon name={on ? 'pause' : 'play'} size={14} color={c.onFill} solid />
        </View>
      </Press>
      <Press accessibilityRole="button" accessibilityLabel={title} accessibilityHint={S.listen.cueHint} onPress={() => onCue(r)} layer={pressLayer(c.text)} style={{ flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center', borderRadius: radius.image }}>
        <T muted numberOfLines={1} style={ui(13, 'meta', 1.3)}>{r.site ?? hostOf(r.url)}</T>
        <T numberOfLines={2} style={[ui(15, 'title', 1.35, -0.005), { marginTop: 2, marginBottom: 4 }]}>{title}</T>
        {left !== null ? <T style={ui(13, 'title', 1.3)}>{S.row.minsLeft(left)}</T> : mins !== null ? <T muted style={ui(13, 'body', 1.3)}>{S.row.mins(mins)}</T> : null}
      </Press>
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 1, backgroundColor: c.line }} />
      {p > 0 && 1 > p && (
        <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, overflow: 'hidden' }}>
          <View style={{ width: `${p * 100}%`, height: 3, backgroundColor: ink, borderTopRightRadius: 2, borderBottomRightRadius: 2 }} />
        </View>
      )}
    </View>
  );
}

export default function Listen() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const owner = useApp()?.owner ?? '';
  const s = useVoice();
  const navigation = useNavigation<{ navigate: (name: string) => void }>();
  const rows = useLive(() => (owner ? listenRows(store(), owner) : []), ['items'], [owner]);
  const readyLive = useLive(() => (owner && !s ? readyRow(store(), owner) : null), ['items', 'listen_history', 'settings'], [owner, !s]);
  // The render a session closes in (✕, or a row's body) reads the card's article itself, since the live read follows
  // a frame later: the card goes straight from the session to the article, never through the empty state.
  const ready = s ? null : readyLive ?? (owner ? readyRow(store(), owner) : null);
  const rate = useLive(() => store().get<{ value: string }>("SELECT value FROM settings WHERE key = 'voice.speed'")?.value ?? '', ['settings'], []);
  // the ready article drawn as a paused session would draw it, read again when it, its place or the speed changes
  const held = useMemo(() => (ready ? readySession(ready.row) : null), [ready?.row.hash, ready?.row.position_word, ready?.row.words, rate]); // eslint-disable-line react-hooks/exhaustive-deps
  // an article whose text can't be read leaves the card (its choice cleared, lost text fetched again), so it moves on
  useEffect(() => {
    if (ready && !held) unplayable(ready.row.hash);
  }, [ready?.row.hash, !held]); // eslint-disable-line react-hooks/exhaustive-deps
  const card = useRef({ y: 0, h: 0 });
  const viewH = useRef(0);
  const scrollY = useRef(0);
  const scroll = useRef<ScrollView>(null);
  const showing = useRef(true);
  const still = useReducedMotion();

  // The mini appears once the card is under 40% in view and leaves once it is over 60% (FD 52).
  const judge = useCallback((y: number) => {
    scrollY.current = y;
    showing.current = cardOnScreen(showing.current, card.current, y, viewH.current);
    setListenCardShowing(showing.current);
  }, []);
  // A row's body (FD 115): the card takes its article; Listen scrolls back to a card under 60% in view so the switch
  // is seen, at once under reduced motion, and a screen reader hears it. The article already in the card changes nothing.
  const cue = useCallback((r: LibRow) => {
    if (!putInPlayer(r)) return;
    if (0.6 > cardInView(card.current, scrollY.current, viewH.current)) scroll.current?.scrollTo({ y: 0, animated: !still });
    AccessibilityInfo.announceForAccessibility(S.listen.cued(r.title ?? hostOf(r.url)));
  }, [still]);
  useFocusEffect(useCallback(() => {
    setToastFloor(TAB_BAR_HEIGHT);
    setListenCardShowing(showing.current);
    return () => setListenCardShowing(false);
  }, []));

  const current = s ?? held;
  // the playing article's row, which may be archived and so not in the list
  const playingRow = useLive(() => (owner && s ? rowByHash(store(), owner, s.hash) : undefined), ['items'], [owner, s?.hash]);
  const row = s ? playingRow : ready?.row;
  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top }}>
      <ScrollView
        ref={scroll}
        onLayout={(e) => (viewH.current = e.nativeEvent.layout.height)}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => judge(e.nativeEvent.contentOffset.y)}
        scrollEventThrottle={32}
        contentContainerStyle={{ paddingBottom: 160 }}
      >
        <Head title={S.listen.title} count={rows.length ? S.listen.unread(rows.length) : undefined} />
        {!current && !rows.length ? (
          <View style={{ paddingVertical: 32, paddingHorizontal: 24, alignItems: 'center' }}>
            <View style={{ width: 56, height: 56, borderRadius: radius.button, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="headphones" size={26} color={c.text} />
            </View>
            <T accessibilityRole="header" style={[ui(20, 'emptyHeading', 1.3, -0.01), { marginTop: 22, marginBottom: 8, textAlign: 'center' }]}>{S.listen.emptyTitle}</T>
            <T muted style={[ui(15, 'body', 1.45), { textAlign: 'center', maxWidth: 260, marginBottom: 24 }]}>{S.listen.emptyBody}</T>
            <Button label={S.listen.goToSaves} kind="secondary" onPress={() => navigation.navigate('index')} />
          </View>
        ) : (
          <>
            {/* no card while the article it would hold can't be read; the list still shows */}
            {current && (
              <NowPlaying
                s={current} row={row} ready={s ? undefined : ready ?? undefined}
                onLayout={(e) => {
                  card.current = { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height };
                  judge(scrollY.current);
                }}
              />
            )}
            {rows.length > 0 && (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 4 }}>
                  <T accessibilityRole="header" style={ui(17, 'heading', 1.3)}>{S.listen.listHead}</T>
                  <Press accessibilityRole="button" onPress={() => playAll(rows.map((r) => r.hash))} layer={pressLayer(c.text)}
                    style={{ height: 36, paddingLeft: 10, paddingRight: 12, borderRadius: radius.control, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Icon name="play" size={14} color={c.text} solid />
                    <T style={ui(13, 'title', 1)}>{S.listen.playAll}</T>
                  </Press>
                </View>
                <View style={{ paddingHorizontal: 16 }}>
                  {rows.map((r) => <ListenRow key={r.hash} r={r} on={!!s && s.hash === r.hash && s.playing} onCue={cue} />)}
                </View>
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}
