// You (mobile spec 5.8, 3.5, FD 17, FD 25, FD 27, FD 68; prototype you, you-done, you-offline, rec-hidden, rec-shown,
// rec-copied): the quilt of the newest covers beside big counts; the backup card until the words are written down;
// then the rows. The recovery code sheet keeps the words out of sight and out of the accessibility tree until "Show
// the words", holds them in JavaScript only while shown, and secures the window while it is open (7.1).
//
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { motion, radius } from '@shelf/tokens';
import { ShelfKeystore } from '../../modules/shelf-keystore/src';
import { ShelfSystem } from '../../modules/shelf-system/src';
import { backupDone, markBackupDone, showBackupCard, snoozeBackup, youStats } from '../data/you';
import { useApp } from '../services/app';
import { store } from '../services/store';
import { Button } from '../ui/Button';
import { Cover } from '../ui/Cover';
import { Icon, type IconName } from '../ui/Icon';
import { useLive } from '../ui/live';
import { useOnline } from '../ui/online';
import { Press, pressLayer } from '../ui/Press';
import { closeSheet, openSheet } from '../ui/sheet';
import { S } from '../ui/strings';
import { T, display28, ui } from '../ui/text';
import { setToastFloor, showToast } from '../ui/toast';
import { TAB_BAR_HEIGHT } from '../ui/TabBar';
import { useTheme } from '../ui/theme';
import { Head } from './TabHead';

const BARS = [58, 46, 64, 52, 40, 60, 50, 66, 44, 56, 62, 48];

function RecoverySheet({ owner, close }: { owner: string; close: () => void }) {
  const { c } = useTheme();
  const [words, setWords] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);
  // the window is secured while the sheet is up (7.1); the words go when it closes
  useEffect(() => {
    ShelfSystem.setSecure(true);
    return () => {
      ShelfSystem.setSecure(false);
      setWords(null);
    };
  }, []);
  const reveal = async () => {
    const m = await ShelfKeystore.readMnemonic(owner).catch(() => null);
    if (!m) return;
    setWords(m.trim().split(/\s+/));
    markBackupDone(store());
  };
  const cell = (i: number) => (
    <View key={i} style={{ width: '48.5%', height: 40, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderRadius: radius.control, backgroundColor: c.background }}>
      <T muted style={[ui(13, 'body', 1), { width: 18, textAlign: 'right' }]}>{i + 1}</T>
      {words ? <T style={ui(15, 'meta', 1.2)}>{words[i]}</T> : <View style={{ width: BARS[i], height: 8, borderRadius: 999, backgroundColor: c.lineStrong, opacity: 0.28 }} />}
    </View>
  );
  return (
    <View>
      <T accessibilityRole="header" style={[ui(20, 'emptyHeading', 1.3, -0.01), { marginBottom: 4 }]}>{S.you.sheetTitle}</T>
      <T muted style={[ui(13, 'body', 1.45), { marginBottom: 16 }]}>{S.you.sheetBody}</T>
      <View style={{ marginBottom: 16 }}>
        <View importantForAccessibility={words ? 'auto' : 'no-hide-descendants'} style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 8 }}>
          {Array.from({ length: 12 }, (_, i) => cell(i))}
        </View>
        {!words && (
          <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <T muted style={ui(13, 'body', 1.45)}>{S.you.noOneLooking}</T>
            <Button label={S.you.showWords} kind="secondary" onPress={reveal} />
          </View>
        )}
      </View>
      {words && <T muted accessibilityLiveRegion="polite" style={[ui(13, 'body', 1.45), { marginBottom: copied ? 16 : 0 }]}>{copied ? S.you.copyNote : ''}</T>}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {words ? (
          <>
            <Button label={copied ? S.you.copied : S.you.copy} icon={copied ? 'check' : 'clipboard'} kind="secondary" style={{ flex: 1 }}
              onPress={() => { ShelfSystem.copySensitive(S.you.sheetTitle, words.join(' ')); setCopied(true); }} />
            <Button label={S.you.done} style={{ flex: 1 }} onPress={close} />
          </>
        ) : <Button label={S.you.notNow} kind="secondary" style={{ flex: 1 }} onPress={close} />}
      </View>
    </View>
  );
}

function Row({ icon, label, sub, warn, value, danger, disabled, onPress, first }: {
  icon: IconName; label: string; sub?: string; warn?: boolean; value?: string; danger?: boolean; disabled?: boolean; onPress?: () => void; first?: boolean;
}) {
  const { c } = useTheme();
  const fg = danger ? c.error : c.text;
  return (
    <Press accessibilityRole="button" accessibilityLabel={label} accessibilityHint={sub} accessibilityState={{ disabled: !!disabled }} disabled={disabled} onPress={onPress} layer={pressLayer(c.text)}
      style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 16, opacity: disabled ? 0.45 : 1 }}>
      {!first && <View style={{ position: 'absolute', left: 48, right: 0, top: 0, height: 1, backgroundColor: c.line }} />}
      <Icon name={icon} size={20} color={danger ? c.error : c.muted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={[ui(15, 'label', 1.3), { color: fg }]}>{label}</T>
        {sub && (warn
          ? (
            <View style={{ alignSelf: 'flex-start', marginTop: 7, height: 24, paddingHorizontal: 7, borderWidth: 1.5, borderColor: c.warning, borderRadius: radius.image, justifyContent: 'center', transform: [{ rotate: '-2deg' }] }}>
              <T style={[ui(13, 'heading', 1), { color: c.warning, letterSpacing: 0.65 }]}>{sub.toUpperCase()}</T>
            </View>
          )
          : <T muted style={[ui(13, 'body', 1.3), { marginTop: 2 }]}>{sub}</T>)}
      </View>
      {value !== undefined && <T muted style={[ui(13, 'body', 1.3), { fontVariant: ['tabular-nums'] }]}>{value}</T>}
      <Icon name="chev" size={18} color={c.muted} />
    </Press>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  const { c } = useTheme();
  return <View style={{ marginHorizontal: 16, marginBottom: 20, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>{children}</View>;
}

export default function You() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const owner = useApp()?.owner ?? '';
  const online = useOnline();
  const stats = useLive(() => youStats(store(), owner), ['items', 'listen_history', 'devices'], [owner]);
  const card = useLive(() => showBackupCard(store(), owner, stats.saves), ['settings', 'items'], [owner, stats.saves]);
  const done = useLive(() => backupDone(store()), ['settings'], []);
  useFocusEffect(useCallback(() => setToastFloor(TAB_BAR_HEIGHT), []));

  const recovery = () => openSheet(S.you.sheetTitle, (close) => <RecoverySheet owner={owner} close={close} />);
  const tiles = Array.from({ length: 8 }, (_, i) => stats.quilt[i]);
  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top }}>
      <ScrollView contentContainerStyle={{ paddingBottom: 96 }}>
        <Head title={S.you.title} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 20, marginTop: 4, marginHorizontal: 16, marginBottom: 16 }}>
          <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 160, flexDirection: 'row', flexWrap: 'wrap', borderRadius: radius.control, overflow: 'hidden', boxShadow: `0px 0px 0px 1px ${c.coverEdge}` }}>
            {tiles.map((q, i) => (q
              ? <Cover key={q.hash} hash={q.hash} size={40} failed={q.failed} square radius={0} />
              : (
                <View key={`gap-${i}`} style={{ width: 40, height: 40, backgroundColor: c.background }}>
                  <View style={{ position: 'absolute', top: 4, left: 4, right: 4, bottom: 4, borderWidth: 1, borderStyle: 'dashed', borderColor: c.lineStrong, borderRadius: 2, opacity: 0.75 }} />
                </View>
              )))}
          </View>
          <View style={{ gap: 6, minWidth: 0 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <T style={[display28, { fontSize: 32, lineHeight: 32, fontVariant: ['tabular-nums'] }]}>{stats.saves}</T>
              <T muted style={ui(15, 'body', 1.2)}>{S.you.saves(stats.saves)}</T>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
              <T style={[display28, { fontSize: 32, lineHeight: 32, fontVariant: ['tabular-nums'] }]}>{stats.listened}</T>
              <T muted style={ui(15, 'body', 1.2)}>{S.you.listened}</T>
            </View>
          </View>
        </View>
        {card && (
          <Animated.View entering={FadeIn.duration(motion.quickIn.duration)} style={{ marginHorizontal: 16, marginBottom: 16, padding: 16, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <Icon name="shield" size={20} color={c.text} />
              <T accessibilityRole="header" style={ui(17, 'heading', 1.3)}>{S.you.backupTitle}</T>
            </View>
            <T muted style={[ui(13, 'body', 1.45), { marginBottom: 16 }]}>{S.you.backupBody}</T>
            <View style={{ flexDirection: 'row', gap: 8, justifyContent: 'flex-end' }}>
              <Button label={S.you.later} kind="secondary" onPress={() => { snoozeBackup(store(), stats.saves); showToast({ text: S.you.snoozed }); }} />
              <Button label={S.you.showCode} onPress={recovery} />
            </View>
          </Animated.View>
        )}
        <Group>
          <Row first icon="keyboard" label={S.you.recovery} sub={done ? S.you.written : S.you.notWritten} warn={!done} onPress={recovery} />
          <Row icon="phone" label={S.you.addDevice} disabled={!online} sub={online ? undefined : S.you.needsConnection} onPress={() => router.push('/add-device')} />
          <Row icon="laptop" label={S.you.browsers} value={String(stats.browsers)} onPress={() => router.push('/browsers')} />
        </Group>
        <Group><Row first icon="settings" label={S.you.advanced} onPress={() => router.push('/advanced')} /></Group>
        <Group><Row first icon="trash" label={S.you.deleteData} danger onPress={() => router.push('/delete')} /></Group>
      </ScrollView>
    </View>
  );
}
