// Connect a browser (mobile spec 5.5, FD 11, FD 29, FD 40, FD 42, FD 64; prototype conn-first, conn-ask,
// conn-scan, conn-type, conn-typewrong, conn-confirm, conn-busy, conn-refused, conn-expired, conn-failed). The
// camera explanation shows only while CAMERA isn't granted; typing the code is its own step, so the keyboard never
// covers a live viewfinder, and it moves on at the eighth character. While connecting, Cancel is unavailable and
// there is no ←. ← and success return to where Connect was opened, Saves or Connected browsers.
import { useEffect, useRef, useState } from 'react';
import { BackHandler, Keyboard, Linking, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { motion, radius } from '@shelf/tokens';
import type { PairOffer } from '@shelf/protocol';
import { connectBrowser, lookupCode, readScan } from '../services/connect';
import { loadDefaults } from '../services/config';
import { useApp } from '../services/app';
import { connectPorts } from '../services/runner';
import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
import { ErrLine } from '../ui/Notice';
import { PhoneQR } from '../ui/PhoneQR';
import { Viewfinder } from '../ui/Viewfinder';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { showToast } from '../ui/toast';
import { useTheme } from '../ui/theme';
import { Lead, OnbShell } from './Onb';

type Step = 'ask' | 'scan' | 'refused' | 'expired' | 'failed' | 'type' | 'confirm' | 'busy';

/** The explanation's drawing (prototype .pairillus): the laptop showing its code. */
function PairIllustration() {
  const { c } = useTheme();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ alignItems: 'center', marginTop: 8, marginBottom: 24 }}>
      <View style={{ alignItems: 'center', paddingTop: 20, paddingHorizontal: 16, paddingBottom: 16, borderRadius: radius.sheet, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
        <View style={{ width: 196, height: 124, borderWidth: 3, borderColor: c.text, borderTopLeftRadius: 10, borderTopRightRadius: 10, borderBottomLeftRadius: 4, borderBottomRightRadius: 4, alignItems: 'center', justifyContent: 'center', gap: 8 }}>
          <PhoneQR size={64} color={c.text} />
          <T style={[ui(15, 'title', 1), { letterSpacing: 1.8, fontVariant: ['tabular-nums'] }]}>K7QM-4XPD</T>
        </View>
        <View style={{ width: 236, height: 10, borderBottomLeftRadius: 10, borderBottomRightRadius: 10, backgroundColor: c.text }} />
      </View>
    </View>
  );
}

/** XXXX-XXXX as typed: upper case, the hyphen inserted after four. */
export function formatCode(typed: string): string {
  const raw = typed.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
  return raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

function CodeStep({ onOffer, error, setError }: { onOffer: (o: PairOffer) => void; error: string | null; setError: (e: string | null) => void }) {
  const { c } = useTheme();
  const owner = useApp()?.owner ?? '';
  const [code, setCode] = useState('');
  const [checking, setChecking] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const field = useRef<TextInput>(null);
  // The field keeps focus throughout: a wrong code stays shown and selected, so the next keystroke replaces it.
  const change = async (v: string) => {
    if (checking) return;
    const next = formatCode(v);
    setCode(next);
    setSelection(undefined);
    if (error) setError(null);
    if (next.length < 9) return;
    setChecking(true);
    const r = await lookupCode(connectPorts(owner), next).catch(() => ({ problem: 'offline' as const }));
    setChecking(false);
    if ('offer' in r) {
      // the confirm card's buttons sit where the keyboard was
      Keyboard.dismiss();
      return onOffer(r.offer);
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
    setError(r.problem === 'expired' ? S.conn.expired : r.problem === 'offline' ? S.conn.failed : S.conn.wrong);
    setSelection({ start: 0, end: next.length });
    field.current?.focus();
  };
  return (
    <>
      <Lead>{S.conn.typeLead}</Lead>
      <T style={[ui(13, 'groupLabel', 1.3), { marginBottom: 8 }]}>{S.conn.codeLabel}</T>
      <TextInput
        ref={field} value={code} onChangeText={change} selection={selection} autoFocus placeholder="XXXX-XXXX" placeholderTextColor={c.muted}
        maxLength={9} autoComplete="off" autoCorrect={false} autoCapitalize="characters" spellCheck={false} keyboardType="visible-password"
        accessibilityLabel={S.conn.codeLabel} accessibilityHint={error ?? undefined}
        style={[ui(20, 'title', 1), {
          height: 52, borderRadius: radius.button, borderWidth: 1, borderColor: error ? c.error : c.lineStrong, backgroundColor: c.surface, color: c.text,
          textAlign: 'center', letterSpacing: 4, paddingHorizontal: 16, fontVariant: ['tabular-nums'], opacity: checking ? 0.45 : 1,
        }]}
      />
      <T accessibilityLiveRegion="polite" style={[ui(13, 'body', 1.45), { color: c.error, minHeight: 20, marginTop: 8 }]}>{error ?? ''}</T>
    </>
  );
}

export default function Connect() {
  const { c } = useTheme();
  const owner = useApp()?.owner ?? '';
  const [perm, ask] = useCameraPermissions();
  const [step, setStep] = useState<Step | null>(null);
  const [offer, setOffer] = useState<PairOffer | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const relay = useRef<string | null>(null);
  const lastScan = useRef<string | null>(null);
  const granted = !!perm?.granted;

  useEffect(() => {
    loadDefaults().then((d) => (relay.current = d.operator.relay)).catch(() => undefined);
  }, []);
  // The explanation only while CAMERA isn't granted; refused once Android won't ask again.
  useEffect(() => {
    if (!perm || step) return;
    setStep(perm.granted ? 'scan' : !perm.canAskAgain ? 'refused' : 'ask');
  }, [perm, step]);
  // No way out while connecting.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => step === 'busy');
    return () => sub.remove();
  }, [step]);

  const leave = () => router.back();
  const useCamera = async () => {
    const r = await ask();
    setStep(r.granted ? 'scan' : 'refused');
  };
  const scanned = (data: string) => {
    if (!relay.current || data === lastScan.current || (step !== 'scan' && step !== 'expired' && step !== 'failed')) return;
    lastScan.current = data;
    const r = readScan(data, relay.current, Math.floor(Date.now() / 1000));
    if ('offer' in r) {
      setOffer(r.offer);
      setStep('confirm');
    } else if (r.problem === 'expired') {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);
      setStep('expired');
    }
  };
  const typeInstead = () => {
    setCodeError(null);
    setStep('type');
  };
  const go = async () => {
    if (!offer || step === 'busy') return;
    setStep('busy');
    const r = await connectBrowser(connectPorts(owner), offer).catch(() => 'failed' as const);
    if (r === 'connected') {
      const name = offer.label.trim();
      leave();
      setTimeout(() => showToast({ text: S.conn.connected(name) }), motion.exit.duration);
      return;
    }
    lastScan.current = null;
    setStep('failed');
  };
  const retry = () => {
    lastScan.current = null;
    setStep(granted ? 'scan' : 'type');
  };

  const typeLink = <Button key="type" label={S.conn.typeInstead} icon="keyboard" kind="quiet" full onPress={typeInstead} />;
  if (step === 'type') {
    return (
      <OnbShell title={S.conn.title} back={leave}>
        <CodeStep error={codeError} setError={setCodeError} onOffer={(o) => { setOffer(o); setStep('confirm'); }} />
      </OnbShell>
    );
  }
  if ((step === 'confirm' || step === 'busy') && offer) {
    const busy = step === 'busy';
    return (
      <OnbShell title={S.conn.confirmTitle} back={busy ? null : leave} actions={(
        <>
          <Button label={busy ? S.conn.busy : S.conn.go} busy={busy} full onPress={go} />
          <Button label={S.conn.cancel} kind="secondary" full disabled={busy} onPress={leave} />
        </>
      )}>
        <View style={{ alignItems: 'center', gap: 8, padding: 16, marginVertical: 16, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
          <View style={{ width: 56, height: 56, borderRadius: radius.button, backgroundColor: c.background, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="laptop" size={26} color={c.text} />
          </View>
          <T style={[ui(17, 'heading', 1.3), { textAlign: 'center' }]}>{offer.label.trim()}</T>
          <T muted style={[ui(13, 'body', 1.4), { textAlign: 'center' }]}>{S.conn.confirmLine}</T>
        </View>
      </OnbShell>
    );
  }
  if (step === 'ask') {
    return (
      <OnbShell title={S.conn.title} back={leave} actions={(
        <>
          <Button label={S.conn.useCamera} icon="camera" full onPress={useCamera} />
          {typeLink}
        </>
      )}>
        <Lead>{S.conn.lead}</Lead>
        <PairIllustration />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="camera" size={14} color={c.muted} />
          <T muted style={ui(13, 'body', 1.4)}>{S.conn.cameraOnly}</T>
        </View>
      </OnbShell>
    );
  }
  if (step === 'refused') {
    return (
      <OnbShell title={S.conn.title} back={leave} actions={(
        <>
          <Button label={S.conn.typeInstead} icon="keyboard" full onPress={typeInstead} />
          <Button label={S.conn.settings} kind="secondary" full onPress={() => Linking.openSettings()} />
        </>
      )}>
        <Lead>{S.conn.lead}</Lead>
        <View style={{ height: 300, marginVertical: 16, borderRadius: radius.sheet, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 }}>
          <Icon name="camera" size={32} color={c.muted} />
          <T style={[ui(15, 'heading', 1.4), { textAlign: 'center' }]}>{S.conn.refusedTitle}</T>
          <T muted style={[ui(13, 'body', 1.4), { textAlign: 'center' }]}>{S.conn.refusedBody}</T>
        </View>
      </OnbShell>
    );
  }
  // scan, expired, failed (and the moment before the permission is known)
  return (
    <OnbShell title={S.conn.title} back={leave} actions={step === 'failed' ? <><Button label={S.conn.retry} full onPress={retry} />{typeLink}</> : typeLink}>
      <Lead>{S.conn.lead}</Lead>
      {step === 'expired' && <ErrLine text={S.conn.expired} />}
      {step === 'failed' && <ErrLine text={S.conn.failed} />}
      <Viewfinder live={granted && step !== null} onCode={scanned} caption={S.conn.point} />
    </OnbShell>
  );
}
