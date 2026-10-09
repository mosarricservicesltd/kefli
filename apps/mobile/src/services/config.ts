// Where the operator's defaults come from, set by the build (app.config.js): the local stack in server/dev for
// KEFLI_VARIANT=local, otherwise the operator's https URL. The release build also bakes in a copy (contract 3.1).
import Constants from 'expo-constants';

type BuildConfig = { variant: 'local' | 'release'; defaultsUrl: string };
const build = (Constants.expoConfig?.extra?.kefli ?? { variant: 'release', defaultsUrl: '' }) as BuildConfig;

export const DEFAULTS_URL = build.defaultsUrl;
/** The local stack's ws:// relays and http:// servers are allowed only in the local build. */
export const LOCAL_STACK = build.variant === 'local';

export type Defaults = {
  v: 1;
  operator: { relay: string; blossom: string; api: string };
  relays: string[];
  indexer: string[];
  mirrors: string[];
};

export async function loadDefaults(): Promise<Defaults> {
  if (!DEFAULTS_URL) throw new Error('this build has no defaults URL');
  const res = await fetch(DEFAULTS_URL);
  if (!res.ok) throw new Error(`defaults: HTTP ${res.status}`);
  return (await res.json()) as Defaults;
}
