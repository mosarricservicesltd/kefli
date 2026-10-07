// Press feedback (motion spec, press layer): a layer of the content colour at 8% on paper and surfaces, the page
// colour at 12% on fills; in at once, out on motion.press.out. No ripple.
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { motion } from '@shelf/tokens';
import { alpha } from './theme';

export function Press({ children, layer, style, ...p }: Omit<PressableProps, 'style' | 'children'> & {
  children: ReactNode; layer: string; style?: StyleProp<ViewStyle>; tone?: 'page' | 'fill';
}) {
  const [down, setDown] = useState(false);
  const flat = StyleSheet.flatten(style) ?? {};
  return (
    <Pressable {...p} onPressIn={(e) => { setDown(true); p.onPressIn?.(e); }} onPressOut={(e) => { setDown(false); p.onPressOut?.(e); }} style={style}>
      {children}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, {
          borderRadius: flat.borderRadius, backgroundColor: layer, opacity: down ? 1 : 0,
          transitionProperty: 'opacity', transitionDuration: down ? 0 : motion.press.out.duration, transitionTimingFunction: 'ease-in',
        }]}
      />
    </Pressable>
  );
}

/** The press layer colour for content of colour ink on a page or a fill. */
export const pressLayer = (ink: string, tone: 'page' | 'fill' | 'reader' = 'page') => alpha(ink, motion.press.layer[tone]);
