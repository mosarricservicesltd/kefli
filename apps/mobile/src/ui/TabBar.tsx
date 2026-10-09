// The tab bar (prototype tabbar()): 64 tall on the page colour with a hairline above. The active tab's tile is a
// selected layer (the fill, the icon in the page colour) over the plain icon, crossfading from one tab to the next
// (motion.quick). The lit tab always matches the screen (FD 33). Below it, the system's gesture area in the same colour.
import { View } from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius } from '@kefli/tokens';
import { quickIn, quickOut } from '@kefli/tokens/reanimated';
import { Icon, type IconName } from './Icon';
import { Press, pressLayer } from './Press';
import { S } from './strings';
import { T, ui } from './text';
import { useTheme } from './theme';

export const TAB_BAR_HEIGHT = 64;

const TABS: { name: string; icon: IconName; label: string }[] = [
  { name: 'index', icon: 'bookmark', label: S.tabs.saves },
  { name: 'listen', icon: 'headphones', label: S.tabs.listen },
  { name: 'you', icon: 'user', label: S.tabs.you },
];

function Tile({ on, icon }: { on: boolean; icon: IconName }) {
  const { c } = useTheme();
  const st = useAnimatedStyle(() => ({ opacity: withTiming(on ? 1 : 0, on ? quickIn : quickOut) }), [on]);
  return (
    <View style={{ width: 52, height: 28, borderRadius: radius.control, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={22} color={c.muted} />
      <Animated.View style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radius.control, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center' }, st]}>
        <Icon name={icon} size={22} color={c.onFill} />
      </Animated.View>
    </View>
  );
}

export function TabBar({ state, navigation }: { state: { index: number; routes: { key: string; name: string }[] }; navigation: { navigate: (name: string) => void; emit: (e: { type: 'tabPress'; target: string; canPreventDefault: true }) => { defaultPrevented: boolean } } }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ backgroundColor: c.background, paddingBottom: insets.bottom }}>
      <View accessibilityRole="tablist" style={{ height: TAB_BAR_HEIGHT, flexDirection: 'row', borderTopWidth: 1, borderTopColor: c.line }}>
        {TABS.map((tab) => {
          const route = state.routes.find((r) => r.name === tab.name);
          const on = state.routes[state.index]?.name === tab.name;
          return (
            <Press
              key={tab.name} accessibilityRole="tab" accessibilityState={{ selected: on }} accessibilityLabel={tab.label} layer={pressLayer(c.text)}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3 }}
              onPress={() => {
                if (!route) return;
                const e = navigation.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
                if (!on && !e.defaultPrevented) navigation.navigate(tab.name);
              }}
            >
              <Tile on={on} icon={tab.icon} />
              <T style={[ui(13, on ? 'heading' : 'meta', 1.1), { color: on ? c.text : c.muted }]}>{tab.label}</T>
            </Press>
          );
        })}
      </View>
    </View>
  );
}
