/**
 * @jest-environment jsdom
 */
import { initDusk } from '../src/scene/dusk';
import { installFrames, installMedia, installObserver, observers, setBox } from './dom';

function mount(): void {
  document.body.innerHTML = `
    <div class="dusk" id="dusk">
      <div class="dusk-scene" id="duskScene"><video id="duskLoop"></video></div>
      <div class="dusk-fog" id="duskFog"></div>
    </div>`;
}
const $ = (id: string) => document.getElementById(id) as HTMLElement;

describe('initDusk', () => {
  let media: ReturnType<typeof installMedia>;
  let frames: ReturnType<typeof installFrames>;
  beforeEach(() => {
    mount();
    installObserver();
    media = installMedia();
    frames = installFrames();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  });

  it('does nothing when the scene is missing', () => {
    document.body.innerHTML = '';
    expect(() => initDusk(false)).not.toThrow();
    expect(observers).toHaveLength(0);
  });

  it('shows the settled, cleared scene under reduced motion, with no loop', () => {
    initDusk(true);
    expect($('duskScene').style.transform).toBe('scale(1.0000)');
    expect(Number($('duskFog').style.opacity)).toBeCloseTo(0.2);
    expect(observers).toHaveLength(0);
    expect(($('duskLoop') as HTMLVideoElement).getAttribute('src')).toBeNull();
  });

  it('starts zoomed and fogged below the screen, and clears as it scrolls into view', () => {
    setBox($('dusk'), { top: 900, height: 600 });
    initDusk(false);
    frames.step();
    expect($('duskScene').style.transform).toBe('scale(1.1400)');
    expect(Number($('duskFog').style.opacity)).toBe(1);

    setBox($('dusk'), { top: 100, height: 600 });
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('scroll')); // a second scroll in the same frame is folded into it
    expect(frames.pending()).toBe(1);
    frames.step();
    expect(Number($('duskFog').style.opacity)).toBeLessThan(0.5);
  });

  it('loads the loop only as the scene comes near, picks the size for the screen, and pauses it once gone', () => {
    initDusk(false);
    const loop = $('duskLoop') as HTMLVideoElement;
    expect(loop.getAttribute('src')).toBeNull();
    observers[0].fire(true);
    expect(loop.getAttribute('src')).toBe('/media/dusk-loop-1920.mp4');
    expect(media.play).toHaveBeenCalledTimes(1);
    observers[0].fire(false);
    expect(media.pause).toHaveBeenCalledTimes(1);
    observers[0].fire(true);
    expect(media.play).toHaveBeenCalledTimes(2);
    loop.dispatchEvent(new Event('playing'));
    expect(loop.classList.contains('on')).toBe(true);
  });

  it('takes the smaller loop on a phone, and never pauses a loop it never loaded', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
    initDusk(false);
    observers[0].fire(false);
    expect(media.pause).not.toHaveBeenCalled();
    observers[0].fire(true);
    expect(($('duskLoop') as HTMLVideoElement).getAttribute('src')).toBe('/media/dusk-loop-1280.mp4');
  });
});
