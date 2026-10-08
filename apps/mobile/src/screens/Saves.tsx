// Saves (mobile spec 5.2, 5.6; prototype saves, saves-loading, saves-offline, saves-empty, saves-empty-offline, saves-first-arrive, saves-cleared, archive,
// archive-empty, archive-menu): the header row, Search, the sync line while a sync runs, Unread and Archive, one
// notice slot, then the list or its empty state. The list reads SQLite live, so a sync's saves simply appear.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { router } from 'expo-router';
import { useFocusEffect, useIsFocused } from 'expo-router';
import Animated, { FadeIn, LinearTransition, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { SvgXml } from 'react-native-svg';
import { motion, radius } from '@shelf/tokens';
import { ambient, quickIn, quickOut } from '@shelf/tokens/reanimated';
import { coverDraws, markDrawn } from '../data/covers';
import { counts, listRows, type LibRow, type ListName } from '../data/library';
import { useApp } from '../services/app';
import { syncRunning } from '../services/runner';
import { store } from '../services/store';
import { APP_ICON_SVG } from '../ui/appIcon';
import { Button } from '../ui/Button';
import { Cover } from '../ui/Cover';
import { Icon } from '../ui/Icon';
import { useLive } from '../ui/live';
import { MenuItem, MenuTitle } from '../ui/MenuItem';
import { Banner } from '../ui/Notice';
import { RestoreCard, useRestoreCard } from './RestoreCard';
import { useOffline, useOnline } from '../ui/online';
import { Press, pressLayer } from '../ui/Press';
import { closeSheet, openSheet } from '../ui/sheet';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { setToastFloor } from '../ui/toast';
import { TAB_BAR_HEIGHT } from '../ui/TabBar';
import { useTheme } from '../ui/theme';
import { archive, remove } from './actions';
import { SaveRow } from './SaveRow';
import { Head } from './TabHead';

// The first run's looping cover is the prototype's (The Atlantic's address).
const SCAFFOLD_HASH = '02a662fcfb69bec8626bbd14b40ca01b06cfa05b3bb4af946c28168f03ff9e34';

/** The sync line (prototype .refresh): after 150 ms of waiting, a 30% segment sweeps the 3 px track. */
function SyncLine() {
  const { c } = useTheme();
  const [w, setW] = useState(0);
  const x = useSharedValue(-1);
  useEffect(() => {
    x.value = withDelay(motion.ambient.delay, withRepeat(withTiming(10 / 3, ambient.sweep), -1));
  }, [x]);
  const seg = useAnimatedStyle(() => ({ transform: [{ translateX: x.value * w * motion.ambient.sweep.segment }] }));
  return (
    <Animated.View entering={FadeIn.delay(motion.ambient.delay).duration(motion.quickIn.duration)} style={{ marginTop: 12, height: 3, marginHorizontal: 16, borderRadius: 999, backgroundColor: c.line, overflow: 'hidden' }} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      <Animated.View style={[{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${motion.ambient.sweep.segment * 100}%`, backgroundColor: c.text, borderRadius: 999 }, seg]} />
    </Animated.View>
  );
}

function Segment({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const { c } = useTheme();
  const st = useAnimatedStyle(() => ({ opacity: withTiming(on ? 1 : 0, on ? quickIn : quickOut) }), [on]);
  return (
    <Press accessibilityRole="tab" accessibilityState={{ selected: on }} onPress={onPress} layer={pressLayer(c.text)} style={{ height: 36, paddingHorizontal: 16, borderRadius: radius.control, borderWidth: 1, borderColor: c.line, justifyContent: 'center' }}>
      <T style={ui(13, 'label', 1)}>{label}</T>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: -1, left: -1, right: -1, bottom: -1, borderRadius: radius.control, backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center' }, st]}>
        <T style={[ui(13, 'label', 1), { color: c.onFill }]}>{label}</T>
      </Animated.View>
    </Press>
  );
}

function EmptyTile({ mark, title, body, action }: { mark: React.ReactNode; title: string; body: string; action?: React.ReactNode }) {
  return (
    <Animated.View entering={FadeIn.duration(motion.quickIn.duration)} style={{ paddingVertical: 32, paddingHorizontal: 24, alignItems: 'center' }}>
      {mark}
      <T accessibilityRole="header" style={[ui(20, 'emptyHeading', 1.3, -0.01), { marginTop: 22, marginBottom: 8, textAlign: 'center' }]}>{title}</T>
      <T muted style={[ui(15, 'body', 1.45), { textAlign: 'center', maxWidth: 260, marginBottom: 24 }]}>{body}</T>
      {action}
    </Animated.View>
  );
}

/** The first run (prototype saves-empty): dashed slots split into quarters, one wearing a cover, over the share lesson. */
function FirstRun({ online }: { online: boolean }) {
  const { c } = useTheme();
  const slot = (i: number) => (i === 5
    ? <View key={i} style={{ flex: 1, aspectRatio: 1 }}><Cover hash={SCAFFOLD_HASH} size={47} /></View>
    : (
      <View key={i} style={{ flex: 1, aspectRatio: 1, borderRadius: radius.image, borderWidth: 1, borderStyle: 'dashed', borderColor: c.lineStrong, opacity: 0.75 }}>
        <View style={{ position: 'absolute', left: '50%', top: 6, bottom: 6, width: 1, backgroundColor: c.line }} />
        <View style={{ position: 'absolute', top: '50%', left: 6, right: 6, height: 1, backgroundColor: c.line }} />
      </View>
    ));
  const app = (label: string, me = false) => (
    <View key={label} style={{ width: 44, alignItems: 'center', gap: 5 }}>
      <View style={[{ width: 40, height: 40, borderRadius: 20, backgroundColor: c.line, overflow: 'hidden' }, me && { boxShadow: `0px 0px 0px 2px ${c.surface}, 0px 0px 0px 3.5px ${c.text}` }]}>
        {me && <SvgXml xml={APP_ICON_SVG} width={40} height={40} />}
      </View>
      <T allowFontScaling={false} numberOfLines={1} style={{ width: 60, marginHorizontal: -8, textAlign: 'center', fontFamily: me ? 'Archivo-650' : 'Archivo-400', fontSize: 10, color: me ? c.text : c.muted, includeFontPadding: false }}>{label}</T>
    </View>
  );
  return (
    <EmptyTile
      mark={(
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ width: 236, borderRadius: radius.sheet, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, paddingTop: 16, paddingHorizontal: 14, paddingBottom: 14, gap: 14 }}>
          <View style={{ gap: 6 }}>
            {[0, 1].map((row) => <View key={row} style={{ flexDirection: 'row', gap: 6 }}>{[0, 1, 2, 3].map((k) => slot(row * 4 + k))}</View>)}
          </View>
          <View>
            <T allowFontScaling={false} style={{ fontFamily: 'Archivo-400', fontSize: 11, color: c.muted, marginBottom: 8, includeFontPadding: false }}>{S.saves.shareTo}</T>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>{S.saves.shareApps.map((a) => app(a, a === 'Shelf'))}</View>
          </View>
        </View>
      )}
      title={S.saves.emptyTitle}
      body={S.saves.emptyBody}
      action={<Button label={S.saves.connectBrowser} icon="laptop" disabled={!online} onPress={() => router.push('/connect')} />}
    />
  );
}

export default function Saves() {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const app = useApp();
  const owner = app?.owner ?? '';
  const online = useOnline();
  const offline = useOffline();
  const syncing = useSyncExternalStore(syncRunning.subscribe, syncRunning.get);
  const [list, setList] = useState<ListName>('unread');
  const rows = useLive(() => (owner ? listRows(store(), owner, list) : []), ['items'], [owner, list]);
  const n = useLive(() => (owner ? counts(store(), owner) : { unread: 0, archived: 0 }), ['items'], [owner]);
  const first = n.unread + n.archived === 0;
  // a restore's card takes the notice slot, and the first-run lesson waits until it has found nothing
  const restoring = useRestoreCard(owner);
  // Signature 1: saves already here when the list first shows are drawn; one that joins while Unread is in front
  // of you draws its cover as it lands (a sync, a restore, the first save); one that joins elsewhere is simply there.
  const focused = useIsFocused();
  const seeded = useRef(false);
  if (!seeded.current && owner) {
    seeded.current = true;
    markDrawn(store(), rows.map((r) => r.hash), 'list');
  }
  const hashes = rows.map((r) => r.hash).join(',');
  const draws = useMemo(() => coverDraws(store(), rows.map((r) => r.hash), 'list', Date.now(), focused && list === 'unread'), [hashes, focused, list]); // eslint-disable-line react-hooks/exhaustive-deps

  useFocusEffect(useCallback(() => setToastFloor(TAB_BAR_HEIGHT), []));

  const open = useCallback((r: LibRow) => router.push(`/reader/${r.hash}`), []);
  const swipe = useCallback((r: LibRow) => archive(r.hash, r.state !== 'archived'), []);
  const more = useCallback((r: LibRow) => {
    openSheet(r.title ?? r.url, () => (
      <View>
        <MenuTitle>{r.title ?? r.url}</MenuTitle>
        <MenuItem icon="restore" label={S.row.backToUnread} onPress={() => closeSheet(() => archive(r.hash, false))} />
        <MenuItem icon="trash" label={S.row.delete} danger onPress={() => closeSheet(() => remove(r.hash))} />
      </View>
    ));
  }, []);

  const header = (
    <View>
      <Head title={S.saves.title} count={first ? undefined : list === 'unread' ? S.saves.unreadCount(n.unread) : S.saves.archivedCount(n.archived)} />
      {!first && (
        <Press accessibilityRole="search" onPress={() => router.push({ pathname: '/search', params: { fresh: '1' } })} layer={pressLayer(c.text)} style={{ marginTop: 4, marginHorizontal: 16, height: 48, borderRadius: radius.button, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16 }}>
          <Icon name="search" size={18} color={c.muted} />
          <T muted style={ui(15, 'body', 1.45)}>{S.saves.search}</T>
        </Press>
      )}
      {syncing && !first && <SyncLine />}
      {!first && (
        <View accessibilityRole="tablist" accessibilityLabel={S.saves.whichList} style={{ flexDirection: 'row', gap: 8, paddingTop: 12, paddingHorizontal: 16, paddingBottom: 8 }}>
          <Segment label={S.saves.unread} on={list === 'unread'} onPress={() => setList('unread')} />
          <Segment label={S.saves.archive} on={list === 'archived'} onPress={() => setList('archived')} />
        </View>
      )}
      {restoring && <RestoreCard owner={owner} offline={offline} />}
      {offline && !restoring && (first ? <Banner text={S.saves.offlineFirst} /> : <Banner text={S.saves.offline} />)}
    </View>
  );

  const empty = first ? (restoring ? null : <FirstRun online={online} />)
    : list === 'unread'
      ? (
        <EmptyTile
          mark={<View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: c.success, alignItems: 'center', justifyContent: 'center' }}><Icon name="check" size={28} color={c.onFill} /></View>}
          title={S.saves.allReadTitle} body={S.saves.allReadBody}
          action={<Button label={S.saves.seeArchive} kind="secondary" onPress={() => setList('archived')} />}
        />
      )
      : (
        <EmptyTile
          mark={<View style={{ width: 56, height: 56, borderRadius: radius.button, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}><Icon name="archive" size={26} color={c.text} /></View>}
          title={S.saves.archiveEmptyTitle} body={S.saves.archiveEmptyBody}
        />
      );

  return (
    <View style={{ flex: 1, backgroundColor: c.background, paddingTop: insets.top }}>
      <Animated.FlatList
        data={first ? [] : rows}
        keyExtractor={(r) => r.hash}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: 16 }}>
            <SaveRow r={item} online={online} onOpen={open} onSwipe={swipe} onMore={item.state === 'archived' ? more : undefined} drawFrom={draws.get(item.hash) ?? 0} />
          </View>
        )}
        itemLayoutAnimation={LinearTransition.duration(motion.reflow.duration)}
        contentContainerStyle={{ paddingBottom: 160 }}
        showsVerticalScrollIndicator={false}
      />
    </View>
  );
}
