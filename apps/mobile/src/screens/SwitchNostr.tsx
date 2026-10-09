// Use my nostr app instead (mobile spec 5.8, contract 4.8, FD 13, FD 26, FD 76, FD 91 (c) (i); prototype sw, sw-waiting,
// sw-declined, sw-offline, sw-moving, sw-none, sw-probe, sw-newer). The explanation with Keep backup copies; the
// primary opens the phone's signer app, or the link field when there is none. Waiting, ← does what Cancel does.
// Declined, unanswered and refused by the probe return to the explanation with their line. Moving shows "N of M"
// with no ← and Back swallowed; done, a root swap to You with its toast. A save from a newer Kefli stops the move
// before anything is copied and asks for an update. RULED: an unanswered request uses sign-in's line, since the
// prototype draws no timeout here.
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Linking, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useSharedValue, withTiming } from 'react-native-reanimated';
import { radius } from '@kefli/tokens';
import { reflow } from '@kefli/tokens/reanimated';
import { readBunkerLink, type SignerProvider } from '@kefli/protocol';
import { moveJob } from '../data/move';
import { useApp } from '../services/app';
import { loadDefaults } from '../services/config';
import { askApp, askLink, whyFailed, type How } from '../services/nostrAsk';
import { checkSignIn } from '../services/nostrSignIn';
import { onMoveProgress, pool, runMoveJob } from '../services/runner';
import { store } from '../services/store';
import { abandonSwitch, beginSwitch } from '../services/switchNostr';
import { Button } from '../ui/Button';
import { Dots } from '../ui/Dots';
import { Icon, type IconName } from '../ui/Icon';
import { SlidingLine } from '../ui/Line';
import { Banner, ErrLine } from '../ui/Notice';
import { useOnline } from '../ui/online';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { showToast } from '../ui/toast';
import { useTheme } from '../ui/theme';
import { KeepSwitch } from './Nostr';
import { Lead, OnbShell } from './Onb';

type Step = 'explain' | 'none' | 'waiting' | 'moving' | 'newer';
type Problem = 'declined' | 'timeout' | 'probe' | null;

const RETRY_MS = 5000;
const STORE_URL = 'market://details?id=app.kefli';

function Point({ icon, title, sub, warn }: { icon: IconName; title: string; sub: string; warn?: boolean }) {
  const { c } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 8 }}>
      <View style={{ marginTop: 2 }}><Icon name={icon} size={18} color={warn ? c.error : c.success} /></View>
      <View style={{ flex: 1 }}>
        <T style={ui(15, 'body', 1.45)}>{title}</T>
        <T muted style={ui(13, 'body', 1.4)}>{sub}</T>
      </View>
    </View>
  );
}

function Moving({ moved, total }: { moved: number; total: number }) {
  const { c } = useTheme();
  const p = useSharedValue(0);
  const share = total ? moved / total : 0;
  useEffect(() => {
    p.value = withTiming(share, reflow);
  }, [share, p]);
  return (
    <View accessibilityLiveRegion="polite" style={{ marginVertical: 16, padding: 16, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
        <T style={ui(17, 'heading', 1.3)}>{S.sw.movingHead}</T>
        {total > 0 && <T muted style={[ui(13, 'meta', 1.3), { fontVariant: ['tabular-nums'] }]}>{S.sw.count(moved, total)}</T>}
      </View>
      <SlidingLine p={p} color={c.text} height={4} round style={{ borderRadius: 999, backgroundColor: c.line, marginBottom: 8 }} />
      <T muted style={ui(13, 'body', 1.45)}>{S.sw.keepOpen}</T>
    </View>
  );
}

export default function SwitchNostr() {
  const { c } = useTheme();
  const online = useOnline();
  const owner = useApp()?.owner ?? '';
  // a switch already under way (the app stopped part way) is shown moving
  const [step, setStep] = useState<Step>(() => (moveJob(store())?.from === owner && owner ? 'moving' : 'explain'));
  const [problem, setProblem] = useState<Problem>(null);
  const [keep, setKeep] = useState(true);
  const [link, setLink] = useState('');
  const [badLink, setBadLink] = useState(false);
  const [progress, setProgress] = useState({ moved: 0, total: 0 });
  const attempt = useRef(0);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'moving') return true;
      if (step === 'waiting' || step === 'none') {
        cancel();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  const cancel = () => {
    attempt.current++;
    setStep('explain');
  };

  // moving: the job runs until it is done or stopped, trying again every few seconds while it waits on a server
  useEffect(() => {
    if (step !== 'moving') return;
    let live = true;
    const off = onMoveProgress((moved, total) => live && setProgress({ moved, total }));
    const go = async () => {
      const job = moveJob(store());
      const r = await runMoveJob().catch(() => 'waiting' as const);
      if (!live) return;
      if (r === 'done') {
        router.dismissTo('/you');
        setTimeout(() => showToast({ text: S.sw.done }), 300);
      } else if (r === 'newer') {
        if (job) await abandonSwitch(job.from, job.to);
        setStep('newer');
      } else {
        setTimeout(() => live && go(), RETRY_MS);
      }
    };
    go();
    return () => {
      live = false;
      off();
    };
  }, [step]);

  const fail = (e: unknown, mine: number) => {
    if (mine !== attempt.current) return;
    setProblem(whyFailed(e));
    setStep('explain');
  };

  /** The probe and the lists, then T beside S and the move under way. */
  const start = async (signer: SignerProvider, how: How, mine: number) => {
    const d = await loadDefaults();
    const checked = await checkSignIn({ db: store(), now: () => Math.floor(Date.now() / 1000), defaults: d, query: (u, f) => pool.query(u, f as never) }, signer);
    if (mine !== attempt.current) return;
    if (!checked.ok) {
      setProblem('probe');
      return setStep('explain');
    }
    await beginSwitch(signer, how, checked.lists, keep, d);
    setStep('moving');
  };
  const openApp = async () => {
    setProblem(null);
    const mine = ++attempt.current;
    try {
      const a = await askApp(() => setStep('waiting'));
      if (mine !== attempt.current) return;
      if (!a) return setStep('none');
      await start(a.signer, a.how, mine);
    } catch (e) {
      fail(e, mine);
    }
  };
  const useLink = async () => {
    const parsed = readBunkerLink(link);
    if (!parsed) return setBadLink(true);
    setProblem(null);
    const mine = ++attempt.current;
    setStep('waiting');
    try {
      const a = await askLink(parsed, link);
      if (mine !== attempt.current) return;
      await start(a.signer, a.how, mine);
    } catch (e) {
      fail(e, mine);
    }
  };

  if (step === 'moving') {
    return (
      <OnbShell title={S.sw.moving} back={null}>
        <Moving moved={progress.moved} total={progress.total} />
      </OnbShell>
    );
  }
  if (step === 'waiting') {
    return (
      <OnbShell title={S.sw.title} back={cancel} actions={<Button label={S.nostr.cancel} kind="secondary" full onPress={cancel} />}>
        <View accessibilityLiveRegion="polite" style={{ alignItems: 'center', paddingVertical: 48, gap: 16 }}>
          <Dots color={c.text} />
          <T style={ui(17, 'heading', 1.3)}>{S.nostr.waiting}</T>
          <T muted style={[ui(15, 'body', 1.45), { textAlign: 'center' }]}>{S.nostr.waitingLead}</T>
        </View>
      </OnbShell>
    );
  }
  if (step === 'none') {
    return (
      <OnbShell title={S.nostr.noneTitle} back={cancel} actions={<Button label={S.nostr.connect} full disabled={!online} onPress={useLink} />}>
        {!online && <Banner text={S.sw.offline} style={{ marginHorizontal: 0 }} />}
        <Lead>{S.nostr.noneLead}</Lead>
        <TextInput
          value={link} onChangeText={(v) => (setLink(v), setBadLink(false))} placeholder="bunker://…" placeholderTextColor={c.muted}
          autoCapitalize="none" autoCorrect={false} autoComplete="off" spellCheck={false} accessibilityLabel={S.nostr.linkLabel} accessibilityHint={badLink ? S.nostr.badLink : undefined}
          style={[ui(15, 'body', 1.3), { height: 52, borderRadius: radius.button, borderWidth: 1, borderColor: badLink ? c.error : c.lineStrong, backgroundColor: c.surface, color: c.text, paddingHorizontal: 16 }]}
        />
        <T accessibilityLiveRegion="polite" style={[ui(13, 'body', 1.45), { color: c.error, minHeight: 20, marginTop: 8 }]}>{badLink ? S.nostr.badLink : ''}</T>
      </OnbShell>
    );
  }
  if (step === 'newer') {
    return (
      <OnbShell title={S.sw.title} actions={<Button label={S.sw.update} full onPress={() => Linking.openURL(STORE_URL).catch(() => undefined)} />}>
        <ErrLine text={S.sw.newer} />
        <Lead>{S.sw.newerLead}</Lead>
      </OnbShell>
    );
  }
  const line = problem === 'declined' ? S.sw.declined : problem === 'timeout' ? S.nostr.timeout : problem === 'probe' ? S.sw.probe : null;
  return (
    <OnbShell title={S.sw.title} actions={<Button label={S.sw.go} icon="login" full disabled={!online} onPress={openApp} />}>
      {line && <ErrLine text={line} />}
      {!online && <Banner text={S.sw.offline} style={{ marginHorizontal: 0 }} />}
      <Lead>{S.sw.lead}</Lead>
      <View style={{ marginBottom: 20 }}>
        <Point icon="check" title={S.sw.comes} sub={S.sw.comesSub} />
        <Point icon="alert" warn title={S.sw.stops} sub={S.sw.stopsSub} />
      </View>
      <KeepSwitch on={keep} onPress={() => setKeep((k) => !k)} />
    </OnbShell>
  );
}
