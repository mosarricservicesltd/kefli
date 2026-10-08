// Delete my data (mobile spec 5.8, 7.2, FD 14, FD 28, FD 74, FD 91 (e); prototype del, del-typed, del-running,
// del-partial, del-failed): what goes and what can only be asked for, the backup servers counted from the real
// lists; the danger button only once DELETE is typed and the phone is online. Deleting shows a row for each
// server as its request resolves, with no way back; a server that didn't confirm is named. Done, Shelf starts
// fresh at Welcome with a toast.
import { useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, TextInput, View } from 'react-native';
import { radius } from '@shelf/tokens';
import { phoneCrypto } from '../crypto/port';
import { answerDeleted, useApp } from '../services/app';
import { loadDefaults, type Defaults } from '../services/config';
import { deleteEverything, deleteTargets, signDeletion, type DelPorts, type Progress, type Result, type Target } from '../services/deleteAccount';
import { currentSigner, wipeEverything } from '../services/identity';
import { pool } from '../services/runner';
import { closeVoice } from '../services/voice';
import { store } from '../services/store';
import { Button } from '../ui/Button';
import { Icon, type IconName } from '../ui/Icon';
import { Banner, ErrLine } from '../ui/Notice';
import { useOnline } from '../ui/online';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { showToast } from '../ui/toast';
import { useTheme } from '../ui/theme';
import { Dots } from '../ui/Dots';
import { Lead, OnbShell } from './Onb';

type Phase = 'explain' | 'failed' | 'declined' | 'approve' | 'running' | 'partial';

function Item({ icon, go, title, sub }: { icon: IconName; go: boolean; title: string; sub?: string }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 8 }}>
      <View style={{ marginTop: 2 }}><Icon name={icon} size={18} color={go ? c.error : c.muted} /></View>
      <View style={{ flex: 1 }}>
        <T style={ui(15, 'body', 1.45)}>{title}</T>
        {sub && <T muted style={ui(13, 'body', 1.4)}>{sub}</T>}
      </View>
    </View>
  );
}

function Step({ label, state, note, first }: { label: string; state: Result; note: string; first: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 48, borderTopWidth: first ? 0 : 1, borderTopColor: c.line }}>
      <View style={{ width: 24, height: 24, borderRadius: 999, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: state === 'done' ? c.success : state === 'fail' ? c.error : 'transparent' }}>
        {state === 'wait' ? <Dots color={c.text} size={8} /> : <Icon name={state === 'done' ? 'check' : 'x'} size={14} color={c.onFill} />}
      </View>
      <T style={[ui(15, 'body', 1.3), { flex: 1 }]}>{label}</T>
      {state !== 'wait' && <T muted style={ui(13, 'body', 1.3)}>{note}</T>}
    </View>
  );
}

export default function Delete() {
  const { c } = useTheme();
  const online = useOnline();
  const owner = useApp()?.owner ?? '';
  const [defaults, setDefaults] = useState<Defaults | null>(null);
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase>('explain');
  const [prog, setProg] = useState<Progress | null>(null);

  useEffect(() => {
    loadDefaults().then(setDefaults, () => undefined);
  }, []);
  const nostr = useMemo(() => (store().get<{ provider: string }>('SELECT provider FROM identities WHERE pubkey = ?', owner)?.provider ?? 'local') !== 'local', [owner]);
  const targets: Target[] = useMemo(() => (defaults && owner ? deleteTargets(store(), owner, defaults.operator) : []), [defaults, owner]);
  // no way back while deleting, nor from the partial result (prototype del-running, del-partial)
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => phase === 'running' || phase === 'partial');
    return () => sub.remove();
  }, [phase]);

  const finish = () => {
    answerDeleted();
    setTimeout(() => showToast({ text: S.del.done }), 300);
  };
  const attempt = useRef(0);
  const go = async () => {
    const signer = await currentSigner();
    if (!signer || !defaults) return;
    const mine = ++attempt.current;
    const ports: DelPorts = {
      db: store(), now: () => Math.floor(Date.now() / 1000), signer, defaults, crypto: phoneCrypto, fetch,
      publish: (url, e) => pool.publish(url, e), sleep: (ms) => new Promise<void>((ok) => setTimeout(ok, ms)), wipePhone: wipeEverything,
    };
    // a nostr user approves in their app first: every deletion is signed before anything is sent, and declining
    // deletes nothing (FD 41, prototype del-nostr, del-declined)
    if (nostr) setPhase('approve');
    let signed;
    try {
      signed = await signDeletion(ports);
    } catch {
      if (mine === attempt.current) setPhase('declined');
      return;
    }
    if (mine !== attempt.current) return;
    setPhase('running');
    closeVoice();
    const r = await deleteEverything(ports, setProg, signed).catch(() => 'failed' as const);
    if (r === 'failed') return setPhase('failed');
    if (r === 'partial') return setPhase('partial');
    // a moment for the last mark to land, then Shelf starts fresh (prototype runDelete)
    setTimeout(finish, 400);
  };

  if (phase === 'approve') {
    const cancel = () => {
      attempt.current++;
      setPhase('explain');
    };
    return (
      <OnbShell title={S.del.title} back={cancel} actions={<Button label={S.del.cancel} kind="secondary" full onPress={cancel} />}>
        <View accessibilityLiveRegion="polite" style={{ alignItems: 'center', paddingVertical: 48, gap: 16 }}>
          <Dots color={c.text} />
          <T style={ui(17, 'heading', 1.3)}>{S.del.waiting}</T>
          <T muted style={[ui(15, 'body', 1.45), { textAlign: 'center' }]}>{S.del.waitingLead}</T>
        </View>
      </OnbShell>
    );
  }
  if (phase === 'running' || phase === 'partial') {
    const others = targets.map((t) => ({ t, state: prog?.others[t.url] ?? 'wait' as Result }));
    const unconfirmed = others.filter((o) => o.state === 'fail').map((o) => o.t.host);
    return (
      <OnbShell title={phase === 'partial' ? S.del.partial : S.del.running} back={null}
        actions={phase === 'partial' ? <Button label={S.del.finish} full onPress={finish} /> : undefined}>
        <View accessibilityLiveRegion="polite" style={{ paddingHorizontal: 16, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, marginTop: 8 }}>
          <Step first label={S.del.stepServer} state={prog?.operator ?? 'wait'} note={S.del.deleted} />
          {others.map(({ t, state }) => (
            <Step key={t.url} first={false} label={t.own ? S.del.stepOwn(t.host) : S.del.stepBackup(t.host)} state={state} note={state === 'fail' ? S.del.notConfirmed : t.kind === 'server' ? S.del.deleted : S.del.asked} />
          ))}
          <Step first={false} label={S.del.stepPhone} state={prog?.phone ?? 'wait'} note={S.del.deleted} />
        </View>
        {phase === 'partial' && <ErrLine text={nostr ? S.del.partialLineNostr(unconfirmed) : S.del.partialLine(unconfirmed)} style={{ marginTop: 16 }} />}
      </OnbShell>
    );
  }

  const ok = typed === 'DELETE' && online && !!defaults;
  const own = targets.filter((t) => t.own).length;
  return (
    <OnbShell title={S.del.title} actions={<Button label={S.del.go} kind="danger" full disabled={!ok} onPress={go} />}>
      {phase === 'failed' && <ErrLine text={S.del.failed} />}
      {phase === 'declined' && <ErrLine text={S.del.declined} />}
      {!online && <Banner text={S.del.offline} style={{ marginHorizontal: 0 }} />}
      <Lead>{S.del.lead}</Lead>
      <View style={{ marginBottom: 20 }}>
        <Item icon="trash" go title={S.del.server} />
        <Item icon="trash" go title={S.del.phone} sub={S.del.phoneSub} />
        {targets.length > 0 && (own > 0
          ? <Item icon="server" go={false} title={S.del.otherServers(targets.length)} sub={S.del.ownSub(own)} />
          : <Item icon="server" go={false} title={S.del.backups(targets.length)} sub={S.del.backupsSub} />)}
      </View>
      <T style={[ui(13, 'groupLabel', 1.3), { marginBottom: 8 }]}>{S.del.typeLabel}</T>
      <TextInput
        value={typed} onChangeText={(v) => setTyped(v.toUpperCase())} editable={online} autoCapitalize="characters" autoCorrect={false}
        autoComplete="off" spellCheck={false} accessibilityLabel={S.del.typeLabel}
        style={[ui(20, 'title', 1), {
          height: 52, borderRadius: radius.button, borderWidth: 1, borderColor: c.lineStrong, backgroundColor: c.surface, color: c.text,
          textAlign: 'center', letterSpacing: 4, paddingHorizontal: 16, opacity: online ? 1 : 0.45,
        }]}
      />
    </OnbShell>
  );
}
