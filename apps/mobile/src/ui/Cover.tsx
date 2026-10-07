// A save's cover (cover v1, mobile spec 6.4): drawn by Skia from the unmodified cover-v1.js, the same picture as the
// prototype, the extension and every other phone. A failed save keeps its shapes in the chrome's greys. Covers are
// hidden from accessibility: the title beside one already says what it is. The 1 px edge keeps a light ground off
// light paper and a dark ground off dark paper.
//
// The draw-in (signature 1) arrives with the share sheet and arriving rows; this draws the finished cover.
import { memo, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { Canvas, ImageSVG, Skia, type SkSVG } from '@shopify/react-native-skia';
import { radius as R } from '@shelf/tokens';
import { ShelfCover } from './cover';
import { useTheme } from './theme';

const cache = new Map<string, SkSVG | null>();

function coverSvg(hash: string, size: number, cols: number, grey: 'light' | 'dark' | null): SkSVG | null {
  const key = `${hash}|${size}|${cols}|${grey ?? ''}`;
  if (!cache.has(key)) cache.set(key, Skia.SVG.MakeFromString(ShelfCover.svg(hash, { size, cols, grey, depth: 3 })));
  return cache.get(key)!;
}

export const Cover = memo(function Cover({ hash, size, cols = 1, failed = false, radius = R.image, square = false }: {
  hash: string; size: number; cols?: number; failed?: boolean; radius?: number; square?: boolean;
}) {
  const { name, c } = useTheme();
  const w = size * cols;
  // cover-v1 takes whole pixels; the picture is drawn at the exact layout size.
  const px = Math.max(1, Math.round(size));
  const svg = useMemo(() => coverSvg(hash, px, cols, failed ? name : null), [hash, px, cols, failed, name]);
  const r = square ? 0 : radius;
  return (
    <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: w, height: size, borderRadius: r, overflow: 'hidden', backgroundColor: c.line }}>
      <Canvas style={{ width: w, height: size }}>{svg && <ImageSVG svg={svg} x={0} y={0} width={w} height={size} />}</Canvas>
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, square ? { borderBottomWidth: 1, borderColor: c.coverEdge } : { borderRadius: r, borderWidth: 1, borderColor: c.coverEdge }]} />
    </View>
  );
});
