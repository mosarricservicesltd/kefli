// The launch screen on a cold open (FD 97, motion.launch). It takes over from the system splash with the same image in
// the same place (the icon's central 72 dp at 200 dp, centred, as app.json's splash plugin draws it), then the name and
// the Hávamál lines fade in. It holds for motion.launch.hold from its first frame, or until the app is ready if that
// is later, and a tap anywhere ends the hold early; then it fades out over the first screen. Once per process: the share surface never mounts it, and a return
// to a running app doesn't show it again. Welcome's covers start drawing as the fade ends (launchDrawFrom).
import { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { initialWindowMetrics } from 'react-native-safe-area-context';
import { fontFamily, motion, space, type } from '@kefli/tokens';
import { launchIn, launchOut } from '@kefli/tokens/reanimated';
import { S } from './strings';
import { useTheme } from './theme';

/* eslint-disable @typescript-eslint/no-require-imports */
const MARK = {
  light: require('../../assets/brand/splash-icon.png'),
  dark: require('../../assets/brand/splash-icon-dark.png'),
};
/* eslint-enable @typescript-eslint/no-require-imports */
const MARK_DP = 200;
const NAME_TOP = 76;
const NAME_BOTTOM = NAME_TOP + Math.round(type.display[28].lineHeight);

let shown = false;
let endsAt = 0;

/** When a cover that would draw on the first screen should start: as the launch screen's fade ends, or now. */
export function launchDrawFrom(now = Date.now()): number {
  return Math.max(now, endsAt);
}

export function Launch({ ready }: { ready: boolean }) {
  const { name, c } = useTheme();
  const [on] = useState(() => !shown);
  const [gone, setGone] = useState(false);
  const [held, setHeld] = useState(false);
  // the English wraps to the Old Norse's width, which the first layout measures
  const [norseW, setNorseW] = useState<number | undefined>();
  const words = useSharedValue(0);
  const all = useSharedValue(1);

  useEffect(() => {
    if (!on) return;
    shown = true;
    endsAt = Date.now() + motion.launch.hold + motion.launch.out.duration;
    words.value = withDelay(motion.launch.in.delay, withTiming(1, launchIn));
    const t = setTimeout(() => setHeld(true), motion.launch.hold);
    return () => clearTimeout(t);
  }, [on, words]);

  useEffect(() => {
    if (!on || !held || !ready) return;
    // the fade starts now (at the hold's end, on a tap, or once a slow start is ready), and Welcome's draw-in follows it
    endsAt = Date.now() + motion.launch.out.duration;
    all.value = withTiming(0, launchOut, (done) => done && runOnJS(setGone)(true));
  }, [on, held, ready, all]);

  const wordsStyle = useAnimatedStyle(() => ({ opacity: words.value }));
  const allStyle = useAnimatedStyle(() => ({ opacity: all.value }));
  if (!on || gone) return null;

  const bottom = initialWindowMetrics?.insets.bottom ?? 0;
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, { backgroundColor: c.background }, allStyle]}
      pointerEvents={held && ready ? 'none' : 'auto'}
      onStartShouldSetResponder={() => true}
      onResponderRelease={() => setHeld(true)}
      accessible
      accessibilityRole="button"
      accessibilityLabel={S.launch.label}
      accessibilityHint={S.launch.hint}
      onAccessibilityTap={() => setHeld(true)}
    >
      <Image source={MARK[name]} style={st.mark} fadeDuration={0} />
      <Animated.View style={[st.name, wordsStyle]} importantForAccessibility="no-hide-descendants">
        <Text allowFontScaling={false} style={[type.display[28], { color: c.text, includeFontPadding: false, textAlign: 'center' }]}>{S.launch.name}</Text>
      </Animated.View>
      <Animated.View style={[st.below, { bottom }, wordsStyle]} importantForAccessibility="no-hide-descendants">
        <View style={st.quote}>
        <Text maxFontSizeMultiplier={1.3} style={[st.non, { color: c.text }]} onTextLayout={(e) => setNorseW(Math.ceil(Math.max(...e.nativeEvent.lines.map((l) => l.width))) + 1)}>{S.launch.norse}</Text>
        <Text maxFontSizeMultiplier={1.3} textBreakStrategy="balanced" style={[st.en, { color: c.muted, maxWidth: norseW, opacity: norseW ? 1 : 0 }]}>{S.launch.english}</Text>
        <Text maxFontSizeMultiplier={1.3} style={[st.cite, { color: c.muted }]}>{S.launch.source}</Text>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const st = StyleSheet.create({
  mark: { position: 'absolute', left: '50%', top: '50%', width: MARK_DP, height: MARK_DP, marginLeft: -MARK_DP / 2, marginTop: -MARK_DP / 2 },
  name: { position: 'absolute', left: 0, right: 0, top: '50%', marginTop: NAME_TOP },
  // the lines sit midway between the name and the bottom of the screen
  below: { position: 'absolute', left: space[16], right: space[16], top: '50%', marginTop: NAME_BOTTOM, justifyContent: 'center' },
  quote: { alignItems: 'center' },
  non: { fontFamily: fontFamily.reader.italic, fontSize: 17, lineHeight: 24, textAlign: 'center', includeFontPadding: false },
  en: { fontFamily: fontFamily.reader.italic, fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: space[24], includeFontPadding: false },
  cite: { fontFamily: fontFamily.ui.body, fontSize: 13, lineHeight: 19, textAlign: 'center', marginTop: space[8], includeFontPadding: false },
});
