// The floating Archive (prototype .dock .arch): 52 square at right 16, bottom 16 above the system bar, on a float
// surface; Back to Unread for an archived article.
import { View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius } from '@shelf/tokens';
import { Icon } from '../ui/Icon';
import { Press, pressLayer } from '../ui/Press';
import { S } from '../ui/strings';

export const DOCK = 16 + 52;

export function ArchiveDock({ archived, onPress, bg, fg, shadow }: { archived: boolean; onPress: () => void; bg: string; fg: string; shadow: string }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={{ position: 'absolute', right: 16, bottom: 16 + insets.bottom, zIndex: 3 }}>
      <Press
        accessibilityRole="button" accessibilityLabel={archived ? S.reader.backToUnread : S.reader.archive} onPress={onPress} layer={pressLayer(fg, 'reader')}
        style={{ width: 52, height: 52, borderRadius: radius.container, backgroundColor: bg, boxShadow: shadow, alignItems: 'center', justifyContent: 'center' }}
      >
        <Icon name={archived ? 'restore' : 'archive'} size={22} color={fg} />
      </Press>
    </View>
  );
}
