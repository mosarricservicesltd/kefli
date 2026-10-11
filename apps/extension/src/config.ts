// Set by build.mjs per flavour and browser (extension spec 11).
declare const KEFLI_DEFAULTS_URL: string;
declare const KEFLI_FLAVOUR: 'dev' | 'beta' | 'store';
declare const KEFLI_BROWSER: 'chrome' | 'firefox';

export const DEFAULTS_URL = KEFLI_DEFAULTS_URL;
export const FLAVOUR = KEFLI_FLAVOUR;
export const BROWSER = KEFLI_BROWSER;
