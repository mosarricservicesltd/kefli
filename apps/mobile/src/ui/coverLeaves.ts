// A cover split into its leaves for the draw-in (mobile spec 6.4), from cover-v1's own SVG with draw: true, so
// no shape is redrawn here and the finished picture is the module's exactly. Each leaf becomes its own SVG on the
// cover's viewBox, with the centre it grows from (CSS transform-box: fill-box, transform-origin: center).
import { ShelfCover } from './cover';

export type Leaf = { svg: string; cx: number; cy: number };
export type SplitCover = { ground: string; leaves: Leaf[]; width: number; height: number };

const OPEN = /<g transform="translate\(([\d.-]+) ([\d.-]+)\)"><g class="lf" style="--i:(\d+)">/g;

/** The end of the <g> element that starts at `at`, by counting nested <g> and </g>. */
function closeOf(svg: string, at: number): number {
  const tag = /<g[\s>]|<\/g>/g;
  tag.lastIndex = at;
  let depth = 0;
  for (let m = tag.exec(svg); m; m = tag.exec(svg)) {
    depth += m[0] === '</g>' ? -1 : 1;
    if (depth === 0) return m.index + 4;
  }
  return svg.length;
}

export function splitCover(hash: string, cols = 1, grey: 'light' | 'dark' | null = null): SplitCover {
  const svg = ShelfCover.svg(hash, { cols, grey, depth: 3, draw: true });
  const vb = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg);
  const width = vb ? Number(vb[1]) : 800 * cols;
  const height = vb ? Number(vb[2]) : 800;
  const wrap = (inner: string) => `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice">${inner}</svg>`;
  const ground = /<rect width="[\d.]+" height="[\d.]+" fill="#[0-9A-F]{6}"\/>/.exec(svg)?.[0] ?? '';
  const sizes = ShelfCover.leaves(hash, { depth: 3, cols }).map((l) => l.s);
  const leaves: Leaf[] = [];
  for (let m = OPEN.exec(svg); m; m = OPEN.exec(svg)) {
    const end = closeOf(svg, m.index);
    const i = Number(m[3]);
    const s = (sizes[i] ?? 1) * 100;
    leaves.push({ svg: wrap(svg.slice(m.index, end).replace(/ class="lf" style="--i:\d+"/, '')), cx: Number(m[1]) + s / 2, cy: Number(m[2]) + s / 2 });
    OPEN.lastIndex = end;
  }
  OPEN.lastIndex = 0;
  return { ground: wrap(ground), leaves, width, height };
}
