// The lock screen's artwork (mobile spec 6.4): the article's cover rendered offscreen by Skia at 512 px from the
// unmodified cover-v1.js, written once per article under the cache and handed to the media session.
import { Skia } from '@shopify/react-native-skia';
import { Directory, File, Paths } from 'expo-file-system';
import { ShelfCover } from './cover';

export const ARTWORK_PX = 512;

export function artworkPath(hash: string): string | null {
  const dir = new Directory(Paths.cache, 'artwork');
  const file = new File(dir, `${hash}.png`);
  if (file.exists) return file.uri;
  const svg = Skia.SVG.MakeFromString(ShelfCover.svg(hash, { size: ARTWORK_PX, depth: 3 }));
  const surface = Skia.Surface.MakeOffscreen(ARTWORK_PX, ARTWORK_PX);
  if (!svg || !surface) return null;
  surface.getCanvas().drawSvg(svg, ARTWORK_PX, ARTWORK_PX);
  surface.flush();
  const png = surface.makeImageSnapshot().encodeToBytes();
  if (!png?.length) return null;
  if (!dir.exists) dir.create({ intermediates: true });
  file.write(png);
  return file.uri;
}
