// Connected browsers (mobile spec 5.5, FD 11, FD 32; prototype br, br-empty, br-disconnect): each connected
// browser with Disconnect, or none yet; Connect a browser at the bottom. Disconnect asks in a sheet, then revokes at
// once and says so in a toast. Offline, the notice sits under the title and Connect is disabled; Disconnect still
// works, since the revocation waits in the outbox.
import { useCallback } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import Animated, { FadeIn } from 'react-native-reanimated';
import { motion, radius } from '@kefli/tokens';
import { connectedBrowsers, type Browser } from '../data/devices';
import { useApp } from '../services/app';
import { disconnectBrowser } from '../services/runner';
import { store } from '../services/store';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { useLive } from '../ui/live';
import { Banner } from '../ui/Notice';
import { useOnline } from '../ui/online';
import { Press, pressLayer } from '../ui/Press';
import { closeSheet, openSheet } from '../ui/sheet';
import { S, connectedWhen } from '../ui/strings';
import { T, ui } from '../ui/text';
import { setToastFloor, showToast } from '../ui/toast';
import { useTheme } from '../ui/theme';
import { Lead, OnbShell } from './Onb';

/** The action bar's height above the inset: 16 + 48 + 24. */
const ACTIONS = 88;

function DisconnectSheet({ b, owner, close }: { b: Browser; owner: string; close: () => void }) {
  const yes = () =>
    closeSheet(() => {
      disconnectBrowser(owner, b.device_pubkey).catch(() => undefined);
      showToast({ text: S.browsers.disconnected(b.label) });
    });
  return (
    <View>
      <T accessibilityRole="header" style={[ui(20, 'emptyHeading', 1.3, -0.01), { marginBottom: 4 }]}>{S.browsers.sheetTitle(b.label)}</T>
      <T muted style={[ui(13, 'body', 1.45), { marginBottom: 16 }]}>{S.browsers.sheetBody}</T>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label={S.browsers.cancel} kind="secondary" style={{ flex: 1 }} onPress={close} />
        <Button label={S.browsers.disconnect} kind="danger" style={{ flex: 1 }} onPress={yes} />
      </View>
    </View>
  );
}

function Row({ b, first, onDisconnect }: { b: Browser; first: boolean; onDisconnect: () => void }) {
  const { c } = useTheme();
  const when = connectedWhen(b.connected_at);
  return (
    <View accessible={false} style={{ minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingLeft: 16, paddingRight: 8 }}>
      {!first && <View style={{ position: 'absolute', left: 48, right: 0, top: 0, height: 1, backgroundColor: c.line }} />}
      <Icon name="laptop" size={20} color={c.muted} />
      <View accessible accessibilityLabel={`${b.label}, ${when}`} style={{ flex: 1, minWidth: 0 }}>
        <T style={ui(15, 'label', 1.3)}>{b.label}</T>
        <T muted style={[ui(13, 'body', 1.3), { marginTop: 2 }]}>{when}</T>
      </View>
      <Press accessibilityRole="button" accessibilityLabel={`${S.browsers.disconnect} ${b.label}`} onPress={onDisconnect} layer={pressLayer(c.error)}
        hitSlop={{ top: 8, bottom: 8, left: 2, right: 2 }} style={{ height: 36, paddingHorizontal: 12, borderRadius: radius.control, justifyContent: 'center' }}>
        <T style={[ui(13, 'label', 1), { color: c.error }]}>{S.browsers.disconnect}</T>
      </Press>
    </View>
  );
}

export default function Browsers() {
  const { c } = useTheme();
  const owner = useApp()?.owner ?? '';
  const online = useOnline();
  const list = useLive(() => connectedBrowsers(store(), owner), ['devices'], [owner]);
  useFocusEffect(useCallback(() => setToastFloor(ACTIONS), []));

  const ask = (b: Browser) => openSheet(S.browsers.sheetTitle(b.label), (close) => <DisconnectSheet b={b} owner={owner} close={close} />);
  return (
    <OnbShell title={S.browsers.title} actions={<Button label={S.browsers.connect} icon="laptop" full disabled={!online} onPress={() => router.push('/connect')} />}>
      {!online && <Banner text={S.browsers.offline} style={{ marginHorizontal: 0 }} />}
      <Lead>{S.browsers.lead}</Lead>
      {list.length > 0 ? (
        <Animated.View entering={FadeIn.duration(motion.quickIn.duration)} style={{ borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
          {list.map((b, i) => <Row key={b.device_pubkey} b={b} first={i === 0} onDisconnect={() => ask(b)} />)}
        </Animated.View>
      ) : (
        <Animated.View entering={FadeIn.duration(motion.quickIn.duration)} style={{ paddingVertical: 32, paddingHorizontal: 24, alignItems: 'center' }}>
          <View style={{ width: 56, height: 56, borderRadius: radius.button, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="laptop" size={26} color={c.text} />
          </View>
          <T accessibilityRole="header" style={[ui(20, 'emptyHeading', 1.3, -0.01), { marginTop: 22, marginBottom: 8, textAlign: 'center' }]}>{S.browsers.emptyTitle}</T>
          <T muted style={[ui(15, 'body', 1.45), { textAlign: 'center', maxWidth: 260 }]}>{S.browsers.emptyBody}</T>
        </Animated.View>
      )}
    </OnbShell>
  );
}
