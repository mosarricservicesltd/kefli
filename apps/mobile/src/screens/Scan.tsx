// Scan from my other phone (mobile spec 5.3, FD 23, FD 40, FD 53, FD 85; prototype scan-prime, scan-prompt,
// scan-view, scan-code, scan-wrong, scan-refused, scan-expired, scan-connecting). The explanation shows until the
// camera is allowed; the system dialog only follows it. A read QR stops the camera before the keyboard rises for
// the six digits, which go off at the sixth. The offer is fetched once with a throwaway key; a key that isn't the
// QR's is refused. Then the root swaps to Saves with the restore card. Refused, the way on is the recovery code.
import { useEffect, useRef, useState } from 'react';
import { Linking, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { radius } from '@kefli/tokens';
import { readPhoneQr, readSix, type PhoneQr } from '@kefli/protocol';
import { phoneCrypto } from '../crypto/port';
import { answerRecovered } from '../services/app';
import { loadDefaults } from '../services/config';
import { takePhonePair } from '../services/phonePair';
import { Button } from '../ui/Button';
import { Dots } from '../ui/Dots';
import { Icon } from '../ui/Icon';
import { Banner, ErrLine } from '../ui/Notice';
import { useOnline } from '../ui/online';
import { PhoneQR } from '../ui/PhoneQR';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { useTheme } from '../ui/theme';
import { Viewfinder } from '../ui/Viewfinder';
import { Lead, OnbShell } from './Onb';

type Step = 'prime' | 'scan' | 'expired' | 'code' | 'connecting' | 'refused';

const reject = () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => undefined);

export default function Scan() {
  const { c } = useTheme();
  const online = useOnline();
  const [perm, ask] = useCameraPermissions();
  const [step, setStep] = useState<Step | null>(null);
  const [six, setSix] = useState('');
  const [wrong, setWrong] = useState(false);
  const [lost, setLost] = useState(false);
  const qr = useRef<PhoneQr | null>(null);
  const field = useRef<TextInput>(null);

  useEffect(() => {
    if (!perm || step) return;
    setStep(perm.granted ? 'scan' : !perm.canAskAgain ? 'refused' : 'prime');
  }, [perm, step]);

  const useCamera = async () => setStep((await ask()).granted ? 'scan' : 'refused');
  const scanned = (data: string) => {
    if (step !== 'scan' && step !== 'expired') return;
    const r = readPhoneQr(data, Math.floor(Date.now() / 1000));
    if (r === 'invalid') return;
    if (r === 'expired') {
      if (step !== 'expired') reject();
      return setStep('expired');
    }
    qr.current = r;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
    setSix('');
    setWrong(false);
    setStep('code');
  };
  const typed = async (v: string) => {
    const digits = v.replace(/\D/g, '').slice(0, 6);
    setSix(digits);
    setWrong(false);
    setLost(false);
    const code = readSix(digits);
    if (!code || !qr.current) return;
    setStep('connecting');
    const d = await loadDefaults();
    const r = await takePhonePair({ fetch, crypto: phoneCrypto, api: d.operator.api }, qr.current, code).catch(() => 'offline' as const);
    if (typeof r === 'object') return void (await answerRecovered(r.mnemonic, 'phone_pair'));
    setStep('code');
    if (r === 'wrong') {
      reject();
      setWrong(true);
    } else setLost(true);
    setTimeout(() => field.current?.focus(), 50);
  };

  const offline = (!online || lost) && <Banner text={S.scan.offline} style={{ marginHorizontal: 0 }} />;
  if (step === 'prime') {
    return (
      <OnbShell title={S.scan.title} actions={<Button label={S.scan.useCamera} icon="camera" full onPress={useCamera} />}>
        <Lead>{S.scan.lead}</Lead>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ alignItems: 'center', marginTop: 8, marginBottom: 24 }}>
          <View style={{ width: 150, height: 250, borderRadius: 26, borderWidth: 3, borderColor: c.text, backgroundColor: c.surface, alignItems: 'center', justifyContent: 'center', gap: 10 }}>
            <PhoneQR size={96} color={c.text} />
            <T style={[ui(17, 'title', 1), { letterSpacing: 3.4 }]}>482 913</T>
          </View>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name="camera" size={14} color={c.muted} />
          <T muted style={ui(13, 'body', 1.4)}>{S.scan.cameraOnly}</T>
        </View>
      </OnbShell>
    );
  }
  if (step === 'refused') {
    return (
      <OnbShell title={S.scan.title} actions={(
        <>
          <Button label={S.scan.useCode} icon="keyboard" full onPress={() => router.replace('/code')} />
          <Button label={S.scan.settings} kind="secondary" full onPress={() => Linking.openSettings()} />
        </>
      )}>
        <View style={{ height: 300, marginVertical: 16, borderRadius: radius.sheet, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center', gap: 8, padding: 24 }}>
          <Icon name="camera" size={32} color={c.muted} />
          <T style={[ui(15, 'heading', 1.4), { textAlign: 'center' }]}>{S.scan.refusedTitle}</T>
          <T muted style={[ui(13, 'body', 1.4), { textAlign: 'center' }]}>{S.scan.refusedBody}</T>
        </View>
      </OnbShell>
    );
  }
  if (step === 'connecting') {
    return (
      <OnbShell title={S.scan.title}>
        <View accessibilityLiveRegion="polite" style={{ alignItems: 'center', paddingVertical: 48, gap: 16 }}>
          <Dots color={c.text} />
          <T style={ui(17, 'heading', 1.3)}>{S.scan.connecting}</T>
          <T muted style={ui(15, 'body', 1.45)}>{S.scan.connectingLead}</T>
        </View>
      </OnbShell>
    );
  }
  if (step === 'code') {
    return (
      <OnbShell title={S.scan.title}>
        {offline}
        <Lead>{S.scan.scanned}</Lead>
        <T style={[ui(13, 'groupLabel', 1.3), { marginBottom: 8 }]}>{S.scan.sixLabel}</T>
        <TextInput
          ref={field} value={six} onChangeText={typed} autoFocus maxLength={6} keyboardType="number-pad" placeholder="••••••" placeholderTextColor={c.muted}
          autoComplete="off" importantForAutofill="no" selection={wrong ? { start: 0, end: six.length } : undefined}
          accessibilityLabel={S.scan.sixLabel} accessibilityHint={wrong ? S.scan.wrong : undefined}
          style={[ui(20, 'title', 1), {
            height: 52, borderRadius: radius.button, borderWidth: 1, borderColor: wrong ? c.error : c.lineStrong, backgroundColor: c.surface, color: c.text,
            textAlign: 'center', letterSpacing: 7, paddingHorizontal: 16, fontVariant: ['tabular-nums'],
          }]}
        />
        <T accessibilityLiveRegion="polite" style={[ui(13, 'body', 1.45), { color: c.error, minHeight: 20, marginTop: 8 }]}>{wrong ? S.scan.wrong : ''}</T>
      </OnbShell>
    );
  }
  // scanning, expired (an outcome error in the notice slot), and the moment before the permission is known
  return (
    <OnbShell title={S.scan.title}>
      {offline}
      {step === 'expired' && <ErrLine text={S.scan.expired} />}
      <Viewfinder live={!!perm?.granted && step !== null} onCode={scanned} caption={S.scan.point} />
    </OnbShell>
  );
}
