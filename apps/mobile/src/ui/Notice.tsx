// In-flow notices (prototype .banner): one component on the surface with a hairline, the icon muted, 13/500 text.
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { radius } from '@shelf/tokens';
import { mix } from './colour';
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

/** An error line (prototype .errline): the alert in the error colour on a tenth of it over the surface. */
export function ErrLine({ text, style }: { text: string; style?: StyleProp<ViewStyle> }) {
  const { c } = useTheme();
  return (
    <View accessibilityLiveRegion="assertive" style={[{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.container, backgroundColor: mix(c.surface, c.error, 0.1), marginBottom: 16 }, style]}>
      <View style={{ marginTop: 1 }}><Icon name="alert" size={16} color={c.error} /></View>
      <T style={[ui(13, 'meta', 1.4), { flex: 1 }]}>{text}</T>
    </View>
  );
}
