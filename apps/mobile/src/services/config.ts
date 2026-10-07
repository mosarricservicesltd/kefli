// Where the operator's defaults come from. Week 1 runs against the local stack in server/dev, reached
// over USB through adb reverse; the release build bakes in the real operator's copy (contract 3.1).
export const DEFAULTS_URL = 'http://localhost:8447/defaults.json';

export type Defaults = {
  v: 1;
  operator: { relay: string; blossom: string; api: string };
  relays: string[];
  indexer: string[];
  mirrors: string[];
};

export async function loadDefaults(): Promise<Defaults> {
  const res = await fetch(DEFAULTS_URL);
  if (!res.ok) throw new Error(`defaults: HTTP ${res.status}`);
  return (await res.json()) as Defaults;
}
