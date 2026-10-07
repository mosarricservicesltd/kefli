// The toast (prototype toastHTML, mobile spec 6.8): the fill with paper on it, 8 px above the screen's bottom layer.
// One at a time: a new toast replaces the shown one, which counts as closed without Undo. Its countdown runs
// getRecommendedTimeoutMillis(5000) in the article's ink (3:1 on the fill), pauses while touched or under a sheet,
// and never runs out while a screen reader is on (5.9). Undo calls the toast's undo; any other close calls commit.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { AccessibilityInfo, Pressable, View } from 'react-native';
import Animated, { Easing, FadeIn, SlideInDown, SlideOutDown, useAnimatedStyle, useSharedValue, withTiming, cancelAnimation } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { motion, radius } from '@shelf/tokens';
import { enter, exit } from '@shelf/tokens/reanimated';
import { S } from './strings';
import { T, ui } from './text';
import { useTheme } from './theme';
import { ShelfCover } from './cover';
import { sheetOpen } from './sheet';

export type ToastSpec = { text: string; undo?: () => void; commit?: () => void; hash?: string | null };
type Shown = ToastSpec & { id: number };

let shown: Shown | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function showToast(t: ToastSpec): void {
  const prev = shown;
  shown = { ...t, id: ++seq };
  prev?.commit?.();
  emit();
}

function close(id: number, how: 'undo' | 'timeout'): void {
  if (!shown || shown.id !== id) return;
  const t = shown;
  shown = null;
  emit();
  if (how === 'undo') t.undo?.();
  else t.commit?.();
}

/** Commits whatever toast shows (a process going to the background counts as the toast closing). */
export function settleToast(): void {
  if (shown) close(shown.id, 'timeout');
}

const subscribe = (l: () => void) => (listeners.add(l), () => listeners.delete(l));

// The bottom layer the toast sits 8 px above: the tab bar (64) on tab screens, Archive (16 + 52) in the Reader.
let floor = 64;
const floorListeners = new Set<() => void>();
export function setToastFloor(px: number): void {
  floor = px;
  floorListeners.forEach((l) => l());
}

export function ToastHost() {
  const t = useSyncExternalStore(subscribe, () => shown);
  const f = useSyncExternalStore((l) => (floorListeners.add(l), () => floorListeners.delete(l)), () => floor);
  const insets = useSafeAreaInsets();
  if (!t) return null;
  return <Toast key={t.id} t={t} bottom={insets.bottom + f + 8} />;
}

function Toast({ t, bottom }: { t: Shown; bottom: number }) {
  const { c } = useTheme();
  const ink = t.hash ? ShelfCover.lineInk(t.hash, c.fill, c.onFill) : c.onFill;
  const covered = useSyncExternalStore((l) => sheetOpen.subscribe(l), () => sheetOpen.get());
  const left = useRef<number | null>(null);
  const started = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bar = useSharedValue(0);
  const touching = useRef(false);
  const reader = useRef(false);

  const pause = () => {
    if (timer.current === null || left.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
    left.current = Math.max(0, left.current - (Date.now() - started.current));
    cancelAnimation(bar);
  };
  const run = () => {
    if (timer.current !== null || left.current === null || reader.current || touching.current || sheetOpen.get()) return;
    started.current = Date.now();
    timer.current = setTimeout(() => close(t.id, 'timeout'), left.current);
    bar.value = withTiming(1, { duration: left.current, easing: Easing.linear });
  };

  useEffect(() => {
    let live = true;
    Promise.all([AccessibilityInfo.getRecommendedTimeoutMillis(motion.countdown.toast), AccessibilityInfo.isScreenReaderEnabled()]).then(([ms, sr]) => {
      if (!live) return;
      left.current = ms;
      reader.current = sr;
      run();
    });
    return () => {
      live = false;
      if (timer.current !== null) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => (covered ? pause() : run()), [covered]); // eslint-disable-line react-hooks/exhaustive-deps

  const barStyle = useAnimatedStyle(() => ({ transform: [{ translateX: `${-bar.value * 100}%` }] }));
  return (
    <Animated.View
      entering={SlideInDown.duration(motion.enter.duration).easing(enter.easing!)}
      exiting={SlideOutDown.duration(motion.exit.duration).easing(exit.easing!)}
      accessibilityLiveRegion="polite" accessibilityRole="alert"
      onTouchStart={() => { touching.current = true; pause(); }}
      onTouchEnd={() => { touching.current = false; run(); }}
      onTouchCancel={() => { touching.current = false; run(); }}
      style={{
        position: 'absolute', left: 16, right: 16, bottom, minHeight: 52, borderRadius: radius.container, backgroundColor: c.fill,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingLeft: 16, paddingRight: t.undo ? 4 : 16,
        overflow: 'hidden', zIndex: 30, elevation: 8,
      }}
    >
      <Animated.View entering={FadeIn.duration(motion.quickIn.duration)} style={{ flex: 1 }}>
        <T style={[ui(15, 'meta', 1.45), { color: c.onFill }]}>{t.text}</T>
      </Animated.View>
      {t.undo && (
        <Pressable accessibilityRole="button" onPress={() => close(t.id, 'undo')} style={{ height: 48, paddingHorizontal: 12, borderRadius: radius.control, justifyContent: 'center' }}>
          <T style={[ui(15, 'title', 1), { color: c.onFill }]}>{S.toast.undo}</T>
        </Pressable>
      )}
      <View pointerEvents="none" style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 2, overflow: 'hidden' }}>
        <Animated.View style={[{ flex: 1, backgroundColor: ink }, barStyle]} />
      </View>
    </Animated.View>
  );
}
