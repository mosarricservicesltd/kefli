// Save without asking (FD 104; prototype nostr-bg, nostr-bg-waiting, nostr-bg-partial, nostr-bg-declined): the step
// after a sign-in whose nostr app won't sign everything saving needs without asking, and Your nostr app's way to fix it.
// Open my nostr app asks for each missing permission in turn, then checks again; Ask me each time, or ←, goes on with
// saving as it is. Waiting, ← and Cancel return here.
import { useEffect, useRef, useState } from 'react';
import { BackHandler, View } from 'react-native';
import type { BackgroundNeed, SignerProvider } from '@kefli/protocol';
import { approveMissing } from '../services/nostrCheck';
import { Button } from '../ui/Button';
import { Dots } from '../ui/Dots';
import { ErrLine } from '../ui/Notice';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { useTheme } from '../ui/theme';
import { Lead, OnbShell } from './Onb';

type Problem = 'partial' | 'declined' | null;

/** done(asks): asks is true when the person goes on with saving still asking, false once nothing is missing. */
export function SaveWithoutAsking({ signer, missing, done }: { signer: SignerProvider; missing: BackgroundNeed[]; done: (asks: boolean) => void }) {
  const { c } = useTheme();
  const [left, setLeft] = useState(missing);
  const [request, setRequest] = useState<number | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const attempt = useRef(0);

  const cancel = () => {
    attempt.current++;
    setRequest(null);
  };
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (request !== null) cancel();
      else done(true);
      return true;
    });
    return () => sub.remove();
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async () => {
    const mine = ++attempt.current;
    setProblem(null);
    setRequest(1);
    try {
      const still = await approveMissing(signer, left, (n) => mine === attempt.current && setRequest(n));
      if (mine !== attempt.current) return;
      if (!still.length) return done(false);
      setLeft(still);
      setProblem('partial');
    } catch {
      if (mine !== attempt.current) return;
      setProblem('declined');
    }
    setRequest(null);
  };

  if (request !== null) {
    return (
      <OnbShell title={S.bg.title} back={cancel} actions={<Button label={S.bg.cancel} kind="secondary" full onPress={cancel} />}>
        <View accessibilityLiveRegion="polite" style={{ alignItems: 'center', paddingVertical: 48, gap: 16 }}>
          <Dots color={c.text} />
          <T style={ui(17, 'heading', 1.3)}>{S.bg.waiting}</T>
          <T muted style={[ui(15, 'body', 1.45), { textAlign: 'center' }]}>{S.bg.waitingLead(request, left.length)}</T>
        </View>
      </OnbShell>
    );
  }
  const line = problem === 'partial' ? S.bg.partial : problem === 'declined' ? S.bg.declined : null;
  return (
    <OnbShell title={S.bg.title} back={() => done(true)} actions={(
      <>
        <Button label={problem === 'partial' ? S.bg.retry : S.bg.open} icon="login" full onPress={approve} />
        <Button label={S.bg.each} kind="quiet" full onPress={() => done(true)} />
      </>
    )}>
      {line && <ErrLine text={line} />}
      <Lead>{S.bg.lead}</Lead>
    </OnbShell>
  );
}
