// A save's cover (cover v1, mobile spec 6.4): drawn by Skia from the unmodified cover-v1.js, the same picture as the
// prototype, the extension and every other phone. A failed save keeps its shapes in the chrome's greys. Covers are
// hidden from accessibility: the title beside one already says what it is. The 1 px edge keeps a light ground off
// light paper and a dark ground off dark paper.
//
// Signature 1, drawn once: given the time its draw started (drawFrom, from cover_drawn), a cover draws itself leaf
// by leaf, each growing from 30% about its centre as it fades in, 34 ms after the last, over 520 ms (ShelfCover
// .motion.once), carrying on from where an interrupted draw was. Then it is the finished picture. Reduced motion
// shows it drawn.
import { memo, useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Canvas, Group, ImageSVG, Skia, type SkSVG } from '@shopify/react-native-skia';
import { Easing, useDerivedValue, useReducedMotion, useSharedValue, withDelay, withTiming, type SharedValue } from 'react-native-reanimated';
import { radius as R } from '@kefli/tokens';
import { drawMs } from '../data/covers';
import { ShelfCover } from './cover';
import { splitCover } from './coverLeaves';
import { useTheme } from './theme';

const cache = new Map<string, SkSVG | null>();

function coverSvg(hash: string, size: number, cols: number, grey: 'light' | 'dark' | null): SkSVG | null {
  const key = `${hash}|${size}|${cols}|${grey ?? ''}`;
  if (!cache.has(key)) cache.set(key, Skia.SVG.MakeFromString(ShelfCover.svg(hash, { size, cols, grey, depth: 3 })));
  return cache.get(key)!;
}

type Parts = { ground: SkSVG | null; leaves: { svg: SkSVG | null; cx: number; cy: number }[]; width: number; height: number };
const partsCache = new Map<string, Parts>();

function coverParts(hash: string, cols: number): Parts {
  const key = `${hash}|${cols}`;
  if (!partsCache.has(key)) {
    const s = splitCover(hash, cols);
    partsCache.set(key, {
      ground: Skia.SVG.MakeFromString(s.ground),
      leaves: s.leaves.map((l) => ({ svg: Skia.SVG.MakeFromString(l.svg), cx: l.cx, cy: l.cy })),
      width: s.width, height: s.height,
    });
  }
  return partsCache.get(key)!;
}

const M = ShelfCover.motion.once;
const ease = Easing.bezierFn(M.easing[0], M.easing[1], M.easing[2], M.easing[3]);

function Leaf({ svg, cx, cy, i, t, k, w, h }: { svg: SkSVG; cx: number; cy: number; i: number; t: SharedValue<number>; k: number; w: number; h: number }) {
  const p = useDerivedValue(() => ease(Math.min(1, Math.max(0, (t.value - i * M.staggerMs) / M.durationMs))));
  const opacity = useDerivedValue(() => M.fromOpacity + (1 - M.fromOpacity) * p.value);
  const transform = useDerivedValue(() => {
    const s = M.fromScale + (1 - M.fromScale) * p.value;
    return [{ translateX: cx * k }, { translateY: cy * k }, { scale: s }, { translateX: -cx * k }, { translateY: -cy * k }];
  });
  return (
    <Group opacity={opacity} transform={transform}>
      <ImageSVG svg={svg} x={0} y={0} width={w} height={h} />
    </Group>
  );
}

function Drawing({ hash, cols, w, h, from }: { hash: string; cols: number; w: number; h: number; from: number }) {
  const parts = useMemo(() => coverParts(hash, cols), [hash, cols]);
  const total = drawMs(parts.leaves.length, M);
  const t = useSharedValue(Math.max(0, Date.now() - from));
  useEffect(() => {
    // a draw that starts later (Welcome's, behind the launch screen) waits for its start
    const wait = Math.max(0, from - Date.now());
    t.value = withDelay(wait, withTiming(total, { duration: Math.max(0, total - t.value), easing: Easing.linear }));
  }, [t, total, from]);
  const k = w / parts.width;
  return (
    <Canvas style={{ width: w, height: h }}>
      {parts.ground && <ImageSVG svg={parts.ground} x={0} y={0} width={w} height={h} />}
      {parts.leaves.map((l, i) => l.svg && <Leaf key={i} svg={l.svg} cx={l.cx} cy={l.cy} i={i} t={t} k={k} w={w} h={h} />)}
    </Canvas>
  );
}

export const Cover = memo(function Cover({ hash, size, cols = 1, failed = false, radius = R.image, square = false, drawFrom = 0 }: {
  hash: string; size: number; cols?: number; failed?: boolean; radius?: number; square?: boolean;
  /** When this cover's draw started (epoch ms); 0 or past its length shows it drawn. */
  drawFrom?: number;
}) {
  const { name, c } = useTheme();
  const still = useReducedMotion();
  const w = size * cols;
  // cover-v1 takes whole pixels; the picture is drawn at the exact layout size.
  const px = Math.max(1, Math.round(size));
  const svg = useMemo(() => coverSvg(hash, px, cols, failed ? name : null), [hash, px, cols, failed, name]);
  // Decided once: a cover that draws keeps its drawing mounted, whose last frame is the finished picture, so the
  // hand-over to a static canvas never shows an empty frame.
  const [drawn] = useState(() => !drawFrom || still || failed || Date.now() - drawFrom >= drawMs(ShelfCover.leaves(hash, { depth: 3, cols }).length, M));
  const r = square ? 0 : radius;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: w, height: size, borderRadius: r, overflow: 'hidden', backgroundColor: c.line }}>
      {drawn
        ? <Canvas style={{ width: w, height: size }}>{svg && <ImageSVG svg={svg} x={0} y={0} width={w} height={size} />}</Canvas>
        : <Drawing hash={hash} cols={cols} w={w} h={size} from={drawFrom} />}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, square ? { borderBottomWidth: 1, borderColor: c.coverEdge } : { borderRadius: r, borderWidth: 1, borderColor: c.coverEdge }]} />
    </View>
  );
});
