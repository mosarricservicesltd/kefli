// An icon from the prototype's set (icons.ts) at the token stroke, 1.75 (mobile spec 6.3); paths that carry their
// own stroke width (the ±15 numerals) keep it.
import { memo } from 'react';
import { SvgXml } from 'react-native-svg';
import { icons as iconTokens } from '@kefli/tokens';
import { ICONS, type IconName } from './icons';

export type { IconName };

function xml(name: IconName, color: string, solid: boolean): string {
  const fill = solid ? color : 'none';
  return `<svg viewBox="0 0 24 24" fill="${fill}" stroke="${color}" stroke-width="${iconTokens.stroke}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

export const Icon = memo(function Icon({ name, size = 20, color, solid = false }: { name: IconName; size?: number; color: string; solid?: boolean }) {
  return <SvgXml xml={xml(name, color, solid)} width={size} height={size} />;
});
