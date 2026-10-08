// The restore card (mobile spec 5.3, prototype restoring, restoring-mid, restoring-offline, restore-nothing): in Saves' notice slot
// while a restore runs, "N of M" over a determinate bar; offline it says it is paused, in place of the offline
// notice. Done, "All N saves are back" holds for 3 s, then the card leaves; a restore that found nothing shows no card.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import Animated, { FadeIn, FadeOut, useSharedValue, withTiming } from 'react-native-reanimated';
import { radius } from '@shelf/tokens';
import { reflow } from '@shelf/tokens/reanimated';
import { DONE_HOLD_S, restoreCardShows, restoreOf } from '../data/restore';
import { store } from '../services/store';
import { Icon } from '../ui/Icon';
import { SlidingLine } from '../ui/Line';
import { useLive } from '../ui/live';
import { S } from '../ui/strings';
import { T, ui } from '../ui/text';
import { useTheme } from '../ui/theme';

export function useRestoreCard(owner: string): boolean {
  const r = useLive(() => (owner ? restoreOf(store(), owner) : null), ['items', 'jobs'], [owner]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  // the done card's hold ends by the clock, not by a change in the database
  useEffect(() => {
    if (r?.state !== 'done' || r.doneAt === null) return;
    const left = r.doneAt + DONE_HOLD_S - Math.floor(Date.now() / 1000);
    if (left <= 0) return;
    const t = setTimeout(() => setNow(Math.floor(Date.now() / 1000)), left * 1000 + 50);
    return () => clearTimeout(t);
  }, [r?.state, r?.doneAt]);
  return restoreCardShows(r, Math.max(now, Math.floor(Date.now() / 1000)));
}

export function RestoreCard({ owner, offline }: { owner: string; offline: boolean }) {
  const { c } = useTheme();
  const r = useLive(() => (owner ? restoreOf(store(), owner) : null), ['items', 'jobs'], [owner]);
  const p = useSharedValue(0);
  const share = r && r.total ? r.found / r.total : 0;
  useEffect(() => {
    p.value = withTiming(share, reflow);
  }, [share, p]);
  if (!r) return null;
  const done = r.state === 'done';
  return (
    <Animated.View entering={FadeIn} exiting={FadeOut} accessibilityLiveRegion="polite"
      style={{ marginTop: 4, marginHorizontal: 16, marginBottom: 12, padding: 16, borderRadius: radius.container, backgroundColor: c.surface, borderWidth: 1, borderColor: c.line }}>
      {done ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <View style={{ width: 24, height: 24, borderRadius: 12, backgroundColor: c.success, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="check" size={14} color={c.onFill} />
          </View>
          <T style={ui(17, 'heading', 1.3)}>{S.restore.done(r.total)}</T>
        </View>
      ) : (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
            <T style={ui(17, 'heading', 1.3)}>{S.restore.title}</T>
            {r.total > 0 && <T muted style={[ui(13, 'meta', 1.3), { fontVariant: ['tabular-nums'] }]}>{S.restore.count(r.found, r.total)}</T>}
          </View>
          <SlidingLine p={p} color={c.text} height={4} round style={{ borderRadius: 999, backgroundColor: c.line, marginBottom: 8 }} />
          <T muted style={ui(13, 'body', 1.45)}>{offline ? S.restore.paused : S.restore.body}</T>
        </>
      )}
    </Animated.View>
  );
}
