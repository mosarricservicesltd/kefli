// The Reader's skeleton (prototype skelLines): source, two title lines and nine of text, shown once the wait passes
// 150 ms and pulsing in opacity (motion.ambient pulse).
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { motion, radius } from '@kefli/tokens';
import { ambient } from '@kefli/tokens/reanimated';
import { alpha } from '../ui/theme';

const WIDTHS = [100, 96, 92, 98, 60, 100, 94, 97, 72];

export function Skeleton({ muted }: { muted: string }) {
  const o = useSharedValue(1);
  const still = useReducedMotion();
  useEffect(() => {
    if (still) return;
    const [lo] = motion.ambient.pulse.opacity;
    o.value = withDelay(motion.ambient.delay, withRepeat(withSequence(withTiming(lo, ambient.pulse), withTiming(1, ambient.pulse)), -1));
  }, [o, still]);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  const bar = (h: number, w: number, mb = 8) => <Animated.View style={[{ height: h, width: `${w}%`, borderRadius: radius.image, backgroundColor: alpha(muted, 0.18), marginBottom: mb }, st]} />;
  return (
    <Animated.View entering={FadeIn.delay(motion.ambient.delay).duration(motion.quickIn.duration)} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {bar(12, 40)}
      {bar(28, 95)}
      {bar(28, 70, 24)}
      {WIDTHS.map((w, i) => <View key={i}>{bar(14, w)}</View>)}
    </Animated.View>
  );
}
