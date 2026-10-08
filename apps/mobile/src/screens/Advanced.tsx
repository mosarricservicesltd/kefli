// Advanced (mobile spec 5.8, FD 76, FD 93; prototype adv, adv-down, adv-offline, adv-notbacked): the relays in the
// identity's 10002, Shelf's own first, each with whether it answers; the count of saves not backed up while there
// are any, after which the note under the relays speaks of "your other saves"; a relay not answering is named in
// the note. Export and Use my nostr app instead are week 5's: their rows are drawn and lead nowhere yet. "relay"
// appears in the copy here only (FD 86).
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { radius } from '@shelf/tokens';
import { notBackedUp } from '../data/backup';
import { relayEntries } from '../data/lists';
import { useApp } from '../services/app';
import { loadDefaults } from '../services/config';
import { relayStatus } from '../services/runner';
import { store } from '../services/store';
import { Icon, type IconName } from '../ui/Icon';
import { useLive } from '../ui/live';
import { useOnline } from '../ui/online';
import { Press, pressLayer } from '../ui/Press';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { useTheme } from '../ui/theme';
import { OnbShell } from './Onb';

type Status = 'up' | 'down' | 'off' | 'checking';

const hostOf = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

function Pill({ status }: { status: Status }) {
  const { c } = useTheme();
  if (status === 'checking') return null;
  const [label, dot] = status === 'up' ? [S.adv.connected, c.success] : status === 'down' ? [S.adv.down, c.error] : [S.adv.off, c.muted];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dot }} />
      <T muted style={ui(13, 'body', 1.3)}>{label}</T>
    </View>
  );
}

function Row({ icon, label, sub, right, first, onPress, disabled }: {
  icon: IconName; label: string; sub?: string; right?: React.ReactNode; first?: boolean; onPress?: () => void; disabled?: boolean;
}) {
  const { c } = useTheme();
  const body = (
    <>
      {!first && <View style={{ position: 'absolute', left: 48, right: 0, top: 0, height: 1, backgroundColor: c.line }} />}
      <Icon name={icon} size={20} color={c.muted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={ui(15, 'label', 1.3)}>{label}</T>
        {sub && <T muted style={[ui(13, 'body', 1.3), { marginTop: 2 }]}>{sub}</T>}
      </View>
      {right}
    </>
  );
  const style = { minHeight: 56, flexDirection: 'row' as const, alignItems: 'center' as const, gap: 12, paddingVertical: 8, paddingHorizontal: 16, opacity: disabled ? 0.45 : 1 };
  if (!onPress && disabled === undefined) return <View accessible style={style}>{body}</View>;
  return (
    <Press accessibilityRole="button" accessibilityLabel={label} accessibilityHint={sub} accessibilityState={{ disabled: !!disabled }} disabled={disabled}
      onPress={onPress} layer={pressLayer(c.text)} style={style}>
      {body}
    </Press>
  );
}

function Group({ children }: { children: React.ReactNode }) {
  const { c } = useTheme();
  return <View style={{ marginBottom: 20, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>{children}</View>;
}

export default function Advanced() {
  const { c } = useTheme();
  const online = useOnline();
  const owner = useApp()?.owner ?? '';
  const [operator, setOperator] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const relays = useLive(() => (owner ? relayEntries(store(), owner).filter((r) => r.write).map((r) => r.url) : []), ['relays'], [owner]);
  const notBacked = useLive(() => (owner ? notBackedUp(store(), owner) : 0), ['items', 'blobs', 'outbox'], [owner]);

  useEffect(() => {
    loadDefaults().then((d) => setOperator(d.operator.relay), () => undefined);
  }, []);
  // each relay asked on opening and every 15 s while the screen is in front
  useFocusEffect(useCallback(() => {
    let live = true;
    const check = () => relays.forEach((u) => relayStatus(u).then((ok) => live && setStatus((s) => ({ ...s, [u]: ok ? 'up' : 'down' }))));
    check();
    const t = setInterval(check, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [relays.join(',')])); // eslint-disable-line react-hooks/exhaustive-deps

  // Shelf's relay first, then the backups in the 10002's order
  const ordered = [...relays].sort((a, b) => (a === operator ? -1 : b === operator ? 1 : 0));
  let k = 0;
  const label = (u: string) => (u === operator ? S.adv.shelf : S.adv.backup(++k));
  const statusOf = (u: string): Status => (!online ? 'off' : status[u] ?? 'checking');
  const down = online ? ordered.filter((u) => status[u] === 'down').map(hostOf) : [];

  return (
    <OnbShell title={S.adv.title}>
      {notBacked > 0 && (
        <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 12, paddingHorizontal: 16, marginBottom: 16, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
          <View style={{ marginTop: 1 }}><Icon name="info" size={16} color={c.muted} /></View>
          <T style={[ui(13, 'meta', 1.4), { flex: 1 }]}>{S.adv.notBacked(notBacked)}</T>
        </View>
      )}
      <T muted style={[ui(13, 'groupLabel', 1.3), { marginBottom: 8 }]}>{S.adv.relays}</T>
      <View style={{ marginBottom: 8, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
        {ordered.map((u, i) => <Row key={u} first={i === 0} icon="server" label={label(u)} sub={hostOf(u)} right={<Pill status={statusOf(u)} />} />)}
      </View>
      <T muted style={[ui(13, 'body', 1.45), { marginBottom: 20 }]}>
        {S.adv.copied(notBacked > 0, ordered.length)}{down.length ? ` ${S.adv.willReach(down)}` : ''}
      </T>
      <Group>
        <Row first icon="download" label={S.adv.export} sub={S.adv.exportSub} onPress={() => undefined} />
        <Row icon="login" label={S.adv.nostr} sub={online ? S.adv.nostrSub : S.adv.needsConnection} disabled={!online} onPress={() => undefined}
          right={<Icon name="chev" size={18} color={c.muted} />} />
      </Group>
    </OnbShell>
  );
}
