// Use my nostr app instead (mobile spec 5.8, contract 4.8, FD 13, FD 26, FD 76, FD 91 (c) (i)): the phone's own key S
// moves the library to the user's nostr app T. T joins the key file and the database beside S as the move's target,
// with its lists settled under Keep backup copies, and the move job runs. S stays the phone's identity, and its
// recovery code keeps working, until the move's last step; a move a save from a newer Kefli stops leaves S as it was.
import type { SignerProvider } from '@kefli/protocol';
import { KefliKeystore } from '../../modules/kefli-keystore/src';
import { queueSwitch, retireLocal } from '../data/move';
import type { Defaults } from './config';
import { currentSigner } from './identity';
import type { How } from './nostrAsk';
import type { UserLists } from './nostrSignIn';
import { store } from './store';

const now = () => Math.floor(Date.now() / 1000);

async function sourceKey(): Promise<string> {
  const s = await currentSigner();
  if (!s) throw new Error('no identity to move from');
  return s.pubkey();
}

/** T joins the key file after S, so S is still the phone's identity if the app stops part way; the move resumes. */
async function addTarget(to: string, how: How): Promise<void> {
  const r = await KefliKeystore.read();
  const rest = (r?.identities ?? []).filter((i) => i.pubkey !== to);
  await KefliKeystore.write({ v: 1, identities: [...rest, { pubkey: to, origin: 'nostr_signin', ...how }] });
}

/** T beside S, and the move queued. Returns S's pubkey. */
export async function beginSwitch(t: SignerProvider, how: How, lists: UserLists, keep: boolean, d: Defaults): Promise<string> {
  const from = await sourceKey();
  await addTarget(t.pubkey(), how);
  queueSwitch(store(), now(), from, t.pubkey(), how.provider, lists, keep, d);
  return from;
}

/** A move stopped by a save from a newer Kefli: the job and T leave the phone; S and every save stay (FD 91 (i)). */
export async function abandonSwitch(from: string, to: string): Promise<void> {
  const db = store();
  db.run('DELETE FROM jobs WHERE id = ?', `move:${from}`);
  retireLocal(db, to, null);
  await KefliKeystore.wipe(to).catch(() => undefined);
}
