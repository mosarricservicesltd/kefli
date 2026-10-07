// In-flow notices (prototype .banner): one component on the surface with a hairline, the icon muted, 13/500 text.
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { radius } from '@shelf/tokens';
import { Icon, type IconName } from './Icon';
import { T, ui } from './text';
import { useTheme } from './theme';

export function Banner({ icon = 'wifioff', text, style }: { icon?: IconName; text: string; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return (
    <View accessibilityLiveRegion="polite" style={[{ marginTop: 4, marginHorizontal: 16, marginBottom: 12, flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }, style]}>
      <Icon name={icon} size={16} color={c.muted} />
      <T style={[ui(13, 'meta', 1.4), { flex: 1 }]}>{text}</T>
    </View>
  );
}
