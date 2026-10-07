// The article's text (mobile spec 6.7; prototype .article .prose): one memoised <Text> per block in Literata at
// the reading size and 1.6 leading, paragraphs a line apart. Links keep the reading colour, underlined in the
// article's ink, and open in the browser. Each block reports its place, so the Reader can lay out at a word.
import { memo, useState } from 'react';
import { Image, Linking, ScrollView, Text, View, type LayoutChangeEvent, type TextStyle } from 'react-native';
import { fontFamily, radius, reader as R } from '@shelf/tokens';
import type { Block, Span } from './blocks';
import type { ReaderColors } from './palette';
import { alpha } from '../ui/theme';

const face = (s: Span, bold = false): TextStyle => ({
  fontFamily: s.code ? fontFamily.mono : s.strong || bold ? fontFamily.reader.bold : s.em ? fontFamily.reader.italic : fontFamily.reader.regular,
});

/** The words the voice is on, as indices of the block's whitespace-separated words (one, or a whole sentence). */
export type Lit = { from: number; to: number };

/**
 * The playing block's text, split into its words so the spoken one takes the highlight wash (6.7: only the
 * playing paragraph splits). Words are counted across the spans, as the spoken projection counts them.
 */
function LitSpans({ spans, P, size, bold, lit }: { spans: Span[]; P: ReaderColors; size: number; bold?: boolean; lit: Lit }) {
  let k = -1;
  let wasSpace = true;
  return (
    <>
      {spans.map((s, i) => (
        <Text key={i} style={[face(s, bold), s.code && { fontSize: size * 0.85 }, s.href && { textDecorationLine: 'underline', textDecorationColor: P.ink }]}>
          {s.text.split(/(\s+)/).map((piece, j) => {
            if (piece === '') return null;
            if (/^\s+$/.test(piece)) {
              wasSpace = true;
              return piece;
            }
            if (wasSpace) k++;
            wasSpace = false;
            const on = k >= lit.from && lit.to >= k;
            return on ? <Text key={j} style={{ backgroundColor: P.hl }}>{piece}</Text> : piece;
          })}
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

function Figure({ src, alt, P }: { src: string; alt: string; P: ReaderColors }) {
  const [ar, setAr] = useState<number | null>(null);
  const [gone, setGone] = useState(false);
  // Images are kept on the phone once phase 6 of sync arrives (4.5); until then one that won't load is left out.
  if (gone) return null;
  return (
    <Image
      source={{ uri: src }} accessibilityLabel={alt || undefined} accessible={!!alt}
      onLoad={(e) => setAr(e.nativeEvent.source.width / Math.max(1, e.nativeEvent.source.height))}
      onError={() => setGone(true)}
      resizeMode="contain"
      style={{ width: '100%', aspectRatio: ar ?? 3 / 2, borderRadius: radius.image, backgroundColor: ar ? undefined : alpha(P.muted, 0.18) }}
    />
  );
}

export const BlockView = memo(function BlockView({ b, P, size, onLayout, lit }: { b: Block; P: ReaderColors; size: number; onLayout: (e: LayoutChangeEvent) => void; lit?: Lit }) {
  const body: TextStyle = { fontFamily: fontFamily.reader.regular, fontSize: size, lineHeight: size * R.lineHeight, color: P.text, includeFontPadding: false };
  const gap = { marginBottom: size };
  switch (b.kind) {
    case 'p':
      return <View onLayout={onLayout} style={gap}><Text style={body}><Spans spans={b.spans} P={P} size={size} lit={lit} /></Text></View>;
    case 'h': {
      const s = b.level <= 2 ? size * 1.2 : size;
      return (
        <View onLayout={onLayout} style={{ marginTop: size * 0.5, marginBottom: size * 0.6 }}>
          <Text accessibilityRole="header" style={[body, { fontSize: s, lineHeight: s * 1.35 }]}><Spans spans={b.spans} P={P} size={s} bold lit={lit} /></Text>
        </View>
      );
    }
    case 'quote':
      return (
        <View onLayout={onLayout} style={[gap, { borderLeftWidth: 3, borderLeftColor: alpha(P.muted, 0.35), paddingLeft: 14 }]}>
          <Text style={body}><Spans spans={b.spans} P={P} size={size} lit={lit} /></Text>
        </View>
      );
    case 'li':
      return (
        <View onLayout={onLayout} style={{ flexDirection: 'row', marginBottom: size * 0.5, paddingLeft: b.depth * size * 1.2 }}>
          <Text numberOfLines={1} style={[body, { minWidth: size * 1.4, paddingRight: size * 0.4 }]}>{b.marker}</Text>
          <Text style={[body, { flex: 1 }]}><Spans spans={b.spans} P={P} size={size} lit={lit} /></Text>
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
      return <View onLayout={onLayout} style={gap}><Figure src={b.src} alt={b.alt} P={P} /></View>;
    case 'hr':
      return <View onLayout={onLayout} style={{ height: 1, backgroundColor: alpha(P.muted, 0.25), marginVertical: size }} />;
  }
});
