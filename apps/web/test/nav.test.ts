/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://kefli.app/privacy/"}
 */
import { initNav } from '../src/nav';
import { setBox } from './dom';

function mount(): void {
  document.body.innerHTML = `
    <header class="nav" id="nav"><ul>
      <li><a href="/#how">How it works</a></li>
      <li><a href="/extension/">Extension</a></li>
      <li><a href="/privacy/">Privacy</a></li>
    </ul></header>
    <section id="hero"></section>`;
}

describe('initNav', () => {
  beforeEach(mount);

  it('marks the page you are on, and never a link to a section', () => {
    initNav();
    const current = [...document.querySelectorAll('[aria-current="page"]')].map((a) => a.textContent);
    expect(current).toEqual(['Privacy']);
  });

  it('does nothing without a nav', () => {
    document.body.innerHTML = '';
    expect(() => initNav()).not.toThrow();
  });

  it('stays clear over the summit and turns solid once you are under it', () => {
    const hero = document.getElementById('hero')!;
    setBox(hero, { offsetTop: 0, height: 2000 });
    const nav = document.getElementById('nav')!;
    Object.defineProperty(window, 'scrollY', { configurable: true, writable: true, value: 0 });
    initNav(hero);
    expect(nav.classList.contains('solid')).toBe(false);
    (window as unknown as { scrollY: number }).scrollY = 1950;
    window.dispatchEvent(new Event('scroll'));
    expect(nav.classList.contains('solid')).toBe(true);
  });

  it('leaves the nav alone on pages without a summit', () => {
    initNav(null);
    window.dispatchEvent(new Event('scroll'));
    expect(document.getElementById('nav')!.classList.contains('solid')).toBe(false);
  });
});
