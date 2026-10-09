// Sheets (prototype .scrim and .sheet, mobile spec 6.8): Kefli's own, on Reanimated and Gesture Handler. The sheet
// rises on the enter curve and sinks on the exit curve; the scrim's opacity follows its travel. A drag closes past
// 30% of the height or at 1,000 px/s, otherwise the release spring returns it; nothing moves above rest. The scrim
// and Android Back close it. A toast under a sheet waits (sheetOpen). Sheets are dialogs that take focus.
import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { BackHandler, Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius } from '@kefli/tokens';
import { enter, exit, release } from '@kefli/tokens/reanimated';
import { useTheme } from './theme';

type Spec = { id: number; label: string; render: (close: () => void) => ReactNode; onClosed?: () => void; dismissable?: boolean };

let current: Spec | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Whether a sheet is up, for the toast's countdown. */
export const sheetOpen = {
  get: () => current !== null,
  subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
};

export function openSheet(label: string, render: Spec['render'], o: { onClosed?: () => void; dismissable?: boolean } = {}): void {
  current = { id: ++seq, label, render, ...o };
  emit();
}

let closer: (() => void) | null = null;
/** Closes the open sheet with its exit, then runs after (an action that raises a toast after the sheet's exit). */
export function closeSheet(after?: () => void): void {
  if (closer) closer();
  if (after) pendingAfter = after;
}
let pendingAfter: (() => void) | null = null;

export function SheetHost() {
  const s = useSyncExternalStore(sheetOpen.subscribe, () => current);
  if (!s) return null;
  return <Sheet key={s.id} spec={s} />;
}

function Sheet({ spec }: { spec: Spec }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const [h, setH] = useState(0);
  const y = useSharedValue(2000);
  const gone = useCallback(() => {
    if (current?.id === spec.id) current = null;
    emit();
    spec.onClosed?.();
    const after = pendingAfter;
    pendingAfter = null;
    after?.();
  }, [spec]);
  const close = useCallback(() => {
    y.value = withTiming(h || 600, exit, (done) => done && runOnJS(gone)());
  }, [h, y, gone]);

  useEffect(() => {
    closer = close;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => (spec.dismissable === false ? true : (close(), true)));
    return () => {
      if (closer === close) closer = null;
      sub.remove();
    };
  }, [close, spec.dismissable]);

  const onLayout = (e: LayoutChangeEvent) => {
    const first = h === 0;
    const nh = e.nativeEvent.layout.height;
    setH(nh);
    if (first) {
      y.value = nh;
      y.value = withTiming(0, enter);
    }
  };

  const pan = Gesture.Pan()
    .enabled(spec.dismissable !== false)
    .onChange((e) => { y.value = Math.max(0, y.value + e.changeY); })
    .onEnd((e) => {
      if (y.value > h * 0.3 || e.velocityY > 1000) y.value = withTiming(h, exit, (done) => done && runOnJS(gone)());
      else y.value = withSpring(0, { ...release, velocity: e.velocityY });
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: h ? interpolate(y.value, [0, h], [1, 0], 'clamp') : 0 }));

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex: 40, justifyContent: 'flex-end' }]}>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: c.scrim }, scrimStyle]}>
        <Pressable accessibilityElementsHidden importantForAccessibility="no" style={StyleSheet.absoluteFill} onPress={() => spec.dismissable !== false && close()} />
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View
          accessibilityViewIsModal accessibilityLabel={spec.label} onLayout={onLayout}
          style={[{ backgroundColor: c.surface, borderTopLeftRadius: radius.sheet, borderTopRightRadius: radius.sheet, paddingTop: 8, paddingHorizontal: 16, paddingBottom: 24 + insets.bottom }, sheetStyle]}
        >
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: c.lineStrong, opacity: 0.6, alignSelf: 'center', marginBottom: 16 }} />
          {spec.render(close)}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}
