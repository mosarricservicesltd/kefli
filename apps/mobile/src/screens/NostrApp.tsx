// Your nostr app (FD 104, FD 105; prototype nostrapp, nostrapp-asks, nostrapp-disc, nostrapp-disc-unsent): for a
// library signed in with a nostr app, the app it signs with and whether saving runs without asking, with Save without
// asking while it doesn't, and Sign out. Sign out asks first, naming saves not yet sent, then clears the library and
// the signer from this phone only, keeping the reader's and the voice's settings, and starts again at Welcome.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { radius } from '@kefli/tokens';
import { Nip55Signer, type BackgroundNeed, type SignerProvider } from '@kefli/protocol';
import { KefliNip55 } from '../../modules/kefli-nip55/src';
import { unsentSaves } from '../data/backup';
import { asksBeforeSaving } from '../data/nostrCheck';
import { answerDeleted, useApp } from '../services/app';
import { currentSigner, signOut } from '../services/identity';
import { checkSigner } from '../services/nostrCheck';
import { store } from '../services/store';
import { closeVoice } from '../services/voice';
import { Button } from '../ui/Button';
import { useLive } from '../ui/live';
import { closeSheet, openSheet } from '../ui/sheet';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { showToast } from '../ui/toast';
import { useTheme } from '../ui/theme';
import { Lead, OnbShell } from './Onb';
import { SaveWithoutAsking } from './SaveWithoutAsking';
import { Row } from './You';

function SignOutSheet({ unsent, close }: { unsent: number; close: () => void }) {
  const yes = () =>
    closeSheet(async () => {
      closeVoice();
      try {
        await signOut();
      } catch {
        return showToast({ text: S.nostrApp.failed });
      }
      answerDeleted();
      setTimeout(() => showToast({ text: S.nostrApp.done }), 300);
    });
  return (
    <View>
      <T accessibilityRole="header" style={[ui(20, 'emptyHeading', 1.3, -0.01), { marginBottom: 4 }]}>{S.nostrApp.sheetTitle}</T>
      <T muted style={[ui(13, 'body', 1.45), { marginBottom: unsent ? 8 : 16 }]}>{S.nostrApp.sheetBody}</T>
      {unsent > 0 && <T style={[ui(13, 'heading', 1.45), { marginBottom: 16 }]}>{S.nostrApp.unsent(unsent)}</T>}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label={S.nostrApp.cancel} kind="secondary" style={{ flex: 1 }} onPress={close} />
        <Button label={S.nostrApp.signOut} kind="danger" style={{ flex: 1 }} onPress={yes} />
      </View>
    </View>
  );
}

/** The signer app's name, from the package the signer reaches (the key file has it), or the sign-in link; null until known. */
function useSignedInWith(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      const signer = await currentSigner();
      if (signer?.kind === 'nip46') return setName(S.nostrApp.link);
      if (!(signer instanceof Nip55Signer)) return;
      const apps = await KefliNip55.listSigners().catch(() => []);
      setName(apps.find((a) => a.package === signer.package)?.label ?? signer.package);
    })();
  }, []);
  return name;
}

export default function NostrApp() {
  const { c } = useTheme();
  const owner = useApp()?.owner ?? '';
  const asks = useLive(() => asksBeforeSaving(store()), ['settings'], []);
  const signedInWith = useSignedInWith();
  const [fixing, setFixing] = useState<{ signer: SignerProvider; missing: BackgroundNeed[] } | null>(null);

  const fix = async () => {
    const signer = await currentSigner();
    const missing = signer ? await checkSigner(signer).catch(() => null) : null;
    if (signer && missing?.length) setFixing({ signer, missing });
  };
  const ask = () => openSheet(S.nostrApp.sheetTitle, (close) => <SignOutSheet unsent={unsentSaves(store(), owner)} close={close} />);

  if (fixing) {
    return <SaveWithoutAsking signer={fixing.signer} missing={fixing.missing} done={(still) => (setFixing(null), still || showToast({ text: S.bg.approved }))} />;
  }
  return (
    <OnbShell title={S.nostrApp.title} actions={asks ? <Button label={S.bg.title} icon="login" full onPress={fix} /> : undefined}>
      <Lead>{S.nostrApp.lead}</Lead>
      <View style={{ marginBottom: 20, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
        <Row first icon="login" label={S.nostrApp.signedInWith} value={signedInWith ?? ''} />
        {asks
          ? <Row icon="shield" label={S.nostrApp.saving} sub={S.nostrApp.asks} warn />
          : <Row icon="shield" label={S.nostrApp.saving} value={S.nostrApp.withoutAsking} />}
      </View>
      <View style={{ borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line, overflow: 'hidden' }}>
        <Row first icon="logout" label={S.nostrApp.signOut} danger onPress={ask} />
      </View>
    </OnbShell>
  );
}
