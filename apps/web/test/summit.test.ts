/**
 * @jest-environment jsdom
 */
import { initSummit } from '../src/scene/summit';
import { installFrames, installMedia, installObserver, observers, setBox } from './dom';

function mount(): void {
  document.body.innerHTML = `
    <section id="hero">
      <div id="stage">
        <div id="frame"><video id="loop"></video><h1 id="word">Kefli</h1><img id="ridge" alt=""></div>
        <div id="veil"></div>
        <div id="heroCopy"></div>
        <a id="cue" href="#how"></a>
      </div>
    </section>`;
}
const $ = (id: string) => document.getElementById(id) as HTMLElement;

describe('initSummit', () => {
  let media: ReturnType<typeof installMedia>;
  let frames: ReturnType<typeof installFrames>;
  beforeEach(() => {
    mount();
    installObserver();
    media = installMedia();
    frames = installFrames();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
    setBox($('stage'), { width: 1440, height: 900 });
    setBox($('hero'), { top: 0, height: 2160 });
    setBox($('word'), { width: 800, height: 270 });
  });

  it('does nothing when the scene is incomplete', () => {
    $('veil').remove();
    expect(() => initSummit(false)).not.toThrow();
    expect($('frame').classList.contains('fitted')).toBe(false);
  });

  it('fits the photograph to the stage and stands the wordmark behind the rock', () => {
    initSummit(true);
    const frame = $('frame');
    expect(frame.classList.contains('fitted')).toBe(true);
    expect(parseFloat(frame.style.height)).toBeCloseTo(900);
    expect(parseFloat(frame.style.width)).toBeGreaterThan(1440);
    const wordTop = parseFloat($('word').style.top);
    expect(wordTop + 270).toBeGreaterThan(0.7 * 900);
  });

  it('shows the summit at rest under reduced motion: no loop, no descent, the copy in full', () => {
    initSummit(true);
    expect($('veil').style.transform).toBe('translate3d(0,100.00%,0)');
    expect(Number($('heroCopy').style.opacity)).toBe(1);
    expect(($('loop') as HTMLVideoElement).getAttribute('src')).toBeNull();
    expect(observers).toHaveLength(0);
  });

  it('plays the loop, and descends into the cloud as the hero scrolls away', () => {
    initSummit(false);
    const loop = $('loop') as HTMLVideoElement;
    expect(loop.getAttribute('src')).toBe('/media/loop-1920.mp4');
    expect(media.play).toHaveBeenCalledTimes(1);
    loop.dispatchEvent(new Event('playing'));
    expect(loop.classList.contains('on')).toBe(true);

    setBox($('hero'), { top: -1260, height: 2160 }); // all the way down the track
    frames.step(120);
    expect($('veil').style.transform).toBe('translate3d(0,-30.00%,0)');
    expect($('heroCopy').style.visibility).toBe('hidden');
    expect(Number($('cue').style.opacity)).toBe(0);
  });

  it('moves the wordmark against the scene with the pointer', () => {
    initSummit(false);
    window.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 1440, clientY: 0 }));
    frames.step(60);
    expect($('word').style.transform).toMatch(/calc\(-50% \+ 1\d\.\d\dpx\)/);
  });

  it('stops when the summit is off-screen or the tab is hidden, and starts again on return', () => {
    initSummit(false);
    const summit = observers[observers.length - 1];
    summit.fire(false);
    expect(media.pause).toHaveBeenCalledTimes(1);
    expect(frames.pending()).toBe(0);
    summit.fire(true);
    expect(media.play).toHaveBeenCalledTimes(2);
    // Earlier tests' summits still listen on the shared document, so count only that hiding pauses.
    const before = media.pause.mock.calls.length;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(media.pause.mock.calls.length).toBeGreaterThan(before);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  });

  it('takes the smaller loop on a phone', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
    setBox($('stage'), { width: 400, height: 860 });
    initSummit(false);
    expect(($('loop') as HTMLVideoElement).getAttribute('src')).toBe('/media/loop-1280.mp4');
  });
});
