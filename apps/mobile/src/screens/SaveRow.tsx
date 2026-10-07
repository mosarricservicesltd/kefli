// A save in a list (prototype cardHTML; mobile spec 5.6, 6.6): flat, a hairline under it that is also its
// reading line in the article's ink, its cover at the right. A save still waiting for its text shows its address
// and the waiting dot (offline, the hourglass); a failed one is stamped and its cover turns to the greys.
//
// Swipe (MS Lists): vertical scroll keeps priority until 10 px sideways; the row arms at 96 px with a tick and
// commits there, or on a flick over 800 px/s after 32 px, flying off on the release spring. Unread rows swipe
// left to Archive; archived rows swipe right to Back to Unread and carry a visible ⋯.
import { memo } from 'react';
import { View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedReaction, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { radius } from '@shelf/tokens';
import { quickIn, quickOut, release } from '@shelf/tokens/reanimated';
import { minutes, minutesLeft, progressOf, rowStatus, type LibRow } from '../data/library';
import { Cover } from '../ui/Cover';
import { ShelfCover } from '../ui/cover';
import { WaitDot } from '../ui/Dots';
import { Icon } from '../ui/Icon';
import { Press, pressLayer } from '../ui/Press';
import { S } from '../ui/strings';
import { browserName } from '../data/inbox';
import { T, ui } from '../ui/text';
import { useTheme } from '../ui/theme';

export const ARM = 96;

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function Meta({ r, online, ink, tag }: { r: LibRow; online: boolean; ink: string; tag?: boolean }) {
  const { c } = useTheme();
  const status = rowStatus(r);
  const meta = ui(13, 'body', 1.3);
  if (status === 'waiting') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {online && r.x_state !== 'pending' ? <WaitDot color={ink} /> : <Icon name="hourglass" size={14} color={c.muted} />}
        <T muted style={meta}>{!online ? S.row.willFetch : r.x_state === 'pending' ? S.row.xWaiting : S.row.getting}</T>
      </View>
    );
  }
  if (status === 'failed') {
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <View style={{ height: 24, paddingHorizontal: 7, borderWidth: 1.5, borderColor: c.muted, borderRadius: radius.image, justifyContent: 'center', transform: [{ rotate: '-2deg' }] }}>
          <T muted style={[ui(13, 'heading', 1), { letterSpacing: 0.65 }]}>{S.row.failed.toUpperCase()}</T>
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
          <T style={[ui(13, 'label', 1.3), { textDecorationLine: 'underline', textDecorationColor: c.lineStrong }]}>{S.row.openOriginal}</T>
          <Icon name="ext" size={14} color={c.text} />
        </View>
      </View>
    );
  }
  const left = progressOf(r) > 0 && progressOf(r) < 1 ? minutesLeft(r) : null;
  const mins = minutes(r.words);
  const time = left !== null ? <T style={[meta, ui(13, 'title', 1.3)]}>{S.row.minsLeft(left)}</T>
    : mins === null ? null : <T muted style={meta}>{S.row.mins(mins)}</T>;
  // in Search, an archived result carries the Archive tag after its time (prototype rowMetaHTML)
  if (!tag || r.state !== 'archived') return time;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      {time}
      {time && <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: c.muted, opacity: 0.7 }} />}
      <View style={{ height: 24, paddingHorizontal: 8, borderRadius: radius.control, borderWidth: 1, borderColor: c.lineStrong, justifyContent: 'center' }}>
        <T style={ui(13, 'meta', 1)}>{S.row.archive}</T>
      </View>
    </View>
  );
}

type Props = {
  r: LibRow; online: boolean; onOpen: (r: LibRow) => void; onSwipe: (r: LibRow) => void; onMore?: (r: LibRow) => void; drawFrom?: number;
  /** Search: archived results are tagged, and a swipe changes the save in place, the row returning (5.6). */
  inPlace?: boolean;
};

export const SaveRow = memo(function SaveRow({ r, online, onOpen, onSwipe, onMore, drawFrom = 0, inPlace = false }: Props) {
  const { c } = useTheme();
  const { width } = useWindowDimensions();
  const archived = r.state === 'archived';
  const status = rowStatus(r);
  const ink = ShelfCover.lineInk(r.hash, c.background, c.text);
  const p = progressOf(r);
  const tx = useSharedValue(0);
  const armed = useSharedValue(false);
  const dir = archived ? 1 : -1;

  const tick = () => Haptics.selectionAsync().catch(() => undefined);
  useAnimatedReaction(() => Math.abs(tx.value) >= ARM, (now, before) => {
    armed.value = now;
    if (now && before === false) runOnJS(tick)();
  });

  const pan = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onChange((e) => {
      // only the row's own direction moves it
      tx.value = dir < 0 ? Math.min(0, tx.value + e.changeX) : Math.max(0, tx.value + e.changeX);
    })
    .onEnd((e) => {
      const flick = Math.abs(e.velocityX) > 800 && Math.abs(tx.value) > 32 && Math.sign(e.velocityX) === dir;
      if ((armed.value || flick) && inPlace) {
        runOnJS(onSwipe)(r);
        tx.value = withSpring(0, { ...release, velocity: e.velocityX });
      } else if (armed.value || flick) {
        tx.value = withSpring(dir * width, { ...release, velocity: e.velocityX }, (done) => done && runOnJS(onSwipe)(r));
      } else {
        tx.value = withSpring(0, { ...release, velocity: e.velocityX });
      }
    });

  const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));
  const underStyle = useAnimatedStyle(() => ({ opacity: tx.value === 0 ? 0 : 1 }));
  const markStyle = useAnimatedStyle(() => ({
    opacity: withTiming(armed.value ? 1 : 0.7, armed.value ? quickIn : quickOut),
    transform: [{ scale: withTiming(armed.value ? 1 : 0.9, armed.value ? quickIn : quickOut) }],
  }));
  const labelStyle = useAnimatedStyle(() => ({ opacity: withTiming(armed.value ? 1 : 0.7, armed.value ? quickIn : quickOut) }));

  const title = r.title ?? (status === 'waiting' ? r.url.replace(/^https?:\/\//, '') : hostOf(r.url));
  const urlTitle = !r.title;
  return (
    <View>
      <Animated.View pointerEvents="none" style={[{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radius.container, backgroundColor: c.fill, flexDirection: 'row', alignItems: 'center', justifyContent: archived ? 'flex-start' : 'flex-end', gap: 8, paddingHorizontal: 20 }, underStyle]}>
        <Animated.View style={markStyle}><Icon name={archived ? 'restore' : 'archive'} size={18} color={c.onFill} /></Animated.View>
        <Animated.View style={labelStyle}><T style={[ui(13, 'title', 1.3), { color: c.onFill }]}>{archived ? S.row.backToUnread : S.row.archive}</T></Animated.View>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <Animated.View style={cardStyle}>
          <Press
            accessibilityRole="button" accessibilityLabel={title}
            accessibilityActions={[{ name: 'swipe', label: archived ? S.row.backToUnread : S.row.archive }]}
            onAccessibilityAction={() => onSwipe(r)}
            onPress={() => onOpen(r)} layer={pressLayer(c.text)}
            style={{ flexDirection: 'row', gap: 12, alignItems: 'flex-start', paddingTop: 14, paddingBottom: 15, paddingRight: onMore ? 44 : 0, backgroundColor: c.background }}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              {status === 'waiting' && r.origin_device ? (
                // a browser save on its way (prototype saves-arrive): the browser's name until the text is here
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Icon name="laptop" size={14} color={c.muted} />
                  <T muted numberOfLines={1} style={ui(13, 'meta', 1.3)}>{S.row.from(browserName(r.origin_device))}</T>
                </View>
              ) : <T muted numberOfLines={1} style={ui(13, 'meta', 1.3)}>{status === 'waiting' && urlTitle ? hostOf(r.url) : r.site ?? hostOf(r.url)}</T>}
              <T numberOfLines={3} style={[ui(15, urlTitle ? 'meta' : 'title', 1.35, -0.005), { marginTop: 3, marginBottom: 7 }, urlTitle && { color: c.muted }]}>{title}</T>
              <Meta r={r} online={online} ink={ink} tag={inPlace} />
            </View>
            <Cover hash={r.hash} size={64} failed={status === 'failed'} drawFrom={drawFrom} />
            <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 1, backgroundColor: c.line }} />
            {status === 'ok' && p > 0 && p < 1 && (
              <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, overflow: 'hidden' }}>
                <View style={{ width: `${p * 100}%`, height: 3, backgroundColor: ink, borderTopRightRadius: 2, borderBottomRightRadius: 2 }} />
              </View>
            )}
          </Press>
          {onMore && (
            <Press accessibilityRole="button" accessibilityLabel={S.row.more(title)} onPress={() => onMore(r)} layer={pressLayer(c.text)} style={{ position: 'absolute', right: -8, top: '50%', marginTop: -24, width: 48, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="more" size={20} color={c.muted} />
            </Press>
          )}
        </Animated.View>
      </GestureDetector>
    </View>
  );
});
