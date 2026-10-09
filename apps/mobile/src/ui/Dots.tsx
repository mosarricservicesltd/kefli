// Waiting marks (prototype .dots and .pdot): squares with 2 px corners breathing in opacity once a wait passes
// 150 ms (motion.ambient), each a phase behind the last. Reduced motion holds them still.
import { useEffect } from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { motion } from '@kefli/tokens';
import { ambient } from '@kefli/tokens/reanimated';

function Breathe({ color, size, delay }: { color: string; size: number; delay: number }) {
  const o = useSharedValue(1);
  const still = useReducedMotion();
  useEffect(() => {
    if (still) return;
    const [lo] = motion.ambient.breathe.opacity;
    o.value = withDelay(motion.ambient.delay + delay, withRepeat(withSequence(withTiming(lo, ambient.breathe), withTiming(1, ambient.breathe)), -1));
  }, [o, delay, still]);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ width: size, height: size, borderRadius: 2, backgroundColor: color }, st]} />;
}

/** Three breathing squares (busy buttons and waiting blocks). */
export function Dots({ color, size = 10, gap = 6 }: { color: string; size?: number; gap?: number }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flexDirection: 'row', gap }}>
      {[0, 1, 2].map((i) => <Breathe key={i} color={color} size={size} delay={i * motion.ambient.breathe.phase} />)}
    </View>
  );
}

/** The one waiting dot in a row's meta line, in the article's ink. */
export function WaitDot({ color }: { color: string }) {
  return <Breathe color={color} size={8} delay={0} />;
}
