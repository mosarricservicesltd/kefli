// Bring back your shelf (mobile spec 5.3; prototype return, return-offline): three ways back. The flows behind the
// rows (scan, recovery code, sign-in) are built in week 4. Offline, the notice sits under the title and the rows
// are disabled.
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
      <Choice icon="scan" title={S.ret.scan[0]} line={S.ret.scan[1]} disabled={!online} />
      <Choice icon="keyboard" title={S.ret.code[0]} line={S.ret.code[1]} disabled={!online} />
      <Choice icon="login" title={S.ret.nostr[0]} line={S.ret.nostr[1]} disabled={!online} />
    </OnbShell>
  );
}
