// Advanced (mobile spec 5.8, FD 76, FD 93, FD 117; prototype adv, adv-down, adv-offline, adv-notbacked, adv-full,
// adv-daily, adv-toolarge, adv-space-*): the relays in the identity's 10002, Kefli's own first, each with whether it
// answers; a relay not answering is named in the note under them. The notice slot holds an export that failed, with
// Try again (adv-exportfail, G9), then one notice about saves not backed up, the first that applies: a text waiting for
// room on the space or the day's uploads, the saves Kefli is still trying to back up, texts too long to back up. The
// note under the relays speaks of "your other saves" while Kefli is still trying to back up some save, since one whose
// text alone stays on the phone is on every relay without it. Backup space shows the library's use of Kefli's server
// from the last figures it gave, asked again each time Advanced opens online (GET /account), with the fine print in
// the library's own figures. Export my saves writes kefli-export.html to Downloads, offline too, then the toast. Use
// my nostr app instead opens the switch, and is hidden for a nostr user, who has nothing to switch from. Add a relay,
// last in the group, opens its screen (FD 113), needing a connection; a relay the person added is "Your relay", and its
// row asks whether to remove it, which stops the copying and sends the lists without it. "relay" appears in the copy
// here only (FD 86).
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { radius } from '@kefli/tokens';
import { phoneCrypto } from '../crypto/port';
import { DEFAULT_DAILY, DEFAULT_QUOTA, NOTHING_WAITS, accountFigures, backupNotice, spaceOf, textsWaiting, type Check } from '../data/account';
import { notBackedUp } from '../data/backup';
import { relayRows, removeRelay, type RelayRow } from '../data/lists';
import { checkAccount } from '../services/account';
import { useApp } from '../services/app';
import { loadDefaults } from '../services/config';
import { exportSaves } from '../services/export';
import { currentSigner } from '../services/identity';
import { relayStatus, runOutbox } from '../services/runner';
import { store } from '../services/store';
import { Icon, type IconName } from '../ui/Icon';
import { useLive } from '../ui/live';
import { useOnline } from '../ui/online';
import { Press, pressLayer } from '../ui/Press';
import { Button } from '../ui/Button';
import { ErrLine } from '../ui/Notice';
import { closeSheet, openSheet } from '../ui/sheet';
import { S, noticeText } from '../ui/strings';
import { showToast } from '../ui/toast';
import { T, ui } from '../ui/text';
import { useTheme } from '../ui/theme';
import { OnbShell } from './Onb';

type Status = 'up' | 'down' | 'off' | 'checking';

/** The address without its scheme or path, written without URL, whose parsing Hermes doesn't fully have. */
export const hostOf = (u: string) => u.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');

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

function Row({ icon, label, sub, right, first, onPress, disabled, hint }: {
  icon: IconName; label: string; sub?: string; right?: React.ReactNode; first?: boolean; onPress?: () => void; disabled?: boolean; hint?: string;
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
    <Press accessibilityRole="button" accessibilityLabel={label} accessibilityHint={hint ? `${sub ?? ''}. ${hint}` : sub} accessibilityState={{ disabled: !!disabled }} disabled={disabled}
      onPress={onPress} layer={pressLayer(c.text)} style={style}>
      {body}
    </Press>
  );
}

function RemoveSheet({ owner, url, close }: { owner: string; url: string; close: () => void }) {
  const yes = () =>
    closeSheet(() => {
      if (removeRelay(store(), Math.floor(Date.now() / 1000), owner, url)) runOutbox().catch(() => undefined);
      showToast({ text: S.adv.removed(hostOf(url)) });
    });
  return (
    <View>
      <T accessibilityRole="header" style={[ui(20, 'emptyHeading', 1.3, -0.01), { marginBottom: 4 }]}>{S.adv.removeTitle}</T>
      <T muted style={[ui(13, 'body', 1.45), { marginBottom: 16 }]}>{S.adv.removeBody(hostOf(url))}</T>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label={S.adv.cancel} kind="secondary" style={{ flex: 1 }} onPress={close} />
        <Button label={S.adv.remove} kind="danger" style={{ flex: 1 }} onPress={yes} />
      </View>
    </View>
  );
}

function Group({ children, noted }: { children: React.ReactNode; noted?: boolean }) {
  const { c } = useTheme();
  return <View style={{ marginBottom: noted ? 8 : 20, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>{children}</View>;
}

/** The notice slot's info notice (adv-notbacked's look), read out when it changes. */
function Info({ text }: { text: string }) {
  const { c } = useTheme();
  return (
    <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingVertical: 12, paddingHorizontal: 16, marginBottom: 16, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
      <View style={{ marginTop: 1 }}><Icon name="info" size={16} color={c.muted} /></View>
      <T style={[ui(13, 'meta', 1.4), { flex: 1 }]}>{text}</T>
    </View>
  );
}

const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * The library's figures from Kefli's server (FD 117): asked each time Advanced comes into view online, and again when
 * the phone comes back online on it; what the check came to, for the row's state while no figures are held.
 */
function useAccountCheck(owner: string, online: boolean): Check {
  const [check, setCheck] = useState<Check>('checking');
  useFocusEffect(useCallback(() => {
    if (!owner || !online) return;
    let live = true;
    // a check after one that failed reads Checking… again; after any other answer the row keeps what it shows
    setCheck((was) => (was === 'failed' ? 'checking' : was));
    checkAccount({
      db: store(), now: nowSec, owner, api: async () => (await loadDefaults()).operator.api,
      signer: currentSigner, fetch, crypto: phoneCrypto,
    }).then((r) => live && setCheck(r));
    return () => {
      live = false;
    };
  }, [owner, online]));
  return check;
}

export default function Advanced() {
  const { c } = useTheme();
  const online = useOnline();
  const owner = useApp()?.owner ?? '';
  const [operator, setOperator] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [exportFailed, setExportFailed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const rows = useLive((): RelayRow[] => (owner ? relayRows(store(), owner) : []), ['relays'], [owner]);
  const relays = rows.map((r) => r.url);
  const local = useLive(() => (store().get<{ provider: string }>('SELECT provider FROM identities WHERE pubkey = ?', owner)?.provider ?? 'local') === 'local', ['identities'], [owner]);
  const notBacked = useLive(() => (owner ? notBackedUp(store(), owner) : 0), ['items', 'blobs', 'outbox'], [owner]);
  const waiting = useLive(() => (owner ? textsWaiting(store(), owner, nowSec()) : NOTHING_WAITS), ['items', 'blobs'], [owner]);
  const figures = useLive(() => (owner ? accountFigures(store(), owner) : null), ['account_figures'], [owner]);
  const checked = useAccountCheck(owner, online);
  const { notice, trying } = backupNotice(waiting, notBacked);
  const space = spaceOf(figures, waiting.full, checked, online);

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

  // Kefli's relay first, then the backups and the person's own in the 10002's order
  const ordered = [...rows].sort((a, b) => (a.url === operator ? -1 : b.url === operator ? 1 : 0));
  let k = 0;
  const label = (r: RelayRow) => (r.url === operator ? S.adv.operator : r.source === 'user' ? S.adv.yours : S.adv.backup(++k));
  const askRemove = (url: string) => openSheet(S.adv.removeTitle, (close) => <RemoveSheet owner={owner} url={url} close={close} />);
  const statusOf = (u: string): Status => (!online ? 'off' : status[u] ?? 'checking');
  const down = online ? relays.filter((u) => status[u] === 'down').map(hostOf) : [];

  const doExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      await exportSaves(owner);
      setExportFailed(false);
      showToast({ text: S.adv.exported });
    } catch {
      setExportFailed(true);
    } finally {
      setExporting(false);
    }
  };

  return (
    <OnbShell title={S.adv.title} actions={exportFailed ? <Button label={S.adv.tryAgain} full onPress={doExport} /> : undefined}>
      {exportFailed && <ErrLine text={S.adv.exportFail} />}
      {notice && <Info text={noticeText(notice)} />}
      <T muted style={[ui(13, 'groupLabel', 1.3), { marginBottom: 8 }]}>{S.adv.relays}</T>
      <View style={{ marginBottom: 8, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
        {ordered.map((r, i) => (
          <Row key={r.url} first={i === 0} icon="server" label={label(r)} sub={hostOf(r.url)} right={<Pill status={statusOf(r.url)} />}
            onPress={r.removable ? () => askRemove(r.url) : undefined} hint={r.removable ? S.adv.removeHint : undefined} />
        ))}
        <Row first={ordered.length === 0} icon="plus" label={S.adv.add} sub={online ? S.adv.addSub : S.adv.needsConnection} disabled={!online}
          onPress={() => router.push('/add-relay')} right={<Icon name="chev" size={18} color={c.muted} />} />
      </View>
      <T muted style={[ui(13, 'body', 1.45), { marginBottom: 20 }]}>
        {S.adv.copied(trying > 0, ordered.length)}{down.length ? ` ${S.adv.willReach(down)}` : ''}
      </T>
      <T muted style={[ui(13, 'groupLabel', 1.3), { marginBottom: 8 }]}>{S.adv.space}</T>
      <Group noted>
        <Row first icon="harddrive" label={S.adv.server} sub={S.adv.spaceSub(space)} />
      </Group>
      <T muted style={[ui(13, 'body', 1.45), { marginBottom: 20 }]}>
        {S.adv.spaceNote(figures?.quota ?? DEFAULT_QUOTA, figures?.daily ?? DEFAULT_DAILY)}
      </T>
      <Group>
        <Row first icon="download" label={S.adv.export} sub={S.adv.exportSub} onPress={doExport} />
        {local && <Row icon="login" label={S.adv.nostr} sub={online ? S.adv.nostrSub : S.adv.needsConnection} disabled={!online} onPress={() => router.push('/switch')}
          right={<Icon name="chev" size={18} color={c.muted} />} />}
      </Group>
    </OnbShell>
  );
}
