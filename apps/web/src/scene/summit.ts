// The summit: a photographed plate, its locked-off cloud loop, the wordmark standing behind the near ridge,
// and the scroll-linked descent into the cloud until it is the page. Scroll-linked, never scroll-jacked.
import { BURY, NARROW, coverFrame, descent, smooth, veilOffset, wordTop, type Frame } from './geometry';

interface Els {
  hero: HTMLElement;
  stage: HTMLElement;
  frame: HTMLElement;
  ridge: HTMLElement;
  video: HTMLVideoElement;
  veil: HTMLElement;
  word: HTMLElement;
  copy: HTMLElement;
  cue: HTMLElement;
}

function find(): Els | null {
  const q = (id: string) => document.getElementById(id);
  const els = {
    hero: q('hero'), stage: q('stage'), frame: q('frame'), ridge: q('ridge'), video: q('loop'),
    veil: q('veil'), word: q('word'), copy: q('heroCopy'), cue: q('cue'),
  };
  return Object.values(els).every(Boolean) ? (els as unknown as Els) : null;
}

export function initSummit(reducedMotion: boolean): void {
  const els = find();
  if (!els) return;
  const { hero, stage, frame, ridge, video, veil, word, copy, cue } = els;
  let box: Frame = coverFrame(stage.clientWidth, stage.clientHeight);

  function layout(): void {
    const w = stage.clientWidth;
    box = coverFrame(w, stage.clientHeight);
    frame.classList.add('fitted');
    Object.assign(frame.style, { width: `${box.width}px`, height: `${box.height}px`, left: `${box.left}px`, top: `${box.top}px` });
    const centre = w / 2 - box.left;
    word.style.left = `${centre}px`;
    word.style.top = `${wordTop(box, centre, word.offsetWidth, word.offsetHeight, w < NARROW ? BURY.narrow : BURY.wide)}px`;
  }

  // Every layer rides one camera: lowering it lifts the scene from its foot, the near ridge lifts most,
  // and the cloud bank climbs past you. The pointer moves the wordmark against the scene, for depth.
  function place(d: number, px: number, py: number): void {
    const h = stage.clientHeight;
    frame.style.transform = `translate3d(${(px * -10).toFixed(2)}px,${(py * 6).toFixed(2)}px,0) scale(${(1 + d * 0.32).toFixed(4)})`;
    word.style.transform = `translate3d(calc(-50% + ${(px * 18).toFixed(2)}px),${(d * 0.05 * box.height + py * -8).toFixed(2)}px,0)`;
    ridge.style.transform = `translate3d(0,${(-d * 0.04 * box.height).toFixed(2)}px,0)`;
    veil.style.transform = `translate3d(0,${veilOffset(d).toFixed(2)}%,0)`;
    const o = 1 - smooth(0.06, 0.38, d);
    copy.style.opacity = o.toFixed(3);
    copy.style.transform = `translate3d(0,${(-d * 0.22 * h).toFixed(1)}px,0)`;
    copy.style.visibility = o < 0.01 ? 'hidden' : 'visible';
    cue.style.opacity = (1 - smooth(0, 0.12, d)).toFixed(3);
  }

  layout();
  document.fonts?.ready.then(layout);
  window.addEventListener('resize', layout, { passive: true });

  // Reduced motion: the photograph alone, no loop and no descent.
  if (reducedMotion) {
    place(0, 0, 0);
    return;
  }

  // The cloud loop: a smaller file on phones; it fades in over the still once it plays.
  video.src = window.innerWidth < NARROW ? '/media/loop-1280.mp4' : '/media/loop-1920.mp4';
  video.preload = 'auto';
  video.addEventListener('playing', () => video.classList.add('on'));
  const playLoop = () => video.play().catch(() => {});

  const ptr = { x: 0, y: 0, tx: 0, ty: 0 };
  let d = 0;
  window.addEventListener('pointermove', (e) => {
    ptr.tx = (e.clientX / window.innerWidth) * 2 - 1;
    ptr.ty = -((e.clientY / window.innerHeight) * 2 - 1);
  }, { passive: true });

  let running = false;
  let raf = 0;
  let inView = true;
  function frameTick(): void {
    raf = 0;
    if (!running) return;
    ptr.x += (ptr.tx - ptr.x) * 0.045;
    ptr.y += (ptr.ty - ptr.y) * 0.045;
    const r = hero.getBoundingClientRect();
    const target = descent(r.top, r.height, stage.clientHeight);
    d += (target - d) * 0.14;
    if (Math.abs(target - d) < 0.0005) d = target;
    place(d, ptr.x, ptr.y);
    raf = requestAnimationFrame(frameTick);
  }
  function update(): void {
    const should = inView && !document.hidden;
    if (should && !running) {
      running = true;
      raf = requestAnimationFrame(frameTick);
      playLoop();
    } else if (!should && running) {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      video.pause();
    }
  }
  new IntersectionObserver((es) => { inView = es[0].isIntersecting; update(); }, { rootMargin: '80px' }).observe(stage);
  document.addEventListener('visibilitychange', update);
  update();
}
