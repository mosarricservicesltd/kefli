// Every link from outside the app passes here first (mobile spec 5.1, 7.1); only the Reader's links get through.
import { LOCAL_STACK } from '../services/config';
import { store } from '../services/store';
import { appState } from '../services/app';
import { linkRoute } from '../nav/links';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    const owner = appState()?.owner ?? store().get<{ pubkey: string }>("SELECT pubkey FROM identities WHERE role = 'active'")?.pubkey;
    const has = (hash: string) => !!owner && !!store().get('SELECT 1 FROM items WHERE owner = ? AND hash = ? AND pending_delete_at IS NULL', owner, hash);
    return linkRoute(path, has, LOCAL_STACK);
  } catch {
    return '/';
  }
}
