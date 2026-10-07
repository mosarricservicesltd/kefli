// Buttons (prototype .btn): one fill rule, ink on paper and paper on ink in dark (FD 66). 48 tall, radius 12,
// 15/620 labels centred on their capitals. Busy shows three dots at full opacity and is never disabled (fix 28).
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { radius } from '@shelf/tokens';
import { Icon, type IconName } from './Icon';
import { Press, pressLayer } from './Press';
import { T, ui } from './text';
import { useTheme } from './theme';
import { Dots } from './Dots';

export type ButtonKind = 'primary' | 'secondary' | 'quiet' | 'danger';

export function Button({ label, kind = 'primary', icon, onPress, disabled, busy, full, style, colors }: {
  label: string; kind?: ButtonKind; icon?: IconName; onPress?: () => void; disabled?: boolean; busy?: boolean; full?: boolean;
  style?: StyleProp<ViewStyle>;
  /** The reader palette's fill and text, for buttons on reading surfaces. */
  colors?: { fill: string; onFill: string; bg: string; text: string; edge: string };
}) {
  const { c } = useTheme();
  const fill = colors?.fill ?? c.fill;
  const onFill = colors?.onFill ?? c.onFill;
  // danger (prototype .btn.danger): the error fill, or its outline on the surface while disabled
  const fg = kind === 'primary' || (kind === 'danger' && !disabled) ? onFill : kind === 'danger' ? c.error : colors?.text ?? c.text;
  const box: ViewStyle = kind === 'primary'
    ? { backgroundColor: fill }
    : kind === 'danger' ? { backgroundColor: disabled ? c.surface : c.error, borderWidth: 1.5, borderColor: c.error }
    : kind === 'secondary' ? { backgroundColor: colors?.bg ?? c.surface, borderWidth: 1, borderColor: colors?.edge ?? c.line } : {};
  return (
    <Press
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: !!disabled, busy: !!busy }}
      disabled={disabled || busy} onPress={onPress} layer={pressLayer(fg, kind === 'primary' || kind === 'danger' ? 'fill' : 'page')}
      style={[{ height: 48, paddingHorizontal: 22, borderRadius: radius.button, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: disabled ? 0.45 : 1 }, full && { alignSelf: 'stretch' }, box, style]}
    >
      {busy ? <Dots color={fg} size={6} gap={4} /> : (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {icon && <Icon name={icon} size={18} color={fg} />}
          <T style={[ui(15, 'title', 1), { color: fg }, kind === 'quiet' && { textDecorationLine: 'underline', textDecorationColor: c.lineStrong }]}>{label}</T>
        </View>
      )}
    </Press>
  );
}
