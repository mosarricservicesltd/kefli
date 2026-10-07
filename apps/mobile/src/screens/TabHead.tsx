// A tab screen's header row (prototype .head): the large title left, an optional count right.
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T, display28, ui } from '../ui/text';
import { useTheme } from '../ui/theme';

export function Head({ title, count }: { title: string; count?: string }) {
  return (
    <View style={{ paddingTop: 12, paddingHorizontal: 16, paddingBottom: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <T accessibilityRole="header" style={display28}>{title}</T>
      {count ? <T muted style={[ui(13, 'body', 1.45), { textAlign: 'right', fontVariant: ['tabular-nums'] }]}>{count}</T> : null}
    </View>
  );
}

export function TabHead({ title }: { title: string }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top }}>
      <Head title={title} />
    </View>
  );
}
