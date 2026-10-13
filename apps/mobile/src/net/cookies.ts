// The phone's one cookie jar (F27): android.webkit.CookieManager, behind expo/fetch and both WebViews. Kefli's own
// reads send and keep none (net/http.ts); the Original view runs incognito, which empties the jar as it opens, and
// empties it again as it closes, so a login made there goes no further than that visit. Through React Native's own
// networking module, which forwards to CookieManager.
import { TurboModuleRegistry, type TurboModule } from 'react-native';

interface Networking extends TurboModule {
  clearCookies(callback: (cleared: boolean) => void): void;
}

/** Empties the jar; false when there was nothing to clear or no module to ask. */
export function clearCookies(): Promise<boolean> {
  const n = TurboModuleRegistry.get<Networking>('Networking');
  return new Promise((ok) => (n ? n.clearCookies(ok) : ok(false)));
}
