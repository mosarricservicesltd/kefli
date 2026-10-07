// Text in the app's type (tokens 1.0.1, mobile spec 6.3): each weight is its own static cut, so fontWeight is never
// set and Android never synthesises one. includeFontPadding is off everywhere, so a label centres on its capitals
// inside a bordered or filled element (CLAUDE.md, UI).
import { Text, type TextProps, type TextStyle } from 'react-native';
import { fontFamily, type } from '@shelf/tokens';
import { useTheme } from './theme';

type Weight = keyof typeof fontFamily.ui;

/** A UI text style: size in px, a weight role, line height as a multiple (the prototype's per-rule leading). */
export function ui(size: number, weight: Weight = 'body', leading = 1.45, tracking = 0): TextStyle {
  return { fontFamily: fontFamily.ui[weight], fontSize: size, lineHeight: Math.round(size * leading * 100) / 100, letterSpacing: tracking * size, includeFontPadding: false };
}

export const display28: TextStyle = { ...type.display[28], includeFontPadding: false };
export const articleTitle: TextStyle = { ...type.articleTitle, includeFontPadding: false };
export const mono13: TextStyle = { ...type.mono, includeFontPadding: false };

/** Text in the theme's text colour (or muted), with the given style. */
export function T({ style, muted, ...p }: TextProps & { muted?: boolean }) {
  const { c } = useTheme();
  return <Text {...p} style={[{ color: muted ? c.muted : c.text, includeFontPadding: false, textAlignVertical: 'center' }, style]} />;
}
