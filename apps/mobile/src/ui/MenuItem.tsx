// A sheet's menu row (prototype .menuitem): 52 tall, a muted icon and 15/500 text; danger in the error colour.
import { radius } from '@shelf/tokens';
import { Icon, type IconName } from './Icon';
import { Press, pressLayer } from './Press';
import { T, ui } from './text';
import { useTheme } from './theme';

export function MenuItem({ icon, label, onPress, danger }: { icon: IconName; label: string; onPress: () => void; danger?: boolean }) {
  const { c } = useTheme();
  const fg = danger ? c.error : c.text;
  return (
    <Press accessibilityRole="button" onPress={onPress} layer={pressLayer(c.text)} style={{ minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: radius.button, paddingHorizontal: 4 }}>
      <Icon name={icon} size={20} color={danger ? c.error : c.muted} />
      <T style={[ui(15, 'meta', 1.45), { color: fg }]}>{label}</T>
    </Press>
  );
}

/** The title a row's or an article's menu sheet is headed with (prototype .rowmenu-title). */
export function MenuTitle({ children }: { children: string }) {
  return <T numberOfLines={2} style={[ui(15, 'title', 1.45), { marginBottom: 8 }]}>{children}</T>;
}
