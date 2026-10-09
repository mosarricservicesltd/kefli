// The nav: marks the current page, and on the landing page turns solid once you're through the cloud.

export function initNav(hero: HTMLElement | null = null): void {
  const nav = document.getElementById('nav');
  if (!nav) return;
  const here = location.pathname.replace(/index\.html$/, '');
  for (const a of nav.querySelectorAll<HTMLAnchorElement>('ul a')) {
    // A link to a section of a page (/#how) isn't a page of its own.
    if (!a.hash && a.pathname === here) a.setAttribute('aria-current', 'page');
  }
  if (!hero) return;
  const update = () => nav.classList.toggle('solid', window.scrollY > hero.offsetTop + hero.offsetHeight - 80);
  window.addEventListener('scroll', update, { passive: true });
  update();
}
