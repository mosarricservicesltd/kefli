// Add another device (mobile spec 5.8, FD 25, FD 53, FD 85; prototype dev, dev-expired): a QR for the new phone to
// scan, with six digits under it, fresh each time and good for five minutes, the screen kept awake and secured
// while it shows (7.1). The offer, the mnemonic sealed under the QR's secret and the six digits, waits on the
// operator for the new phone to fetch once. Expired, the code fades and Show a new one makes another. Offline,
// the notice and nothing else.
import { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import { useKeepAwake } from 'expo-keep-awake';
import { colors, radius } from '@kefli/tokens';
import type { PhoneQr } from '@kefli/protocol';
import { KefliSystem } from '../../modules/kefli-system/src';
import { useApp } from '../services/app';
import { showPhonePair } from '../services/phonePair';
import { phonePorts } from '../services/runner';
import { clock } from '../voice/clock';
import { Button } from '../ui/Button';
import { Dots } from '../ui/Dots';
import { Banner, ErrLine } from '../ui/Notice';
import { useOnline } from '../ui/online';
import { QrCode } from '../ui/QrCode';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { Lead, OnbShell } from './Onb';

// The card stays light in both themes, so any camera reads it (prototype data-theme="light").
const L = colors.light;

export default function AddDevice() {
  const owner = useApp()?.owner ?? '';
  const online = useOnline();
  const [offer, setOffer] = useState<{ qr: PhoneQr; six: string } | 'failed' | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useKeepAwake();

  useEffect(() => {
    KefliSystem.setSecure(true);
    return () => void KefliSystem.setSecure(false);
  }, []);
  const make = useCallback(() => {
    setOffer(null);
    showPhonePair(phonePorts(owner)).then((r) => setOffer(r === 'offline' ? 'failed' : r), () => setOffer('failed'));
  }, [owner]);
  useEffect(() => {
    if (online) make();
  }, [online, make]);
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  if (!online || offer === 'failed') {
    return (
      <OnbShell title={S.addDevice.title} actions={online ? <Button label={S.addDevice.newCode} icon="refresh" full onPress={make} /> : undefined}>
        <Banner text={S.addDevice.offline} style={{ marginHorizontal: 0 }} />
        <Lead>{S.addDevice.offlineLead}</Lead>
      </OnbShell>
    );
  }
  const left = offer ? offer.qr.expires - now : 300;
  const expired = !!offer && left <= 0;
  return (
    <OnbShell title={S.addDevice.title} actions={expired ? <Button label={S.addDevice.newCode} icon="refresh" full onPress={make} /> : undefined}>
      <Lead>{S.addDevice.lead}</Lead>
      <View style={{ alignItems: 'center', gap: 12, padding: 24, marginBottom: 16, borderRadius: radius.container, backgroundColor: L.surface, borderWidth: 1, borderColor: L.line }}>
        <View accessible accessibilityLabel={S.addDevice.qr} style={{ width: 180, height: 180, alignItems: 'center', justifyContent: 'center' }}>
          {offer ? <QrCode text={JSON.stringify(offer.qr)} size={180} color={L.text} opacity={expired ? 0.12 : 1} /> : <Dots color={L.text} />}
        </View>
        <T accessibilityLabel={offer && !expired ? S.addDevice.six(offer.six) : undefined}
          style={[ui(28, 'heading', 1), { color: L.text, letterSpacing: 5, fontVariant: ['tabular-nums'] }]}>
          {offer && !expired ? `${offer.six.slice(0, 3)} ${offer.six.slice(3)}` : '––– –––'}
        </T>
      </View>
      {expired
        ? <ErrLine text={S.addDevice.expired} />
        : <T muted style={[ui(13, 'body', 1.4), { textAlign: 'center', fontVariant: ['tabular-nums'] }]}>{S.addDevice.expiresIn(clock(Math.max(0, left)))}</T>}
    </OnbShell>
  );
}
