import './styles/base.css';
import './styles/landing.css';
import { initNav } from './nav';
import { drawEcho } from './scene/echo';
import { initDusk } from './scene/dusk';
import { initSummit } from './scene/summit';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
initNav(document.getElementById('hero'));
drawEcho(document.getElementById('echo'));
initSummit(reducedMotion);
initDusk(reducedMotion);
