// The Reader (mobile spec 5.6, 6.7; prototype reader, reader-loading, reader-offline, reader-error, reader-menu,
// reader-aa, reader-end). The reading palette with the article's ink; the 3:1 cover band, source, title and byline;
// the text laid out at the saved word before it shows, with no animated scroll; the end card; the floating Archive.
// The position is kept as the page moves and published on leaving and at most once a minute while reading (4.5).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ScrollView, View, useWindowDimensions, type GestureResponderEvent, type LayoutChangeEvent, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { SlidingLine } from '../ui/Line';
import * as Clipboard from 'expo-clipboard';
import { fontFamily, radius, reader as RT } from '@kefli/tokens';
import { quickIn, quickOut } from '@kefli/tokens/reanimated';
import { minutes, nextUnread, reconcileWords, rowByHash, setPosition, textLost, type LibRow } from '../data/library';
import { blockOfWord, type Article } from '../reader/blocks';
import { isDoubleTap, scrollYForWord, wordAtOffset, wordAtScroll, type Place, type Tap } from '../reader/position';
import { readerColors, type PaletteId, type ReaderColors } from '../reader/palette';
import { setReaderPalette, setReaderSize, useReaderPrefs } from '../reader/prefs';
import { BlockView, type FigureState, type Lit } from '../reader/Prose';
import { getImage, markUsed, needsFetch } from '../data/images';
import { fetchArticleImages, imageUrls } from '../services/images';
import { imagePorts } from '../services/runner';
import { useApp } from '../services/app';
import { runOutbox, runSync, setReading } from '../services/runner';
import { store } from '../services/store';
import { textFiles } from '../services/textFiles';
import { Button } from '../ui/Button';
import { Cover } from '../ui/Cover';
import { Icon } from '../ui/Icon';
import { useLive } from '../ui/live';
import { MenuItem } from '../ui/MenuItem';
import { useOnline } from '../ui/online';
import { Press, pressLayer } from '../ui/Press';
import { closeSheet, openSheet } from '../ui/sheet';
import { S, savedWhen } from '../ui/strings';
import { T, articleTitle, ui } from '../ui/text';
import { setToastFloor, showToast } from '../ui/toast';
import { alpha, mix, useTheme } from '../ui/theme';
import { archive, remove } from './actions';
import { ReaderTier } from './Player';
import { KefliSystem } from '../../modules/kefli-system/src';
import { jumpTo, listenFrom, pauseVoice, startListening, stopIfPlaying, useVoice, warmVoice, type Session } from '../services/voice';
import { startWord } from '../voice/clock';
import { ArchiveDock, DOCK, DOCK_LIFTED } from './ArchiveDock';
import { OriginalView } from './Original';
import { hostOf } from './SaveRow';
import { Skeleton } from './Skeleton';
import { SpeedRead } from './SpeedRead';

/** The reading band's top: 40 px under the bar (FD 18). */
const BAND_TOP = 40;
const PUBLISH_EVERY = 60;
/** The first render: blocks before and after the saved place, then batches of this many (6.7). */
const FIRST_BEFORE = 8;
const FIRST_AFTER = 40;
const BATCH = 40;
const now = () => Math.floor(Date.now() / 1000);

/** The Listen chip (prototype .listenbtn): a hairline entry point; it keeps its slot, faded, while its article plays. */
function ListenChip({ P, gone, onPress }: { P: ReaderColors; gone: boolean; onPress: () => void }) {
  const st = useAnimatedStyle(() => ({ opacity: withTiming(gone ? 0 : 1, gone ? quickOut : quickIn) }), [gone]);
  return (
    <Animated.View style={[{ marginRight: 4 }, st]} pointerEvents={gone ? 'none' : 'auto'} importantForAccessibility={gone ? 'no-hide-descendants' : 'auto'}>
      <Press accessibilityRole="button" accessibilityLabel={S.reader.listen} onPress={onPress} layer={pressLayer(P.text, 'reader')}
        style={{ height: 36, paddingLeft: 10, paddingRight: 12, borderRadius: radius.control, borderWidth: 1, borderColor: alpha(P.text, 0.22), flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="play" size={14} color={P.text} solid />
        <T style={[ui(13, 'title', 1), { color: P.text }]}>{S.reader.listen}</T>
      </Press>
    </Animated.View>
  );
}

/** The bar: Back, the source, the Listen chip, Speed read while the text is shown (FD 110), Aa and ⋯. */
function Bar({ row, P, onAa, onMore, onSpeedRead, chip }: { row: LibRow; P: ReaderColors; onAa: () => void; onMore: () => void; onSpeedRead?: () => void; chip?: React.ReactNode }) {
  const btn = (label: string, onPress: () => void, child: React.ReactNode) => (
    <Press accessibilityRole="button" accessibilityLabel={label} onPress={onPress} layer={pressLayer(P.text, 'reader')} style={{ width: 48, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' }}>
      {child}
    </Press>
  );
  return (
    <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, backgroundColor: P.bg, zIndex: 2 }}>
      {btn(S.reader.back, () => router.back(), <Icon name="back" size={22} color={P.text} />)}
      <T numberOfLines={1} style={[ui(13, 'body', 1.3), { flex: 1, textAlign: 'center', color: P.muted }]}>{hostOf(row.url)}</T>
      {chip}
      {onSpeedRead && btn(S.reader.speedRead, onSpeedRead, <Icon name="speedread" size={22} color={P.text} />)}
      {btn(S.reader.aa, onAa, <T style={[ui(15, 'heading', 1, -0.02), { color: P.text }]}>Aa</T>)}
      {btn(S.reader.more, onMore, <Icon name="more" size={22} color={P.text} />)}
    </View>
  );
}

function Swatch({ id, label, on, hash }: { id: PaletteId; label: string; on: boolean; hash: string }) {
  const { c } = useTheme();
  // the Dark swatch previews this article's own Night paper
  const sw = readerColors(id === 'dark' ? hash : null, id);
  const ring = useAnimatedStyle(() => ({ opacity: withTiming(on ? 1 : 0, on ? quickIn : quickOut) }), [on]);
  return (
    <Press accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={label} onPress={() => setReaderPalette(id)} layer={pressLayer(sw.text, 'reader')}
      style={{ flex: 1, height: 64, borderRadius: radius.container, alignItems: 'center', justifyContent: 'center', gap: 2, backgroundColor: sw.bg, borderWidth: 1, borderColor: c.line }}>
      <T style={{ fontFamily: fontFamily.reader.regular, fontSize: 20, color: sw.text, includeFontPadding: false }}>Aa</T>
      <T style={[ui(13, 'meta', 1.2), { color: sw.text }]}>{label}</T>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: -6, left: -6, right: -6, bottom: -6, borderRadius: radius.container + 4, borderWidth: 2, borderColor: c.text }, ring]} />
    </Press>
  );
}

function AaSheet({ hash }: { hash: string }) {
  const prefs = useReaderPrefs();
  const { c, name } = useTheme();
  const pid: PaletteId = prefs.palette ?? (name === 'dark' ? 'dark' : 'light');
  const [lo, hi] = RT.sizeRange;
  const pct = (prefs.size - lo) / (hi - lo);
  const sz = (label: string, d: number, fs: number) => (
    <Press accessibilityRole="button" accessibilityLabel={label} onPress={() => setReaderSize(prefs.size + d)} layer={pressLayer(c.text)} style={{ width: 48, height: 48, borderRadius: radius.button, backgroundColor: c.background, alignItems: 'center', justifyContent: 'center' }}>
      <T style={ui(fs, 'heading', 1)}>A</T>
    </Press>
  );
  const track = useSharedValue(pct);
  useEffect(() => {
    track.value = withTiming(pct, quickIn);
  }, [pct, track]);
  return (
    <View>
      <T accessibilityRole="header" style={[ui(20, 'emptyHeading', 1.3, -0.01), { marginBottom: 4 }]}>{S.reader.aaSheet.title}</T>
      <T muted style={[ui(13, 'body', 1.45), { marginBottom: 16 }]}>{S.reader.aaSheet.sub}</T>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        {sz(S.reader.aaSheet.smaller, -1, 13)}
        <SlidingLine p={track} height={4} color={c.text} round style={{ flex: 1, borderRadius: 999, backgroundColor: c.line }} />
        {sz(S.reader.aaSheet.larger, 1, 20)}
      </View>
      <T style={{ position: 'absolute', opacity: 0 }} accessibilityLiveRegion="polite">{S.reader.aaSheet.size(prefs.size)}</T>
      <View accessibilityRole="radiogroup" accessibilityLabel={S.reader.aaSheet.colours} style={{ flexDirection: 'row', gap: 8 }}>
        <Swatch id="light" label={S.reader.aaSheet.light} on={pid === 'light'} hash={hash} />
        <Swatch id="sepia" label={S.reader.aaSheet.sepia} on={pid === 'sepia'} hash={hash} />
        <Swatch id="dark" label={S.reader.aaSheet.dark} on={pid === 'dark'} hash={hash} />
      </View>
    </View>
  );
}

function EndCard({ row, P, next, onArchive, onNext, onUnarchive }: { row: LibRow; P: ReaderColors; next: boolean; onArchive: () => void; onNext: () => void; onUnarchive: () => void }) {
  const colours = { fill: P.fill, onFill: P.onFill, bg: P.bg, text: P.text, edge: alpha(P.muted, 0.35) };
  const mins = minutes(row.words);
  return (
    <View style={{ marginTop: 32, padding: 16, borderRadius: radius.container, alignItems: 'center', backgroundColor: mix(P.bg, P.muted, 0.08), borderWidth: 1, borderColor: alpha(P.muted, 0.25) }}>
      <T style={[ui(20, 'emptyHeading', 1.3, -0.01), { color: P.text, marginBottom: 4 }]}>{S.reader.endTitle}</T>
      <T style={[ui(13, 'body', 1.45), { color: P.muted, marginBottom: 16 }]}>{[row.site ?? hostOf(row.url), mins !== null ? S.row.mins(mins) : null].filter(Boolean).join(' · ')}</T>
      <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'center' }}>
        {row.state === 'archived'
          ? <Button label={S.reader.backToUnread} icon="restore" colors={colours} style={{ paddingHorizontal: 16 }} onPress={onUnarchive} />
          : (
            <>
              {next && <Button label={S.reader.archiveNext} kind="secondary" colors={colours} style={{ paddingHorizontal: 16 }} onPress={onNext} />}
              <Button label={S.reader.archive} icon="archive" colors={colours} style={{ paddingHorizontal: 16 }} onPress={onArchive} />
            </>
          )}
      </View>
    </View>
  );
}

/** The words the voice lights in a block: the spoken word, or with no word timing its whole sentence (FD 91 (h)). */
function litRange(s: Session | null, hash: string): { from: number; to: number } | null {
  if (!s || s.hash !== hash || s.ended) return null;
  if (s.wordTiming) return { from: s.word, to: s.word };
  const sent = s.sentences[s.sentence];
  return sent ? { from: sent.firstWord, to: sent.firstWord + sent.wordStarts.length - 1 } : null;
}

function Article({ row, P, owner, article, voice, viewRange, jump, imgs }: {
  row: LibRow; P: ReaderColors; owner: string; article: Article; voice: Session | null;
  /** Each image's state by address (5.6, reader-images). */
  imgs: Map<string, FigureState>;
  /** Set by the article: the first and last words in view, for where Listen starts (FD 19). */
  viewRange: React.MutableRefObject<(() => { first: number; last: number }) | null>;
  /** Set by the article: stands the page at a word, a third of the way down, lit for 1.6 s (leaving Speed read). */
  jump: React.MutableRefObject<((word: number) => void) | null>;
}) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const prefs = useReaderPrefs();
  const scroll = useRef<ScrollView>(null);
  const layouts = useRef<(Place | undefined)[]>([]);
  // blocks are direct children of the scroll content, so their places are content offsets
  const proseY = useRef(0);
  const scrollY = useRef(0);
  const contentH = useRef(0);
  const viewH = useRef(height);
  const target = useRef<{ word: number; at: number } | null>(row.position_word > 0 ? { word: row.position_word, at: BAND_TOP } : null);
  const [shown, setShown] = useState(row.position_word === 0);
  const [word, setWord] = useState(row.position_word);
  const lastPublish = useRef(now());
  const { blocks } = article;
  // A window of blocks around the saved place renders first and shows; the rest follow in small batches, the
  // blocks after it first, then those above, which the scroll view adds without moving what is on screen (6.7).
  const n = blocks.length;
  const [win, setWin] = useState(() => {
    const at = row.position_word > 0 ? blockOfWord(blocks, row.position_word) : 0;
    return { lo: Math.max(0, at - FIRST_BEFORE), hi: Math.min(n, at + FIRST_AFTER) };
  });
  useEffect(() => {
    if (!shown || (win.lo === 0 && win.hi === n)) return;
    const t = setTimeout(() => setWin((w) => (w.hi < n ? { ...w, hi: Math.min(n, w.hi + BATCH) } : { ...w, lo: Math.max(0, w.lo - BATCH) })), 16);
    return () => clearTimeout(t);
  }, [shown, win, n]);
  const docked = voice?.hash === row.hash;
  const dragging = useRef(false);
  const away = useRef(false);
  // stable per block, so a word change re-renders only the blocks whose highlight changes (6.7)
  const onLayouts = useMemo(() => blocks.map((_, i) => (e: LayoutChangeEvent) => {
    layouts.current[i] = { y: e.nativeEvent.layout.y, h: e.nativeEvent.layout.height };
  }), [blocks]);

  // Double-tap a word to play from it (FD 107): the phone is asked which character was under the second tap, and
  // the voice moves there, or starts there. A screen reader keeps its own double-tap, so the text takes no taps
  // while one runs; Listen and the skips serve there.
  const [screenReader, setScreenReader] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isScreenReaderEnabled().then(setScreenReader).catch(() => undefined);
    const sub = AccessibilityInfo.addEventListener('screenReaderChanged', setScreenReader);
    return () => sub.remove();
  }, []);
  const lastTap = useRef<Tap | null>(null);
  const rowRef = useRef(row);
  rowRef.current = row;
  const onTaps = useMemo(() => blocks.map((b, i) => (e: GestureResponderEvent) => {
    const { pageX, pageY } = e.nativeEvent;
    const tap = { block: i, x: pageX, y: pageY, at: Date.now() };
    const first = lastTap.current;
    lastTap.current = tap;
    if (!isDoubleTap(first, tap)) return;
    lastTap.current = null;
    KefliSystem.textOffsetAt(pageX, pageY)
      .catch(() => null)
      .then((hit) => listenFrom(rowRef.current, b.firstWord + (hit ? wordAtOffset(hit.text, hit.offset, b.words) : 0)))
      .catch(() => undefined);
  }), [blocks]);

  const place = useCallback(() => {
    const t = target.current;
    if (!t) return setShown(true);
    const y = scrollYForWord(blocks, layouts.current, proseY.current, t.word, t.at);
    if (y === null) return;
    scroll.current?.scrollTo({ y, animated: false });
    scrollY.current = y;
    target.current = null;
    setShown(true);
  }, [blocks]);

  // Lays out at the word before it shows; a fallback reveals it if a block never reports.
  useEffect(() => {
    const t = setTimeout(() => setShown(true), 800);
    return () => clearTimeout(t);
  }, []);

  /** The word at a distance from the top of the view. */
  const wordAt = useCallback(
    (at: number) => wordAtScroll(blocks, layouts.current, proseY.current, scrollY.current, at, { height: viewH.current, content: contentH.current, words: article.words }),
    [blocks, article.words],
  );

  viewRange.current = () => ({ first: wordAt(BAND_TOP), last: wordAt(viewH.current - 80) });

  // the word Speed read stopped on: the page stands at it, with no animated scroll, and it stays lit for 1.6 s
  const [flash, setFlash] = useState<number | null>(null);
  jump.current = (w: number) => {
    const y = scrollYForWord(blocks, layouts.current, proseY.current, w, 0);
    if (y !== null) {
      const at = Math.max(0, y - viewH.current / 3);
      scroll.current?.scrollTo({ y: at, animated: false });
      scrollY.current = at;
    } else {
      // a block not laid out yet: the page is placed when it is
      target.current = { word: w, at: viewH.current / 3 };
    }
    setWord(w);
    setFlash(w);
  };
  useEffect(() => {
    if (flash === null) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

  // Reading writes the position only while its article isn't playing (5.7).
  const moved = useRef(false);
  const keep = useCallback(() => {
    if (docked) return;
    moved.current = true;
    const w = wordAt(BAND_TOP);
    setWord(w);
    const publish = now() - lastPublish.current >= PUBLISH_EVERY;
    if (publish) lastPublish.current = now();
    setPosition(store(), now(), owner, row.hash, w, publish);
    if (publish) runOutbox().catch(() => 0);
  }, [wordAt, owner, row.hash, docked]);

  // Leaving the Reader publishes the position (4.5); a playing article's position is the voice's.
  const dockedRef = useRef(docked);
  dockedRef.current = docked;
  // Opening and leaving without a scroll changes nothing.
  useEffect(() => () => {
    if (dockedRef.current || !moved.current) return;
    setPosition(store(), now(), owner, row.hash, wordAt(BAND_TOP), true);
    runOutbox().catch(() => 0);
  }, [owner, row.hash, wordAt]);

  // A size change keeps the word a third of the way down still (MS Reader).
  const size = useRef(prefs.size);
  if (size.current !== prefs.size) {
    target.current = { word: wordAt(viewH.current / 3), at: viewH.current / 3 };
    size.current = prefs.size;
  }

  // Follow-scroll (FD 18, FD 43): when the spoken word leaves the reading band it glides a third of the way down,
  // never while a finger is down; a drag that takes it off screen stops following until it is seen again.
  const lit = litRange(voice, row.hash) ?? (flash !== null ? { from: flash, to: flash } : null);
  const spoken = litRange(voice, row.hash)?.from ?? -1;
  useEffect(() => {
    if (spoken < 0 || !shown) return;
    const y = scrollYForWord(blocks, layouts.current, proseY.current, spoken, 0);
    if (y === null) return;
    const top = scrollY.current + BAND_TOP;
    const bottom = scrollY.current + viewH.current - 80 - 72;
    const inBand = y >= top && bottom >= y;
    if (inBand) away.current = false;
    if (inBand || dragging.current || away.current) return;
    scroll.current?.scrollTo({ y: Math.max(0, y - viewH.current / 3), animated: true });
  }, [spoken, shown, blocks]);
  const litFor = useMemo(() => {
    const out = new Map<number, Lit>();
    if (!lit) return out;
    for (let i = blockOfWord(blocks, lit.from); n > i && lit.to >= blocks[i].firstWord; i++) {
      const b = blocks[i];
      const last = b.firstWord + b.words - 1;
      if (b.words && last >= lit.from) out.set(i, { from: Math.max(lit.from, b.firstWord) - b.firstWord, to: Math.min(lit.to, last) - b.firstWord });
    }
    return out;
  }, [blocks, lit?.from, lit?.to]); // eslint-disable-line react-hooks/exhaustive-deps

  const next = row.state === 'unread' ? nextUnread(store(), owner, row.hash) : undefined;
  const reopen = () => router.push(`/reader/${row.hash}`);
  const mins = minutes(row.words);
  const progress = article.words ? Math.min(1, word / article.words) : 0;
  const lineStyle = useAnimatedStyle(() => ({ opacity: withTiming(shown ? 1 : 0, quickIn) }), [shown]);

  return (
    <>
      <View style={{ height: 2, overflow: 'hidden', zIndex: 2, opacity: docked ? 0 : 1 }}>
        <View style={{ width: `${progress * 100}%`, height: 2, backgroundColor: P.ink }} />
      </View>
      <Animated.View style={[{ flex: 1 }, lineStyle]}>
        <ScrollView
          ref={scroll}
          onLayout={(e) => (viewH.current = e.nativeEvent.layout.height)}
          onContentSizeChange={(_, h) => { contentH.current = h; requestAnimationFrame(place); }}
          onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => (scrollY.current = e.nativeEvent.contentOffset.y)}
          scrollEventThrottle={32}
          onScrollBeginDrag={() => { dragging.current = true; }}
          onScrollEndDrag={() => {
            dragging.current = false;
            if (spoken >= 0) away.current = true;
            keep();
          }}
          onMomentumScrollEnd={keep}
          contentContainerStyle={{ paddingTop: 16, paddingHorizontal: 20, paddingBottom: 140 + insets.bottom }}
          // images arriving and blocks added above keep the text on screen where it is (5.6, 6.7)
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        >
          {win.lo === 0 && (
            <>
              <View style={{ marginTop: -16, marginHorizontal: -20, marginBottom: 22 }}>
                <Cover hash={row.hash} size={width / 3} cols={3} square />
              </View>
              <T style={[ui(13, 'meta', 1.45), { color: P.muted, marginBottom: 8 }]}>{row.site ?? hostOf(row.url)}</T>
              <T accessibilityRole="header" style={[articleTitle, { color: P.text, marginBottom: 12 }]}>{row.title ?? hostOf(row.url)}</T>
              <T style={[ui(13, 'body', 1.45), { color: P.muted, marginBottom: 24 }]}>
                {[row.byline ?? row.site ?? hostOf(row.url), mins !== null ? S.row.mins(mins) : null, savedWhen(row.saved_at)].filter(Boolean).join(' · ')}
              </T>
            </>
          )}
          {blocks.slice(win.lo, win.hi).map((b, k) => {
            const i = win.lo + k;
            return <BlockView key={i} b={b} P={P} size={prefs.size} onLayout={onLayouts[i]} lit={litFor.get(i)} img={b.kind === 'img' ? imgs.get(b.src) : undefined} onTap={screenReader || !b.words ? undefined : onTaps[i]} />;
          })}
          {win.hi === n && (
            <EndCard
              row={row} P={P} next={!!next}
              onArchive={() => { router.back(); archive(row.hash, true, reopen); }}
              onUnarchive={() => { router.back(); archive(row.hash, false, reopen); }}
              onNext={() => { if (next) { router.replace(`/reader/${next.hash}`); archive(row.hash, true, reopen); } }}
            />
          )}
        </ScrollView>
      </Animated.View>
    </>
  );
}

export default function Reader() {
  const { hash } = useLocalSearchParams<{ hash: string }>();
  const owner = useApp()?.owner ?? '';
  const row = useLive(() => rowByHash(store(), owner, hash), ['items'], [owner, hash]);
  const online = useOnline();
  const prefs = useReaderPrefs();
  const { name } = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const pid: PaletteId = prefs.palette ?? (name === 'dark' ? 'dark' : 'light');
  const P = useMemo(() => readerColors(hash, pid), [hash, pid]);
  const cached = row?.text_state === 'cached';
  // blocks and sentences were derived once when the text arrived (6.7); opening only reads them
  const article = useMemo(() => (cached ? textFiles.readArticle(hash) : null), [cached, hash, row?.text_sha256]); // eslint-disable-line react-hooks/exhaustive-deps
  // an article derived again under a newer projection may count differently; the item takes the new count
  useEffect(() => {
    if (article && owner && row && row.words !== article.words) reconcileWords(store(), Math.floor(Date.now() / 1000), owner, hash, article.words);
  }, [article, owner, hash, row?.words]); // eslint-disable-line react-hooks/exhaustive-deps
  const voice = useVoice();
  // the images fetched and shown, at most MAX_ARTICLE_IMAGES: a figure past them is left out, so a page naming
  // thousands doesn't have each one looked up again whenever an image arrives
  const urls = useMemo(() => (article ? imageUrls(article.blocks) : []), [article]);
  const imgs = useLive(() => {
    const now = Math.floor(Date.now() / 1000);
    return new Map(urls.map((u) => {
      const r = getImage(store(), u);
      return [u, { row: r, failed: !!r && !r.path && !needsFetch(r, now), online } as FigureState];
    }));
  }, ['images'], [urls, online]);
  // The article's images are fetched when it opens, on any network (4.5); those already here count as used.
  useEffect(() => {
    if (article) markUsed(store(), urls, Math.floor(Date.now() / 1000));
  }, [article, urls]);
  useEffect(() => {
    if (article && online && owner) fetchArticleImages(imagePorts(), owner, hash).catch(() => undefined);
  }, [article, online, owner, hash]);
  const viewRange = useRef<(() => { first: number; last: number }) | null>(null);
  const jump = useRef<((word: number) => void) | null>(null);
  const [rsvpAt, setRsvpAt] = useState<number | null>(null);
  const lifted = !!voice;

  useFocusEffect(useCallback(() => setToastFloor((lifted ? DOCK_LIFTED : 16) + 52), [lifted]));
  useEffect(() => {
    setReading(hash);
    warmVoice();
    return () => setReading(null);
  }, [hash]);
  // A text marked here whose file is gone is fetched again; one still to come is fetched first (4.5).
  useEffect(() => {
    if (!row) return;
    if (cached && article === null) textLost(store(), owner, hash);
    if (!cached && online) runSync().catch(() => undefined);
  }, [row?.text_state, cached, article, online]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!row) return <View style={{ flex: 1, backgroundColor: P.bg }} />;
  if (row.text_state === 'failed') return <OriginalView row={row} failedSave />;

  const reopen = () => router.push(`/reader/${row.hash}`);
  const menu = () => openSheet(S.reader.more, () => (
    <View>
      {row.state === 'archived' && <MenuItem icon="restore" label={S.reader.menu.backToUnread} onPress={() => closeSheet(() => { router.back(); archive(row.hash, false, reopen); })} />}
      <MenuItem icon="ext" label={S.reader.menu.openOriginal} onPress={() => closeSheet(() => router.push(`/reader/${row.hash}/original`))} />
      <MenuItem icon="link" label={S.reader.menu.copyLink} onPress={() => closeSheet(() => Clipboard.setStringAsync(row.url).then(() => showToast({ text: S.toast.linkCopied, hash: row.hash })))} />
      <MenuItem icon="trash" label={S.reader.menu.delete} danger onPress={() => closeSheet(() => { router.back(); stopIfPlaying(row.hash); remove(row.hash, reopen); })} />
    </View>
  ));
  // Speed read starts on the spoken word, else the saved word if it's in view, else the paragraph in view, and pauses
  // the voice (FD 21, FD 36)
  const openSpeedRead = () => {
    if (!article) return;
    const range = viewRange.current?.() ?? { first: row.position_word, last: row.position_word };
    const at = voice?.hash === row.hash && !voice.ended ? voice.word : startWord(row.position_word, range, article.words);
    pauseVoice();
    setRsvpAt(at);
  };
  // Leaving writes the one position and moves the voice to the same word (FD 36)
  const leaveSpeedRead = (w: number) => {
    setRsvpAt(null);
    setPosition(store(), now(), owner, row.hash, w, true);
    runOutbox().catch(() => 0);
    if (voice?.hash === row.hash && !voice.ended) jumpTo(w);
    requestAnimationFrame(() => jump.current?.(w));
  };
  const waiting = !cached || !article;
  const playingHere = voice?.hash === row.hash;
  const onListen = () => {
    if (!article) return;
    const range = viewRange.current?.() ?? { first: row.position_word, last: row.position_word };
    startListening(row, startWord(row.position_word, range, article.words)).catch(() => undefined);
  };
  return (
    <View style={{ flex: 1, backgroundColor: P.bg, paddingTop: insets.top }}>
      <StatusBar style={P.id === 'dark' ? 'light' : 'dark'} />
      <Bar
        row={row} P={P} onAa={() => openSheet(S.reader.aaSheet.title, () => <AaSheet hash={row.hash} />)} onMore={menu} onSpeedRead={waiting ? undefined : openSpeedRead}
        chip={waiting ? undefined : <ListenChip P={P} gone={playingHere} onPress={onListen} />}
      />
      {waiting ? (
        <ScrollView contentContainerStyle={{ paddingTop: 16, paddingHorizontal: 20, paddingBottom: 140 }}>
          <View style={{ marginTop: -16, marginHorizontal: -20, marginBottom: 22 }}>
            <Cover hash={row.hash} size={width / 3} cols={3} square />
          </View>
          {online ? <Skeleton muted={P.muted} /> : (
            <View style={{ alignItems: 'flex-start', gap: 8, paddingTop: 8, paddingBottom: 24 }}>
              <View style={{ width: 48, height: 48, borderRadius: radius.button, borderWidth: 1, borderColor: alpha(P.muted, 0.3), alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="hourglass" size={22} color={P.muted} />
              </View>
              <T style={[ui(15, 'title', 1.45), { color: P.text }]}>{row.title ?? row.url.replace(/^https?:\/\//, '')}</T>
              <T style={[ui(15, 'body', 1.45), { color: P.muted }]}>{S.reader.offlineWait}</T>
            </View>
          )}
        </ScrollView>
      ) : (
        <>
          <Article key={`${row.hash}`} row={row} P={P} owner={owner} article={article} voice={voice} viewRange={viewRange} jump={jump} imgs={imgs} />
          <ArchiveDock
            archived={row.state === 'archived'} bg={P.bg} fg={P.text} shadow={P.float} lifted={lifted}
            onPress={() => { router.back(); archive(row.hash, row.state !== 'archived', reopen); }}
          />
          {playingHere && voice && <ReaderTier s={voice} P={P} bottom={16 + insets.bottom} />}
          {rsvpAt !== null && 'sentences' in article && (
            <SpeedRead
              row={row} P={P} sentences={article.sentences} blocks={article.blocks} start={rsvpAt} onExit={leaveSpeedRead}
              onArchive={(w) => {
                setPosition(store(), now(), owner, row.hash, w, false);
                setRsvpAt(null);
                router.back();
                archive(row.hash, row.state !== 'archived', reopen);
              }}
            />
          )}
        </>
      )}
    </View>
  );
}
