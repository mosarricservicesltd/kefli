// Sign in with your nostr app (mobile spec 5.3, FD 5, FD 41, FD 76, FD 82, FD 91 (b) (d) (f); prototype nostr,
// nostr-none, nostr-badlink, nostr-waiting, nostr-declined, nostr-timeout, nostr-probe, nostr-import). Always starts
// at the explanation with the Keep backup copies switch; the primary opens the phone's signer app (Android's chooser
// when there are several), or the link field when there is none; the quiet link goes to the field. Waiting, ← does
// what Cancel does. Declined, unanswered and refused by the probe return to the start with their line. A signer app
// that won't sign everything saving needs without asking gets Save without asking first (FD 104). With bookmarks to
// bring in, the import sheet asks once, and either answer signs in.
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, TextInput, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { radius } from '@kefli/tokens';
import { quickIn } from '@kefli/tokens/reanimated';
import { readBunkerLink, type BackgroundNeed, type SignerProvider } from '@kefli/protocol';
import { KEEP_COPIES, setSetting } from '../data/settings';
import { answerNewHere, answerSignedIn } from '../services/app';
import { loadDefaults } from '../services/config';
import { adoptNostr } from '../services/identity';
import { askApp, askLink, whyFailed, type How } from '../services/nostrAsk';
import { checkSigner } from '../services/nostrCheck';
import { checkSignIn, queueImport, settleUserLists, type UserLists } from '../services/nostrSignIn';
import { pool } from '../services/runner';
import { store } from '../services/store';
import { Button } from '../ui/Button';
import { Dots } from '../ui/Dots';
import { Banner, ErrLine } from '../ui/Notice';
import { useOnline } from '../ui/online';
import { openSheet, closeSheet } from '../ui/sheet';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { useTheme } from '../ui/theme';
import { Lead, OnbShell } from './Onb';
import { SaveWithoutAsking } from './SaveWithoutAsking';

type Step = 'intro' | 'none' | 'waiting';
type Problem = 'declined' | 'timeout' | 'probe' | null;
export function KeepSwitch({ on, onPress }: { on: boolean; onPress: () => void }) {
  const { c } = useTheme();
  const x = useSharedValue(on ? 18 : 0);
  useEffect(() => {
    x.value = withTiming(on ? 18 : 0, quickIn);
  }, [on, x]);
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  return (
    <Pressable accessibilityRole="switch" accessibilityState={{ checked: on }} accessibilityLabel={S.nostr.keep} accessibilityHint={S.nostr.keepSub} onPress={onPress}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 12, paddingHorizontal: 16, marginBottom: 20, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <T style={ui(15, 'title', 1.3)}>{S.nostr.keep}</T>
        <T muted style={[ui(13, 'body', 1.4), { marginTop: 2 }]}>{S.nostr.keepSub}</T>
      </View>
      <View style={{ width: 44, height: 26, borderRadius: 13, borderWidth: 2, borderColor: on ? c.fill : c.muted, backgroundColor: on ? c.fill : 'transparent' }}>
        <Animated.View style={[{ position: 'absolute', top: 3, left: 3, width: 16, height: 16, borderRadius: 8, backgroundColor: on ? c.onFill : c.muted }, knob]} />
      </View>
    </Pressable>
  );
}

export default function Nostr() {
  const { c } = useTheme();
  const online = useOnline();
  const [step, setStep] = useState<Step>('intro');
  const [problem, setProblem] = useState<Problem>(null);
  const [keep, setKeep] = useState(true);
  const [link, setLink] = useState('');
  const [badLink, setBadLink] = useState(false);
  const [bg, setBg] = useState<{ signer: SignerProvider; missing: BackgroundNeed[]; goOn: () => void } | null>(null);
  const attempt = useRef(0);

  // ← and Back while waiting do what Cancel does (fix 20); from the link field, back to the start
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (step === 'intro') return false;
      cancel();
      return true;
    });
    return () => sub.remove();
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps
  const cancel = () => {
    attempt.current++;
    setStep('intro');
  };

  const fail = (e: unknown, mine: number) => {
    if (mine !== attempt.current) return;
    setProblem(whyFailed(e));
    setStep('intro');
  };

  /** The signer's checks, Save without asking if it asks (FD 104), the import sheet if there are bookmarks, the root swap. */
  const finish = async (signer: SignerProvider, how: How, mine: number) => {
    const d = await loadDefaults();
    const checked = await checkSignIn({ db: store(), now: () => Math.floor(Date.now() / 1000), defaults: d, query: (u, f) => pool.query(u, f as never) }, signer);
    if (mine !== attempt.current) return;
    if (!checked.ok) {
      setProblem('probe');
      return setStep('intro');
    }
    const missing = await checkSigner(signer).catch(() => null);
    if (mine !== attempt.current) return;
    const goOn = () => importOrSignIn(signer, how, d, checked);
    if (missing?.length) return setBg({ signer, missing, goOn });
    goOn();
  };

  const importOrSignIn = (signer: SignerProvider, how: How, d: Awaited<ReturnType<typeof loadDefaults>>, checked: Extract<Awaited<ReturnType<typeof checkSignIn>>, { ok: true }>) => {
    const done = async (bringIn: boolean) => {
      const owner = await adoptNostr(signer, how);
      const now = Math.floor(Date.now() / 1000);
      setSetting(store(), KEEP_COPIES, keep ? '1' : '0');
      settleUserLists(store(), now, owner, d, checked.lists as UserLists, keep);
      if (bringIn) queueImport(store(), now, owner, checked.links);
      answerSignedIn(owner);
    };
    if (!checked.links.length) return done(false);
    // the import sheet sits over the waiting step; its scrim and Back don't dismiss it (FD 82, as drawn)
    openSheet(S.nostr.importTitle, () => (
      <View>
        <T accessibilityRole="header" style={[ui(20, 'emptyHeading', 1.3, -0.01), { marginBottom: 4 }]}>{S.nostr.importTitle}</T>
        <T muted style={[ui(13, 'body', 1.45), { marginBottom: 16 }]}>{S.nostr.importLine(checked.links.length)}</T>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button label={S.nostr.importNo} kind="secondary" style={{ flex: 1 }} onPress={() => closeSheet(() => done(false))} />
          <Button label={S.nostr.importYes} style={{ flex: 1 }} onPress={() => closeSheet(() => done(true))} />
        </View>
      </View>
    ), { dismissable: false });
  };

  const openApp = async () => {
    setProblem(null);
    const mine = ++attempt.current;
    try {
      const a = await askApp(() => setStep('waiting'));
      if (mine !== attempt.current) return;
      if (!a) return setStep('none');
      await finish(a.signer, a.how, mine);
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
      await finish(a.signer, a.how, mine);
    } catch (e) {
      fail(e, mine);
    }
  };

  if (bg) return <SaveWithoutAsking signer={bg.signer} missing={bg.missing} done={() => (setBg(null), bg.goOn())} />;
  if (step === 'waiting') {
    return (
      <OnbShell title={S.nostr.title} back={cancel} actions={<Button label={S.nostr.cancel} kind="secondary" full onPress={cancel} />}>
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
        {!online && <Banner text={S.nostr.offline} style={{ marginHorizontal: 0 }} />}
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
  const line = problem === 'declined' ? S.nostr.declined : problem === 'timeout' ? S.nostr.timeout : problem === 'probe' ? S.nostr.probe : null;
  return (
    <OnbShell title={S.nostr.title} actions={(
      <>
        <Button label={S.nostr.open} icon="login" full disabled={!online} onPress={openApp} />
        {problem === 'probe' && <Button label={S.nostr.fresh} kind="secondary" full onPress={() => answerNewHere()} />}
        <Button label={S.nostr.useLink} kind="quiet" full onPress={() => (setProblem(null), setStep('none'))} />
      </>
    )}>
      {line && <ErrLine text={line} />}
      {!online && <Banner text={S.nostr.offline} style={{ marginHorizontal: 0 }} />}
      <Lead>{S.nostr.lead}</Lead>
      <KeepSwitch on={keep} onPress={() => setKeep((k) => !k)} />
    </OnbShell>
  );
}
