// Three hairline ridges behind the Kept section, as if seen through thinning cloud.
// Deterministic value noise, so they draw the same on every visit.

const hash = (i: number, s: number) => {
  const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const noise = (x: number, s: number) => {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i, s) * (1 - u) + hash(i + 1, s) * u;
};
function mountain(x: number, s: number): number {
  let big = noise(x * 0.45, s);
  big = big * big * (3 - 2 * big);
  let v = 0;
  let a = 0.5;
  let f = 1;
  for (let o = 0; o < 6; o++) {
    let n = noise(x * f, s + o * 7.3);
    n = 1 - Math.abs(n * 2 - 1);
    v += a * n * n;
    f *= 2.07;
    a *= 0.47;
  }
  return big * 0.62 + v * 0.48;
}

/** An SVG path for one ridgeline across a width of w. */
export function ridgePath(w: number, base: number, amp: number, freq: number, seed: number): string {
  let d = '';
  for (let x = 0; x <= w; x += 6) {
    const y = base - mountain(x * freq, seed) * amp;
    d += `${x === 0 ? 'M' : ' L'}${x} ${y.toFixed(1)}`;
  }
  return d;
}

export function drawEcho(el: HTMLElement | null): void {
  if (!el) return;
  const line = (d: string, stroke: string, extra = '') => `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="1"${extra}/>`;
  el.innerHTML =
    '<svg viewBox="0 0 1600 260" preserveAspectRatio="xMidYMin slice" aria-hidden="true">' +
    line(ridgePath(1600, 150, 110, 0.0042, 11), 'var(--line)') +
    line(ridgePath(1600, 190, 130, 0.0031, 23), 'var(--cover-grey-soft)') +
    line(ridgePath(1600, 240, 150, 0.0024, 37), 'var(--line-strong)', ' stroke-opacity=".55"') +
    '</svg>';
}
