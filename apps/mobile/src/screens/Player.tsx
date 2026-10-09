// The player (mobile spec 5.7; prototype playerHTML, mini, play, play-paused, play-sentence, mini-reader): one float surface at
// the bottom. The mini on every screen with a session except first-launch screens and the playing article's Reader,
// which shows the Reader tier instead: the same surface in the reading palette with ±15 and the speed pill. The
// play button is the article's face, its cover with the fill disc on it. ✕ shows only while paused and ends the
// session everywhere. The line along the bottom is the article's one position, in its ink.
import { View } from 'react-native';
import { router, usePathname } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { SlideInDown, SlideOutDown } from 'react-native-reanimated';
import { motion, radius } from '@kefli/tokens';
import { enter, exit } from '@kefli/tokens/reanimated';
import type { ReaderColors } from '../reader/palette';
import { closeVoice, cycleRate, skip, toggle, useVoice, type Session } from '../services/voice';
import { clock, rateLabel, seconds } from '../voice/clock';
import { useEffect, useSyncExternalStore } from 'react';
import { Cover } from '../ui/Cover';
import { setToastLift } from '../ui/toast';
import { ShelfCover } from '../ui/cover';
import { Icon } from '../ui/Icon';
import { Press, pressLayer } from '../ui/Press';
import { T, mono13, ui } from '../ui/text';
import { alpha, useTheme } from '../ui/theme';
import { TAB_BAR_HEIGHT } from '../ui/TabBar';

export const PLAYER_HEIGHT = 64;
const TAB_PATHS = ['/', '/listen', '/you'];
const NO_PLAYER = ['/welcome', '/return', '/gates', '/back-test'];

export const S_PLAYER = {
  play: 'Play', pause: 'Pause', close: 'Close player', back15: 'Back 15 seconds', fwd15: 'Forward 15 seconds', speed: (r: string) => `Speed ${r}`, region: 'Player',
};

function Face({ s, fill, onFill }: { s: Session; fill: string; onFill: string }) {
  return (
    <Press accessibilityRole="button" accessibilityLabel={s.playing ? S_PLAYER.pause : S_PLAYER.play} onPress={toggle} layer={pressLayer(onFill, 'fill')} style={{ width: 48, height: 48, borderRadius: radius.control }}>
      <Cover hash={s.hash} size={48} radius={radius.control} />
      <View style={{ position: 'absolute', left: 9, top: 9, width: 30, height: 30, borderRadius: 15, backgroundColor: fill, alignItems: 'center', justifyContent: 'center', boxShadow: `0px 0px 0px 1.5px ${onFill}` }}>
        <Icon name={s.playing ? 'pause' : 'play'} size={14} color={onFill} solid />
      </View>
    </Press>
  );
}

function Line({ s, track, ink }: { s: Session; track: string; ink: string }) {
  const p = s.totalWords ? Math.min(1, s.word / s.totalWords) : 0;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', left: 28, right: 28, bottom: 5, height: 2, borderRadius: 999, backgroundColor: track, overflow: 'hidden' }}>
      <View style={{ width: `${p * 100}%`, height: 2, borderRadius: 999, backgroundColor: ink }} />
    </View>
  );
}

function Close({ color }: { color: string }) {
  return (
    <Press accessibilityRole="button" accessibilityLabel={S_PLAYER.close} onPress={closeVoice} layer={pressLayer(color)} style={{ width: 48, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name="x" size={20} color={color} />
    </Press>
  );
}

const surface = (bottom: number) => ({
  position: 'absolute' as const, left: 16, right: 16, bottom, height: PLAYER_HEIGHT, zIndex: 20, borderRadius: radius.container,
  flexDirection: 'row' as const, alignItems: 'center' as const, paddingHorizontal: 8, overflow: 'hidden' as const,
});

export function Mini({ s, bottom }: { s: Session; bottom: number }) {
  const { c } = useTheme();
  const t = seconds(s.word, s.wps, s.rate);
  const d = seconds(s.totalWords, s.wps, s.rate);
  return (
    <Animated.View
      entering={SlideInDown.duration(motion.enter.duration).easing(enter.easing!)} exiting={SlideOutDown.duration(motion.exit.duration).easing(exit.easing!)}
      accessibilityLabel={S_PLAYER.region} style={[surface(bottom), { gap: 12, backgroundColor: c.surface, boxShadow: c.shadowFloat }]}
    >
      <Face s={s} fill={c.fill} onFill={c.onFill} />
      <Press accessibilityRole="button" accessibilityLabel={s.title} onPress={() => router.push(`/reader/${s.hash}`)} layer={pressLayer(c.text)} style={{ flex: 1, minWidth: 0, alignSelf: 'stretch', justifyContent: 'center', gap: 2 }}>
        <T numberOfLines={1} style={ui(13, 'title', 1.3)}>{s.title}</T>
        <T style={[mono13, { color: c.muted }]}>{`${clock(t)} / ${clock(d)}`}</T>
      </Press>
      {!s.playing && <Close color={c.muted} />}
      <Line s={s} track={alpha(c.muted, 0.25)} ink={ShelfCover.lineInk(s.hash, c.surface, c.text)} />
    </Animated.View>
  );
}

/** The Reader tier: the mini expanded in place in the playing article's Reader, in the reading palette (Q1). */
export function ReaderTier({ s, P, bottom }: { s: Session; P: ReaderColors; bottom: number }) {
  const t = seconds(s.word, s.wps, s.rate);
  const d = seconds(s.totalWords, s.wps, s.rate);
  const ctl = (label: string, icon: 'back15' | 'fwd15', onPress: () => void) => (
    <Press accessibilityRole="button" accessibilityLabel={label} onPress={onPress} layer={pressLayer(P.text, 'reader')} style={{ width: 48, height: 48, borderRadius: radius.button, alignItems: 'center', justifyContent: 'center' }}>
      <Icon name={icon} size={24} color={P.text} />
    </Press>
  );
  return (
    <Animated.View
      entering={SlideInDown.duration(motion.enter.duration).easing(enter.easing!)} exiting={SlideOutDown.duration(motion.exit.duration).easing(exit.easing!)}
      accessibilityLabel={S_PLAYER.region} style={[surface(bottom), { gap: 2, backgroundColor: P.bg, boxShadow: P.float }]}
    >
      <Face s={s} fill={P.fill} onFill={P.onFill} />
      <T numberOfLines={1} style={[mono13, { flex: 1, minWidth: 0, paddingLeft: 10, color: P.muted }]}>{s.playing ? `${clock(t)} / ${clock(d)}` : clock(t)}</T>
      {ctl(S_PLAYER.back15, 'back15', () => skip(-15))}
      {ctl(S_PLAYER.fwd15, 'fwd15', () => skip(15))}
      <Press accessibilityRole="button" accessibilityLabel={S_PLAYER.speed(rateLabel(s.rate))} onPress={cycleRate} layer={pressLayer(P.text, 'reader')}
        style={{ height: 36, minWidth: 52, paddingHorizontal: 12, borderRadius: radius.control, backgroundColor: alpha(P.muted, 0.15), alignItems: 'center', justifyContent: 'center' }}>
        <T style={[ui(13, 'title', 1), { color: P.text, fontVariant: ['tabular-nums'] }]}>{rateLabel(s.rate)}</T>
      </Press>
      {!s.playing && <Close color={P.muted} />}
      <Line s={s} track={alpha(P.muted, 0.25)} ink={P.ink} />
    </Animated.View>
  );
}

// Listen's Now playing card is the player while it is on screen; the mini appears once the card is under 40% in
// view and leaves above 60% (5.7, FD 52). Listen reports which.
let cardShowing = false;
const cardListeners = new Set<() => void>();
export function setListenCardShowing(on: boolean): void {
  if (on === cardShowing) return;
  cardShowing = on;
  cardListeners.forEach((l) => l());
}

/** Where the mini shows (playerMode in the prototype): null where it doesn't, else its bottom. */
export function miniBottom(path: string, s: Session | null, insetBottom: number, listenCard = false): number | null {
  if (!s || NO_PLAYER.includes(path)) return null;
  if (path === '/listen' && listenCard) return null;
  if (path === `/reader/${s.hash}`) return null;
  return insetBottom + (TAB_PATHS.includes(path) ? TAB_BAR_HEIGHT + 8 : 16);
}

/** The one mini, above the navigator. */
export function PlayerHost() {
  const s = useVoice();
  const path = usePathname();
  const insets = useSafeAreaInsets();
  const card = useSyncExternalStore((l) => (cardListeners.add(l), () => cardListeners.delete(l)), () => cardShowing);
  const bottom = miniBottom(path, s, insets.bottom, card);
  const lift = bottom !== null && TAB_PATHS.includes(path) ? PLAYER_HEIGHT + 8 : 0;
  useEffect(() => setToastLift(lift), [lift]);
  if (bottom === null || !s) return null;
  return <Mini s={s} bottom={bottom} />;
}
