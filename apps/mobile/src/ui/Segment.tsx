// A segment (prototype .seg): Saves' Unread and Archive, Voice's languages (FD 109). The selected layer, the fill with
// the label in on-fill, crossfades in over the plain one.
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { radius } from '@kefli/tokens';
import { quickIn, quickOut } from '@kefli/tokens/reanimated';
import { Press, pressLayer } from './Press';
import { T, ui } from './text';
import { useTheme } from './theme';

export function Segment({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const { c } = useTheme();
  const st = useAnimatedStyle(() => ({ opacity: withTiming(on ? 1 : 0, on ? quickIn : quickOut) }), [on]);
  return (
    <Press accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={onPress} layer={pressLayer(c.text)} style={{ height: 36, paddingHorizontal: 16, borderRadius: radius.control, borderWidth: 1, borderColor: c.line, justifyContent: 'center' }}>
      <T style={ui(13, 'label', 1)}>{label}</T>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: -1, left: -1, right: -1, bottom: -1, borderRadius: radius.control, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center' }, st]}>
        <T style={[ui(13, 'label', 1), { color: c.onFill }]}>{label}</T>
      </Animated.View>
    </Press>
  );
}
