// Listen (mobile spec 5.7, FD 3, FD 49, FD 52, FD 68; prototype listen, listen-empty, listen-scrolled, listen-reader): Now playing,
// led by the playing article's 3:1 cover band, with the word meter's ruler, the spoken sentence's marks and the
// controls; then Played, most recent first, with Play all. A row's cover plays it and its body opens the Reader, whose Back returns here (listen-reader). The
// mini takes over once the card has mostly scrolled away.
import { useCallback, useRef, useState } from 'react';
import { ScrollView, View, useWindowDimensions, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { router, useFocusEffect, useNavigation } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius } from '@shelf/tokens';
import { minutes, minutesLeft, progressOf, type LibRow } from '../data/library';
import { playedRows } from '../data/listen';
import { useApp } from '../services/app';
import { closeVoice, cycleRate, playAll, skip, toggle, toggleRow, useVoice, type Session } from '../services/voice';
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
import { cardOnScreen, clock, meter, rateLabel, ruler, seconds, sentenceOf } from '../voice/clock';
import { S_PLAYER, setListenCardShowing } from './Player';
import { hostOf } from './SaveRow';
import { Head } from './TabHead';

function Ruler({ s, ink }: { s: Session; ink: string }) {
  const { c } = useTheme();
  const dur = seconds(s.totalWords, s.wps, s.rate);
  const r = ruler(dur);
  const p = s.totalWords ? Math.min(1, s.word / s.totalWords) : 0;
  const pct = (at: number) => `${at * 100}%` as const;
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ height: 30 }}>
      {r.numbers.map((n, i) => (
        <T key={n.label} style={[mono13, { position: 'absolute', top: 0, left: pct(n.at), color: c.muted, lineHeight: 13, transform: [{ translateX: i === 0 ? 0 : -6 }] }]}>{n.label}</T>
      ))}
      {r.ticks.map((t, i) => (
        <View key={i} style={{ position: 'absolute', bottom: 3, left: pct(t.at), width: 1, height: t.major ? 10 : 5, backgroundColor: t.major ? c.muted : c.lineStrong }} />
      ))}
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, borderRadius: 999, backgroundColor: alpha(c.muted, 0.22), overflow: 'hidden' }}>
        <View style={{ width: pct(p), height: 3, borderRadius: 999, backgroundColor: ink }} />
      </View>
    </View>
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

function NowPlaying({ s, row, onLayout }: { s: Session; row: LibRow | undefined; onLayout: (e: LayoutChangeEvent) => void }) {
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const ink = ShelfCover.lineInk(s.hash, c.surface, c.text);
  const t = seconds(s.word, s.wps, s.rate);
  const d = seconds(s.totalWords, s.wps, s.rate);
  return (
    <View onLayout={onLayout} style={{ marginTop: 4, marginHorizontal: 16, marginBottom: 22, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
      <Cover hash={s.hash} size={(width - 34) / 3} cols={3} square />
      <View style={{ paddingTop: 14, paddingHorizontal: 16, paddingBottom: 12 }}>
        <T style={[ui(13, 'groupLabel', 1.45), { color: c.muted, marginBottom: 6, paddingRight: 48 }]}>{s.playing ? S.listen.nowPlaying : S.listen.paused}</T>
        {!s.playing && (
          <Press accessibilityRole="button" accessibilityLabel={S_PLAYER.close} onPress={closeVoice} layer={pressLayer(c.muted)} style={{ position: 'absolute', top: 4, right: 4, width: 48, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="x" size={20} color={c.muted} />
          </Press>
        )}
        <Press accessibilityRole="button" onPress={() => router.push(`/reader/${s.hash}`)} layer={pressLayer(c.text)} style={{ minHeight: 48, marginBottom: 4, justifyContent: 'center' }}>
          <T style={ui(17, 'heading', 1.3, -0.01)}>{s.title}</T>
        </Press>
        <T muted style={[ui(13, 'body', 1.45), { marginBottom: 12 }]}>{row?.site ?? (row ? hostOf(row.url) : '')}</T>
        <Ruler s={s} ink={ink} />
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 6, marginBottom: 4 }}>
          <T style={[mono13, { color: c.muted }]}>{clock(t)}</T>
          <WordMeter s={s} ink={ink} />
          <T style={[mono13, { color: c.muted }]}>{clock(d)}</T>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <View style={{ flex: 1 }} />
          <Ctl icon="back15" label={S_PLAYER.back15} onPress={() => skip(-15)} />
          <Press accessibilityRole="button" accessibilityLabel={s.playing ? S_PLAYER.pause : S_PLAYER.play} onPress={toggle} layer={pressLayer(c.onFill, 'fill')}
            style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center', marginHorizontal: 8 }}>
            <Icon name={s.playing ? 'pause' : 'play'} size={24} color={c.onFill} solid />
          </Press>
          <Ctl icon="fwd15" label={S_PLAYER.fwd15} onPress={() => skip(15)} />
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

/** A Played row (prototype .lrow): the leading play button wears the article's cover; the body opens the Reader. */
function PlayedRow({ r, on }: { r: LibRow; on: boolean }) {
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
      <Press accessibilityRole="button" accessibilityLabel={title} onPress={() => router.push(`/reader/${r.hash}`)} layer={pressLayer(c.text)} style={{ flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center', borderRadius: radius.image }}>
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
  const rows = useLive(() => (owner ? playedRows(store(), owner) : []), ['items', 'listen_history'], [owner]);
  const card = useRef({ y: 0, h: 0 });
  const viewH = useRef(0);
  const showing = useRef(true);

  // The mini appears once the card is under 40% in view and leaves once it is over 60% (FD 52).
  const judge = useCallback((scrollY: number) => {
    showing.current = cardOnScreen(showing.current, card.current, scrollY, viewH.current);
    setListenCardShowing(showing.current);
  }, []);
  useFocusEffect(useCallback(() => {
    setToastFloor(TAB_BAR_HEIGHT);
    setListenCardShowing(showing.current);
    return () => setListenCardShowing(false);
  }, []));

  const current = s;
  const row = current ? rows.find((r) => r.hash === current.hash) : undefined;
  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top }}>
      <ScrollView
        onLayout={(e) => (viewH.current = e.nativeEvent.layout.height)}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => judge(e.nativeEvent.contentOffset.y)}
        scrollEventThrottle={32}
        contentContainerStyle={{ paddingBottom: 160 }}
      >
        <Head title={S.listen.title} count={rows.length ? S.listen.played(rows.length) : undefined} />
        {!rows.length ? (
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
            {current && (
              <NowPlaying
                s={current} row={row}
                onLayout={(e) => {
                  card.current = { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height };
                  judge(0);
                }}
              />
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 4 }}>
              <T accessibilityRole="header" style={ui(17, 'heading', 1.3)}>{S.listen.playedHead}</T>
              <Press accessibilityRole="button" onPress={() => playAll(rows.map((r) => r.hash))} layer={pressLayer(c.text)}
                style={{ height: 36, paddingLeft: 10, paddingRight: 12, borderRadius: radius.control, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Icon name="play" size={14} color={c.text} solid />
                <T style={ui(13, 'title', 1)}>{S.listen.playAll}</T>
              </Press>
            </View>
            <View style={{ paddingHorizontal: 16 }}>
              {rows.map((r) => <PlayedRow key={r.hash} r={r} on={!!current && current.hash === r.hash && current.playing} />)}
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}
