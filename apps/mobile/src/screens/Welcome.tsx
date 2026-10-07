// Welcome (mobile spec 5.2; prototype welcome, welcome-early, welcome-early-many): three saves fanned out, each
// wearing its cover, the front one part read in its own ink; then New here and I already have a shelf. After a
// share before the first open, a note with the newest early save's cover says the saves are kept either way.
import { useState } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { radius } from '@shelf/tokens';
import { activeOwner, listRows } from '../data/library';
import { answerNewHere } from '../services/app';
import { store } from '../services/store';
import { Button } from '../ui/Button';
import { Cover } from '../ui/Cover';
import { ShelfCover } from '../ui/cover';
import { Icon } from '../ui/Icon';
import { S } from '../ui/strings';
import { T, display28, ui } from '../ui/text';
import { alpha, useTheme } from '../ui/theme';

// The prototype's three hero saves: the same addresses, so the same covers.
const HERO = {
  stratechery: '9f40a2ca59c109dd3b5c4f5c3c88fd84ff5579309ebdec62e3294eebb5d4fbd4',
  guardian: '5971c1f7c8fb6934c0db39d1cf17cfede14197bc087924dab4cc59ae13aa8cff',
  relays: '34331f690e10f4e9184b0c53e40388e8caeb8bd26c8f44a34ae11f7f9e62213d',
};

function HeroCard({ rot, x, y, z, hash, lines, progress }: { rot: number; x: number; y: number; z: number; hash: string; lines: string[]; progress?: number }) {
  const { c } = useTheme();
  const ln = (w: string, h: number, color: string, mb = 8) => <View style={{ width: w as `${number}%`, height: h, borderRadius: 999, backgroundColor: color, marginBottom: mb }} />;
  return (
    <View style={{
      position: 'absolute', left: '50%', top: '50%', width: 236, marginLeft: -118, padding: 12, flexDirection: 'row', gap: 12, alignItems: 'flex-start',
      backgroundColor: c.surface, borderRadius: radius.container, boxShadow: c.shadowFloat, zIndex: z, overflow: 'hidden',
      transform: [{ translateX: x }, { translateY: y }, { rotate: `${rot}deg` }],
    }}>
      <View style={{ flex: 1, minWidth: 0, paddingTop: 2 }}>
        {ln('40%', 6, c.line)}
        {ln('92%', 9, alpha(c.text, 0.7))}
        {ln('64%', 9, alpha(c.text, 0.7), 12)}
        {lines.map((w) => <View key={w}>{ln(w, 8, c.line)}</View>)}
      </View>
      <Cover hash={hash} size={48} />
      {progress !== undefined && (
        <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, overflow: 'hidden' }}>
          <View style={{ width: `${progress * 100}%`, height: 3, borderTopRightRadius: 2, borderBottomRightRadius: 2, backgroundColor: ShelfCover.lineInk(hash, c.surface, c.text) }} />
        </View>
      )}
    </View>
  );
}

export default function Welcome() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  // saves shared before the first open (FD 6): the newest one's cover and the count
  const owner = activeOwner(store());
  const early = owner ? listRows(store(), owner, 'unread') : [];
  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top }}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ flex: 1, minHeight: Math.min(300, height * 0.35) }}>
        <HeroCard rot={-6} x={-20} y={-150} z={1} hash={HERO.stratechery} lines={['30%']} />
        <HeroCard rot={4} x={18} y={-78} z={2} hash={HERO.guardian} lines={['40%']} />
        <HeroCard rot={-1} x={0} y={-4} z={3} hash={HERO.relays} lines={['22%']} progress={0.45} />
      </View>
      <View style={{ paddingVertical: 8, paddingHorizontal: 16 }}>
        <T accessibilityRole="header" style={[display28, { marginBottom: 8 }]}>{S.welcome.title}</T>
        <T muted style={[ui(15, 'body', 1.45), { marginBottom: 16 }]}>{S.welcome.lead}</T>
        {early.length > 0 && (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingLeft: 12, paddingRight: 16, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, marginBottom: 16 }}>
            <Cover hash={early[0].hash} size={36} />
            <T style={[ui(13, 'body', 1.45), { flex: 1 }]}>{early.length > 1 ? S.welcome.earlyMany(early.length) : S.welcome.earlyOne}</T>
          </View>
        )}
      </View>
      <View style={{ paddingHorizontal: 16, paddingBottom: 24 + insets.bottom, gap: 8 }}>
        <Button label={S.welcome.newHere} full busy={busy} onPress={() => { setBusy(true); answerNewHere().catch(() => setBusy(false)); }} />
        <Button label={S.welcome.haveShelf} kind="secondary" full onPress={() => router.push('/return')} />
        <View style={{ marginTop: 4, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
          <Icon name="shield" size={14} color={c.muted} />
          <T muted style={ui(13, 'body', 1.45)}>{S.welcome.fine}</T>
        </View>
      </View>
    </View>
  );
}
