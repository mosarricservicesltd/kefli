// Add a relay (FD 113; prototype adv-add, adv-add-bad, adv-add-checking, adv-add-unreachable, adv-add-refused,
// adv-add-offline): one field for the address, built like the sign-in link's. Add relay checks the address, then
// that the relay answers and takes an event from this person (services/addRelay.ts), with the button busy
// meanwhile; a line under the field says what went wrong and editing clears it. Added, Advanced returns with the
// toast, and the outbox starts copying the saves. Offline the button is disabled under the banner. A nostr user is
// told the relay joins the list their other apps share. "relay" appears in the copy here only (FD 86).
import { useState } from 'react';
import { TextInput } from 'react-native';
import { router } from 'expo-router';
import { radius } from '@kefli/tokens';
import { addTypedRelay, type Check } from '../services/addRelay';
import { useApp } from '../services/app';
import { addRelayPorts, runOutbox } from '../services/runner';
import { store } from '../services/store';
import { Button } from '../ui/Button';
import { Banner } from '../ui/Notice';
import { useOnline } from '../ui/online';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { showToast } from '../ui/toast';
import { useTheme } from '../ui/theme';
import { Lead, OnbShell } from './Onb';
import { hostOf } from './Advanced';

const LINES: Partial<Record<Check, string>> = {
  bad: S.adv.addBad, listed: S.adv.addListed, unreachable: S.adv.addUnreachable, refused: S.adv.addRefused,
};

export default function AddRelay() {
  const { c } = useTheme();
  const online = useOnline();
  const owner = useApp()?.owner ?? '';
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState<Check | null>(null);
  const [busy, setBusy] = useState(false);
  const shared = (store().get<{ provider: string }>('SELECT provider FROM identities WHERE pubkey = ?', owner)?.provider ?? 'local') !== 'local';

  const add = async () => {
    if (busy || !owner) return;
    setBusy(true);
    try {
      const { check, url } = await addTypedRelay(addRelayPorts(), owner, typed);
      if (check !== 'ok' || !url) return setProblem(check);
      const copying = !!store().get('SELECT 1 FROM items WHERE owner = ? AND published = 1 AND pending_delete_at IS NULL', owner);
      runOutbox().catch(() => undefined);
      router.back();
      showToast({ text: S.adv.added(hostOf(url), copying) });
    } finally {
      setBusy(false);
    }
  };

  const line = problem ? LINES[problem] ?? '' : '';
  return (
    <OnbShell title={S.adv.add} actions={<Button label={busy ? S.adv.addChecking : S.adv.addButton} full busy={busy} disabled={!online || !typed.trim()} onPress={add} />}>
      {!online && <Banner text={S.adv.addOffline} style={{ marginHorizontal: 0 }} />}
      <Lead>{shared ? `${S.adv.addLead} ${S.adv.addLeadShared}` : S.adv.addLead}</Lead>
      <TextInput
        value={typed} onChangeText={(v) => (setTyped(v), setProblem(null))} placeholder="wss://relay.example.com" placeholderTextColor={c.muted}
        autoCapitalize="none" autoCorrect={false} autoComplete="off" spellCheck={false} keyboardType="url" returnKeyType="done"
        onSubmitEditing={() => online && typed.trim() && add()} editable={!busy}
        accessibilityLabel={S.adv.addLabel} accessibilityHint={line || undefined}
        style={[ui(15, 'body', 1.3), { height: 52, borderRadius: radius.button, borderWidth: 1, borderColor: line ? c.error : c.lineStrong, backgroundColor: c.surface, color: c.text, paddingHorizontal: 16 }]}
      />
      <T accessibilityLiveRegion="polite" style={[ui(13, 'body', 1.45), { color: c.error, minHeight: 20, marginTop: 8 }]}>{line}</T>
    </OnbShell>
  );
}
