// An image's pixel size from its first bytes (mobile spec 5.6: the Reader keeps a placeholder at the stored size,
// images.w and h). PNG, JPEG, GIF and WebP, the formats articles use; anything else is unknown.
export type Size = { w: number; h: number };
export type Kind = 'png' | 'jpeg' | 'gif' | 'webp';

const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

export function imageKind(b: Uint8Array): Kind | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && ascii(b, 0, 4) === 'GIF8') return 'gif';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  return null;
}

/** JPEG: the first start-of-frame marker (C0–CF but C4, C8 and CC) holds height then width. */
function jpegSize(b: Uint8Array): Size | null {
  let i = 2;
  while (b.length > i + 9) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && 0xd7 >= marker)) {
      i += 2;
      continue;
    }
    const sof = marker >= 0xc0 && 0xcf >= marker && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (sof) return { h: u16be(b, i + 5), w: u16be(b, i + 7) };
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function webpSize(b: Uint8Array): Size | null {
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ' && b.length >= 30) return { w: u16le(b, 26) & 0x3fff, h: u16le(b, 28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) return { w: u24le(b, 24) + 1, h: u24le(b, 27) + 1 };
  return null;
}

export function imageSize(b: Uint8Array): Size | null {
  const size = (() => {
    switch (imageKind(b)) {
      case 'png': return b.length >= 24 ? { w: u32be(b, 16), h: u32be(b, 20) } : null;
      case 'gif': return b.length >= 10 ? { w: u16le(b, 6), h: u16le(b, 8) } : null;
      case 'jpeg': return jpegSize(b);
      case 'webp': return webpSize(b);
      default: return null;
    }
  })();
  return size && size.w > 0 && size.h > 0 ? size : null;
}

/**
 * Past these an image is left out, as one that isn't an image is: no phone lays out a side longer, and an image of
 * more pixels is a decompression bomb or a raw scan, which decoding at the column's width would still have to
 * inflate whole (and which expo-image's own guard, multiplying sides as 32-bit integers, can't measure).
 */
export const MAX_SIDE = 32_768;
export const MAX_PIXELS = 100_000_000;

/** Whether an image of this size can be drawn; one of unknown size is drawn as it comes, in a 3:2 place until then. */
export function drawable(size: Size | null): boolean {
  return !size || (size.w <= MAX_SIDE && size.h <= MAX_SIDE && size.w * size.h <= MAX_PIXELS);
}
