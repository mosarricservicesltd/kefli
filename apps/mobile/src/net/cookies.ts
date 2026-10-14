// The phone's one cookie jar (F27): android.webkit.CookieManager, behind expo/fetch and both WebViews. Kefli's own
// reads send and keep none (net/http.ts); the Original view runs incognito, which empties the jar as it opens, and
// empties it again as it closes, so a login made there goes no further than that visit. The render WebView empties
// the jar after each render, except while an Original view is open, which holds it until it closes (holdJar), so a
// render during a sync doesn't sign the person out mid-visit. Clearing goes through React Native's own networking
// module, which forwards to CookieManager.
import { TurboModuleRegistry, type TurboModule } from 'react-native';
import { KefliParser } from '../../modules/kefli-parser/src';

interface Networking extends TurboModule {
  clearCookies(callback: (cleared: boolean) => void): void;
}

/** For an Original view: holds the jar while it is open; the returned release empties it as the view closes. */
export function holdJar(): () => void {
  KefliParser.holdJar(true);
  return () => {
    KefliParser.holdJar(false);
    void clearCookies();
  };
}

/** Empties the jar; false when there was nothing to clear or no module to ask. */
export function clearCookies(): Promise<boolean> {
  const n = TurboModuleRegistry.get<Networking>('Networking');
  return new Promise((ok) => (n ? n.clearCookies(ok) : ok(false)));
}
