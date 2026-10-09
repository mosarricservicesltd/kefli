// Pushed screens (prototype onbShell): a pinned 56 px bar with ← at x = 8, the large title in the body, and an
// optional action bar at the bottom; no tab bar.
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius } from '@kefli/tokens';
import { Icon, type IconName } from '../ui/Icon';
import { Press, pressLayer } from '../ui/Press';
import { S } from '../ui/strings';
import { T, display28, ui } from '../ui/text';
import { useTheme } from '../ui/theme';

export function IconButton({ icon, label, onPress, color, size = 22 }: { icon: IconName; label: string; onPress: () => void; color?: string; size?: number }) {
  const { c } = useTheme();
  const fg = color ?? c.text;
  return (
    <Press accessibilityRole="button" accessibilityLabel={label} onPress={onPress} layer={pressLayer(fg)} style={{ width: 48, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={size} color={fg} />
    </Press>
  );
}

export function OnbShell({ title, children, actions, back = () => router.back() }: { title: string; children: ReactNode; actions?: ReactNode; back?: (() => void) | null }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top }}>
      <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8 }}>
        {back && <IconButton icon="back" label={S.back} onPress={back} />}
      </View>
      <ScrollView contentContainerStyle={{ paddingVertical: 8, paddingHorizontal: 16 }}>
        <T accessibilityRole="header" style={[display28, { marginBottom: 8 }]}>{title}</T>
        {children}
      </ScrollView>
      {actions && <View style={{ paddingTop: 16, paddingHorizontal: 16, paddingBottom: 24 + insets.bottom, gap: 8 }}>{actions}</View>}
    </View>
  );
}

/** The lead under a title; **words** between double asterisks are the names of buttons, set in the text colour and bold. */
export function Lead({ children }: { children: string }) {
  const { c } = useTheme();
  const parts = children.split('**');
  return (
    <T muted style={[ui(15, 'body', 1.45), { marginBottom: 24 }]}>
      {parts.map((p, i) => (i % 2 ? <T key={i} style={[ui(15, 'heading', 1.45), { color: c.text }]}>{p}</T> : p))}
    </T>
  );
}

/** A choice row (prototype .choice): icon tile, title and line, chevron. */
export function Choice({ icon, title, line, onPress, disabled }: { icon: IconName; title: string; line: string; onPress?: () => void; disabled?: boolean }) {
  const { c } = useTheme();
  return (
    <Press
      accessibilityRole="button" accessibilityLabel={title} accessibilityHint={line} accessibilityState={{ disabled: !!disabled }} disabled={disabled}
      onPress={onPress} layer={pressLayer(c.text)}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 76, paddingVertical: 12, paddingLeft: 12, paddingRight: 16, marginBottom: 10, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, opacity: disabled ? 0.45 : 1 }}
    >
      <View style={{ width: 44, height: 44, borderRadius: radius.button, backgroundColor: c.background, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={22} color={c.text} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={ui(15, 'title', 1.45)}>{title}</T>
        <T muted style={ui(13, 'body', 1.45)}>{line}</T>
      </View>
      <Icon name="chev" size={18} color={c.muted} />
    </Press>
  );
}
