// A progress line (signature 2): a full-width fill in a clipped track, moved by translateX = (p − 1) × width, so its
// rounded end keeps its shape and only transform animates (motion rule).
import { useState } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';

export function SlidingLine({ p, color, height, style, round = false }: { p: SharedValue<number>; color: string; height: number; style?: StyleProp<ViewStyle>; round?: boolean }) {
  const [w, setW] = useState(0);
  const st = useAnimatedStyle(() => ({ transform: [{ translateX: (p.value - 1) * w }] }), [w]);
  return (
    <View onLayout={(e) => setW(e.nativeEvent.layout.width)} style={[{ height, overflow: 'hidden' }, style]}>
      <Animated.View style={[{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: color }, round ? { borderRadius: 999 } : { borderTopRightRadius: 2, borderBottomRightRadius: 2 }, st]} />
    </View>
  );
}
