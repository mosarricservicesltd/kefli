// Bring back your shelf (mobile spec 5.3; prototype return, return-offline): three ways back. The flows behind the
// rows (scan, recovery code, sign-in) are week 4's; the recovery code leads to Code, the scan to Scan, the sign-in to Nostr. Offline, the notice sits under the title and the rows
// are disabled.
import { router } from 'expo-router';
import { OnbShell, Choice, Lead } from './Onb';
import { Banner } from '../ui/Notice';
import { useOnline } from '../ui/online';
import { S } from '../ui/strings';

export default function Return() {
  const online = useOnline();
  return (
    <OnbShell title={S.ret.title}>
      {!online && <Banner text={S.ret.offline} style={{ marginHorizontal: 0 }} />}
      <Lead>{S.ret.lead}</Lead>
      <Choice icon="scan" title={S.ret.scan[0]} line={S.ret.scan[1]} disabled={!online} onPress={() => router.push('/scan')} />
      <Choice icon="keyboard" title={S.ret.code[0]} line={S.ret.code[1]} disabled={!online} onPress={() => router.push('/code')} />
      <Choice icon="login" title={S.ret.nostr[0]} line={S.ret.nostr[1]} disabled={!online} onPress={() => router.push('/nostr')} />
    </OnbShell>
  );
}
