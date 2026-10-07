// cover-v1.js, unmodified (shared/cover), typed for the app: covers, the article's ink and its highlight (CV).
/* eslint-disable @typescript-eslint/no-require-imports */
type Palette = { ground: string; deep: string; soft: string; signal: string; hue: number; dark: boolean };
export const ShelfCover = require('../../../../shared/cover/cover-v1.js') as {
  svg(hash: string, o: { size?: number; cols?: number; grey?: 'light' | 'dark' | null; depth?: number; draw?: boolean }): string;
  palette(hash: string): Palette;
  leaves(hash: string, o?: { depth?: number; cols?: number }): { x: number; y: number; s: number; d: number; mod: string; rot: number }[];
  lineInk(hash: string, surface: string, text?: string): string;
  highlight(hash: string, o: { bg: string; text: string }): string;
  night(hash: string): { bg: string; text: string; muted: string; line: string; hl: string };
  motion: { once: { durationMs: number; staggerMs: number; easing: [number, number, number, number]; fromScale: number; fromOpacity: number } };
};
