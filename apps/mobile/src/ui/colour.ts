// Colour helpers, platform-free: the prototype's color-mix() in the forms the app uses.

/** #RRGGBB at an opacity, as #RRGGBBAA: the prototype's color-mix(… n%, transparent). */
export function alpha(hex: string, a: number): string {
  return `${hex.slice(0, 7)}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0').toUpperCase()}`;
}

/** a mixed towards b by t, per sRGB byte: the prototype's color-mix(in srgb, a (1−t), b). */
export function mix(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + 2 * i, 3 + 2 * i), 16);
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * t).toString(16).padStart(2, '0'));
  return `#${out.join('').toUpperCase()}`;
}
