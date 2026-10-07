// The reading palettes (tokens reader.palette, FD 16, FD 71): Light and Sepia from the tokens, Dark as the
// article's own tinted Night (ShelfCover.night). Each takes the article's ink, for its lines and link underlines,
// and its spoken-word highlight. The palette follows the phone until one is picked (FD 89).
import { reader } from '@shelf/tokens';
import { ShelfCover } from '../ui/cover';
import { alpha } from '../ui/colour';

export type PaletteId = 'light' | 'sepia' | 'dark';

export type ReaderColors = {
  id: PaletteId; bg: string; text: string; muted: string; fill: string; onFill: string; ink: string; hl: string; float: string;
};

const TOKEN: Record<PaletteId, (typeof reader.palette)[keyof typeof reader.palette]> = {
  light: reader.palette.paper, sepia: reader.palette.sepia, dark: reader.palette.night,
};

export function readerColors(hash: string | null, id: PaletteId): ReaderColors {
  const P = TOKEN[id];
  if (!hash) return { id, bg: P.bg, text: P.text, muted: P.muted, fill: P.fill, onFill: P.onFill, ink: P.ink, hl: P.highlight, float: reader.floatShadow };
  if (id === 'dark') {
    const N = ShelfCover.night(hash);
    return { id, bg: N.bg, text: N.text, muted: N.muted, fill: N.text, onFill: N.bg, ink: N.line, hl: N.hl, float: `${reader.floatShadow}, 0px 0px 0px 1px ${alpha(N.muted, reader.floatRingMix)}` };
  }
  return {
    id, bg: P.bg, text: P.text, muted: P.muted, fill: P.fill, onFill: P.onFill,
    ink: ShelfCover.lineInk(hash, P.bg, P.text), hl: ShelfCover.highlight(hash, { bg: P.bg, text: P.text }),
    float: `${reader.floatShadow}, 0px 0px 0px 1px ${alpha(P.muted, reader.floatRingMix)}`,
  };
}

/** The stored reading size and palette, checked: a size outside 15–24 is the default, an unknown palette none. */
export function readPrefs(size: string | null, palette: string | null): { size: number; palette: PaletteId | null } {
  const n = Number(size);
  const ok = size !== null && Number.isInteger(n) && n >= reader.sizeRange[0] && reader.sizeRange[1] >= n;
  return { size: ok ? n : reader.size, palette: palette === 'light' || palette === 'sepia' || palette === 'dark' ? palette : null };
}
