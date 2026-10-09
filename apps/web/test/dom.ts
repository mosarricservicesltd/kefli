// Test doubles for the browser features jsdom lacks: IntersectionObserver, media playback, layout boxes,
// and a requestAnimationFrame the test steps by hand.

export interface FakeObserver {
  callback: (entries: { isIntersecting: boolean }[]) => void;
  target: Element | null;
  fire(isIntersecting: boolean): void;
}

export const observers: FakeObserver[] = [];

export function installObserver(): void {
  observers.length = 0;
  class IO implements FakeObserver {
    target: Element | null = null;
    constructor(public callback: (entries: { isIntersecting: boolean }[]) => void) {
      observers.push(this);
    }
    observe(el: Element) { this.target = el; }
    disconnect() {}
    fire(isIntersecting: boolean) { this.callback([{ isIntersecting }]); }
  }
  (window as unknown as { IntersectionObserver: unknown }).IntersectionObserver = IO;
}

export function installMedia(): { play: jest.Mock; pause: jest.Mock } {
  const play = jest.fn(() => Promise.resolve());
  const pause = jest.fn();
  Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play });
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: pause });
  return { play, pause };
}

/** Collects animation frames so a test can run them one at a time. */
export function installFrames(): { step(n?: number): void; pending(): number } {
  let queue: FrameRequestCallback[] = [];
  window.requestAnimationFrame = (cb: FrameRequestCallback) => { queue.push(cb); return queue.length; };
  window.cancelAnimationFrame = () => { queue = []; };
  return {
    step(n = 1) {
      for (let i = 0; i < n; i++) {
        const run = queue;
        queue = [];
        run.forEach((cb) => cb(performance.now()));
      }
    },
    pending: () => queue.length,
  };
}

export function setBox(el: Element, box: Partial<{ width: number; height: number; top: number; offsetTop: number }>): void {
  if (box.width !== undefined) Object.defineProperty(el, 'clientWidth', { configurable: true, value: box.width });
  if (box.height !== undefined) {
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: box.height });
    Object.defineProperty(el, 'offsetHeight', { configurable: true, value: box.height });
  }
  if (box.offsetTop !== undefined) Object.defineProperty(el, 'offsetTop', { configurable: true, value: box.offsetTop });
  const top = box.top ?? 0;
  const height = box.height ?? 0;
  (el as HTMLElement).getBoundingClientRect = () =>
    ({ top, height, bottom: top + height, left: 0, right: box.width ?? 0, width: box.width ?? 0, x: 0, y: top, toJSON() {} }) as DOMRect;
}
