// The article's text (mobile spec 6.7; prototype .article .prose): one memoised <Text> per block in Literata at
// the reading size and 1.6 leading, paragraphs a line apart. Links keep the reading colour, underlined in the
// article's ink, and open in the browser. Each block reports its place, so the Reader can lay out at a word.
import { memo, useEffect } from 'react';
import { Linking, ScrollView, Text, View, type GestureResponderEvent, type LayoutChangeEvent, type TextStyle } from 'react-native';
import { Image } from 'expo-image';
import Animated, { useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from 'react-native-reanimated';
import { motion } from '@kefli/tokens';
import { ambient } from '@kefli/tokens/reanimated';
import type { ImageRow } from '../data/images';
import { fontFamily, radius, reader as R } from '@kefli/tokens';
import type { Block, Span } from './blocks';
import { litPieces, type Lit } from './lit';
import type { ReaderColors } from './palette';
import { alpha } from '../ui/theme';

const face = (s: Span, bold = false): TextStyle => ({
  fontFamily: s.code ? fontFamily.mono : s.strong || bold ? fontFamily.reader.bold : s.em ? fontFamily.reader.italic : fontFamily.reader.regular,
});

export type { Lit } from './lit';

/**
 * The playing block's text, its spoken word (or sentence) split out to take the highlight wash (6.7: only the
 * playing paragraph splits); the text around it stays whole (./lit).
 */
function LitSpans({ spans, P, size, bold, lit }: { spans: Span[]; P: ReaderColors; size: number; bold?: boolean; lit: Lit }) {
  const pieces = litPieces(spans, lit);
  return (
    <>
      {spans.map((s, i) => (
        <Text key={i} style={[face(s, bold), s.code && { fontSize: size * 0.85 }, s.href && { textDecorationLine: 'underline', textDecorationColor: P.ink }]}>
          {pieces[i].map((p, j) => (p.on ? <Text key={j} style={{ backgroundColor: P.hl }}>{p.text}</Text> : p.text))}
        </Text>
      ))}
    </>
  );
}

function Spans({ spans, P, size, bold, lit }: { spans: Span[]; P: ReaderColors; size: number; bold?: boolean; lit?: Lit }) {
  if (lit) return <LitSpans spans={spans} P={P} size={size} bold={bold} lit={lit} />;
  return (
    <>
      {spans.map((s, i) => (
        <Text
          key={i}
          onPress={s.href && /^https?:\/\//.test(s.href) ? () => Linking.openURL(s.href!).catch(() => undefined) : undefined}
          style={[face(s, bold), s.code && { fontSize: size * 0.85 }, s.href && { textDecorationLine: 'underline', textDecorationColor: P.ink, color: P.text }]}
        >
          {s.text}
        </Text>
      ))}
    </>
  );
}

/** An image on its way (prototype .fig.wait): a 3:2 placeholder pulsing in opacity once the wait passes 150 ms. */
function Waiting({ P }: { P: ReaderColors }) {
  const o = useSharedValue(1);
  const still = useReducedMotion();
  useEffect(() => {
    if (still) return;
    o.value = withDelay(motion.ambient.delay, withRepeat(withSequence(withTiming(motion.ambient.pulse.opacity[0], ambient.pulse), withTiming(1, ambient.pulse)), -1));
  }, [o, still]);
  const st = useAnimatedStyle(() => ({ opacity: o.value }));
  return <Animated.View style={[{ width: '100%', aspectRatio: 3 / 2, borderRadius: radius.image, backgroundColor: alpha(P.muted, 0.18) }, st]} />;
}

export type FigureState = { row?: ImageRow; failed: boolean; online: boolean };

/**
 * The article's own image, exactly as published: never cropped or tinted (prototype .fig). On the phone it shows at
 * its stored size; on its way, a 3:2 placeholder (reader-images); failed, or missing while offline, it is left out.
 */
function Figure({ alt, P, img }: { alt: string; P: ReaderColors; img?: FigureState }) {
  if (img?.row?.path) {
    const ar = img.row.w && img.row.h ? img.row.w / img.row.h : 3 / 2;
    // never larger than published: a small image keeps its own size (its pixels as CSS pixels), centred
    // its own width, at most the column's, with the height from that width (not from the column's)
    const size = img.row.w ? { width: img.row.w, maxWidth: '100%' as const, alignSelf: 'center' as const } : { width: '100%' as const };
    return <Image source={{ uri: img.row.path }} accessibilityLabel={alt || undefined} accessible={!!alt} contentFit="contain" transition={0} style={[size, { aspectRatio: ar, borderRadius: radius.image }]} />;
  }
  if (!img || img.failed || !img.online) return null;
  return <Waiting P={P} />;
}

/** A tap on a block's text, for the Reader's double-tap on a word (FD 107); links keep their own press. */
export type OnTextTap = (e: GestureResponderEvent) => void;

export const BlockView = memo(function BlockView({ b, P, size, onLayout, lit, img, onTap }: { b: Block; P: ReaderColors; size: number; onLayout: (e: LayoutChangeEvent) => void; lit?: Lit; img?: FigureState; onTap?: OnTextTap }) {
  const body: TextStyle = { fontFamily: fontFamily.reader.regular, fontSize: size, lineHeight: size * R.lineHeight, color: P.text, includeFontPadding: false };
  const gap = { marginBottom: size };
  switch (b.kind) {
    case 'p':
      return <View onLayout={onLayout} style={gap}><Text style={body} onPress={onTap}><Spans spans={b.spans} P={P} size={size} lit={lit} /></Text></View>;
    case 'h': {
      const s = b.level <= 2 ? size * 1.2 : size;
      return (
        <View onLayout={onLayout} style={{ marginTop: size * 0.5, marginBottom: size * 0.6 }}>
          <Text accessibilityRole="header" style={[body, { fontSize: s, lineHeight: s * 1.35 }]} onPress={onTap}><Spans spans={b.spans} P={P} size={s} bold lit={lit} /></Text>
        </View>
      );
    }
    case 'quote':
      return (
        <View onLayout={onLayout} style={[gap, { borderLeftWidth: 3, borderLeftColor: alpha(P.muted, 0.35), paddingLeft: 14 }]}>
          <Text style={body} onPress={onTap}><Spans spans={b.spans} P={P} size={size} lit={lit} /></Text>
        </View>
      );
    case 'li':
      return (
        <View onLayout={onLayout} style={{ flexDirection: 'row', marginBottom: size * 0.5, paddingLeft: b.depth * size * 1.2 }}>
          <Text numberOfLines={1} style={[body, { minWidth: size * 1.4, paddingRight: size * 0.4 }]}>{b.marker}</Text>
          <Text style={[body, { flex: 1 }]} onPress={onTap}><Spans spans={b.spans} P={P} size={size} lit={lit} /></Text>
        </View>
      );
    case 'code':
      return (
        <View onLayout={onLayout} style={[gap, { borderRadius: radius.control, backgroundColor: alpha(P.muted, 0.1) }]}>
          <ScrollView horizontal contentContainerStyle={{ padding: 12 }}>
            <Text style={{ fontFamily: fontFamily.mono, fontSize: size * 0.75, lineHeight: size * 1.2, color: P.text }}>{b.text}</Text>
          </ScrollView>
        </View>
      );
    case 'img':
      // a figure left out takes no space, so the text closes up around it
      return <View onLayout={onLayout} style={img?.row?.path || (img && !img.failed && img.online) ? gap : undefined}><Figure alt={b.alt} P={P} img={img} /></View>;
    case 'hr':
      return <View onLayout={onLayout} style={{ height: 1, backgroundColor: alpha(P.muted, 0.25), marginVertical: size }} />;
  }
});
