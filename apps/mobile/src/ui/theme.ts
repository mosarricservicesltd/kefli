// The chrome's colours for the phone's theme (mobile spec 6.2): tokens 1.0.1, light or dark as the phone is set.
import { useColorScheme } from 'react-native';
import { colors, type ThemeColors, type ThemeName } from '@kefli/tokens';

export type Theme = { name: ThemeName; c: ThemeColors };

export function useTheme(): Theme {
  const name: ThemeName = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { name, c: colors[name] };
}

export { alpha, mix } from './colour';
