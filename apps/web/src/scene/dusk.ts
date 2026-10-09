// The dusk above the footer: out from under the cloud. The fog lifts and thins and the peaks settle from
// a slight zoom as the scene comes into view. Scroll-linked, never scroll-jacked.
import { NARROW, duskProgress, duskState } from './geometry';

export function initDusk(reducedMotion: boolean): void {
  const dusk = document.getElementById('dusk');
  const scene = document.getElementById('duskScene');
  const fog = document.getElementById('duskFog');
  const loop = document.getElementById('duskLoop') as HTMLVideoElement | null;
  if (!dusk || !scene || !fog || !loop) return;

  const place = (p: number) => {
    const s = duskState(p);
    scene.style.transform = `scale(${s.scale.toFixed(4)})`;
    fog.style.transform = `translate3d(0,${s.fogLift.toFixed(2)}%,0)`;
    fog.style.opacity = s.fogOpacity.toFixed(3);
  };

  if (reducedMotion) {
    place(1);
    return;
  }

  let queued = false;
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      const r = dusk.getBoundingClientRect();
      place(duskProgress(r.top, r.height, window.innerHeight));
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', onScroll, { passive: true });
  onScroll();

  // The loop loads only as the scene comes near, and pauses once it's gone.
  loop.addEventListener('playing', () => loop.classList.add('on'));
  new IntersectionObserver((es) => {
    if (es[0].isIntersecting) {
      if (!loop.src) {
        loop.src = window.innerWidth < NARROW ? '/media/dusk-loop-1280.mp4' : '/media/dusk-loop-1920.mp4';
        loop.preload = 'auto';
      }
      loop.play().catch(() => {});
    } else if (loop.src) {
      loop.pause();
    }
  }, { rootMargin: '200px' }).observe(dusk);
}
