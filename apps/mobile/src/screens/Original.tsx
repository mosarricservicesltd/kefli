// The original page in Kefli's view (FD 81; prototype reader-error, reader-original, reader-original-loading,
// reader-original-failed, reader-original-offline, reader-error-menu): react-native-webview under Kefli's bar, with
// ⋯ (Open in browser, Copy link, Delete) and the floating Archive. A save whose text couldn't be fetched opens here
// with its notice. While the page loads, the Reader's skeleton sits under the bar; a page that won't load points to
// Open in browser; offline, the view says it needs a connection. The page stays on the web and opens no other app
// (net/navigation.ts), and runs incognito, its cookies gone when the view closes (net/cookies.ts).
import { useCallback, useEffect, useState } from 'react';
import { Linking, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import * as Clipboard from 'expo-clipboard';
import { radius } from '@kefli/tokens';
import { rowByHash, rowStatus, type LibRow } from '../data/library';
import { clearCookies } from '../net/cookies';
import { originalMayLoad } from '../net/navigation';
import { useApp } from '../services/app';
import { store } from '../services/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { useLive } from '../ui/live';
import { MenuItem, MenuTitle } from '../ui/MenuItem';
import { Banner } from '../ui/Notice';
import { useOnline } from '../ui/online';
import { closeSheet, openSheet } from '../ui/sheet';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { setToastFloor, showToast } from '../ui/toast';
import { mix, useTheme } from '../ui/theme';
import { archive, remove } from './actions';
import { ArchiveDock, DOCK_LIFTED } from './ArchiveDock';
import { stopIfPlaying, useVoice } from '../services/voice';
import { IconButton } from './Onb';
import { failNotice } from './failNotice';
import { hostOf } from './SaveRow';
import { Skeleton } from './Skeleton';

export function OriginalView({ row, failedSave }: { row: LibRow; failedSave: boolean }) {
  const { c } = useTheme();
  const insets = useSafeAreaInsets();
  const online = useOnline();
  const [st, setSt] = useState<'loading' | 'page' | 'failed'>('loading');
  const playing = !!useVoice();
  useFocusEffect(useCallback(() => setToastFloor((playing ? DOCK_LIFTED : 16) + 52), [playing]));
  useEffect(() => () => void clearCookies(), []);
  const leave = () => router.back();
  const reopen = () => router.push(`/reader/${row.hash}`);
  const menu = () => openSheet(row.title ?? row.url, () => (
    <View>
      <MenuTitle>{row.title ?? row.url}</MenuTitle>
      <MenuItem icon="ext" label={S.reader.iabMenu.openInBrowser} onPress={() => closeSheet(() => Linking.openURL(row.url).catch(() => undefined))} />
      <MenuItem icon="link" label={S.reader.iabMenu.copyLink} onPress={() => closeSheet(() => Clipboard.setStringAsync(row.url).then(() => showToast({ text: S.toast.linkCopied, hash: row.hash })))} />
      <MenuItem icon="trash" label={S.reader.iabMenu.delete} danger onPress={() => closeSheet(() => { leave(); stopIfPlaying(row.hash); remove(row.hash, reopen); })} />
    </View>
  ));
  return (
    <View style={{ flex: 1, backgroundColor: c.background }}>
      <View style={{ paddingTop: insets.top, backgroundColor: c.surface, borderBottomWidth: 1, borderBottomColor: c.line }}>
        <View style={{ height: 56, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8 }}>
          <IconButton icon="x" label={S.reader.close} onPress={leave} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <T numberOfLines={1} style={ui(15, 'title', 1.3)}>{row.title ?? hostOf(row.url)}</T>
            <T muted numberOfLines={1} style={ui(13, 'body', 1.3)}>{hostOf(row.url)}</T>
          </View>
          <IconButton icon="more" label={S.reader.more} onPress={menu} />
        </View>
      </View>
      {!online ? <Banner text={S.reader.originalOffline} style={{ marginHorizontal: 16, marginTop: 12 }} />
        : st === 'failed' ? (
          <View style={{ marginTop: 12, marginHorizontal: 16 }}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.container, backgroundColor: mix(c.surface, c.error, 0.1), marginBottom: 12 }}>
              <Icon name="alert" size={16} color={c.error} />
              <T style={[ui(13, 'meta', 1.4), { flex: 1 }]}>{S.reader.pageFailed}</T>
            </View>
            <Button label={S.reader.openInBrowser} icon="ext" full onPress={() => Linking.openURL(row.url).catch(() => undefined)} />
          </View>
        )
        : failedSave && (
          <View style={{ margin: 12, marginHorizontal: 16, flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 12, paddingHorizontal: 16, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
            <Icon name="info" size={16} color={c.muted} />
            <T style={[ui(13, 'meta', 1.4), { flex: 1 }]}>{failNotice(row.fail_reason)}</T>
          </View>
        )}
      {online && st !== 'failed' && (
        <View style={{ flex: 1 }}>
          <WebView
            source={{ uri: row.url }}
            originWhitelist={['*']}
            onShouldStartLoadWithRequest={(r) => originalMayLoad(r.url)}
            incognito
            setSupportMultipleWindows={false}
            allowFileAccess={false}
            javaScriptCanOpenWindowsAutomatically={false}
            onLoadEnd={() => setSt((s) => (s === 'failed' ? s : 'page'))}
            onError={() => setSt('failed')}
            onHttpError={(e) => e.nativeEvent.statusCode >= 400 && setSt('failed')}
            style={{ flex: 1, backgroundColor: '#FFFFFF', opacity: st === 'page' ? 1 : 0 }}
          />
          {st === 'loading' && (
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, padding: 16 }}>
              <T style={{ position: 'absolute', opacity: 0 }} accessibilityLiveRegion="polite">{S.reader.loadingPage}</T>
              <Skeleton muted={c.muted} />
            </View>
          )}
        </View>
      )}
      <ArchiveDock
        archived={row.state === 'archived'} bg={c.surface} fg={c.text} shadow={c.shadowFloat} lifted={playing}
        onPress={() => { leave(); archive(row.hash, row.state !== 'archived', reopen); }}
      />
    </View>
  );
}

export default function Original() {
  const { hash } = useLocalSearchParams<{ hash: string }>();
  const owner = useApp()?.owner ?? '';
  const row = useLive(() => rowByHash(store(), owner, hash), ['items'], [owner, hash]);
  const { c } = useTheme();
  if (!row) return <View style={{ flex: 1, backgroundColor: c.background }} />;
  return <OriginalView row={row} failedSave={rowStatus(row) === 'failed'} />;
}
