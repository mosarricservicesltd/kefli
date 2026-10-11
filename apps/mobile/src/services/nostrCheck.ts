// Saving without asking on the phone (FD 104): the check through the signer app's resolver, and asking it, through
// its screen, for what's missing. Only a signer app on the phone is checked: a sign-in link's requests would prompt
// on another device.
import { Nip55Signer, type BackgroundNeed, type SignerProvider } from '@kefli/protocol';
import { checkDue, recordCheck } from '../data/nostrCheck';
import { currentSigner } from './identity';
import { store } from './store';

const now = () => Math.floor(Date.now() / 1000);

/** What the signer won't do without asking, recorded; null for a sign-in link, which isn't checked. */
export async function checkSigner(signer: SignerProvider): Promise<BackgroundNeed[] | null> {
  if (!(signer instanceof Nip55Signer)) return null;
  const missing = await signer.missingInBackground();
  recordCheck(store(), now(), missing);
  return missing;
}

/**
 * Asks for each missing permission in turn (step(n) before the nth), then checks again. Returns what is still
 * missing; a refusal in the signer throws.
 */
export async function approveMissing(signer: SignerProvider, missing: BackgroundNeed[], step: (n: number) => void): Promise<BackgroundNeed[]> {
  if (!(signer instanceof Nip55Signer)) return [];
  await signer.approve(missing, step);
  return (await checkSigner(signer)) ?? [];
}

/** At launch and on returning to the front: an earlier sign-in is checked at most once a day, out of sight. */
export async function dailyCheck(): Promise<void> {
  const signer = await currentSigner();
  if (!signer || !checkDue(store(), now())) return;
  await checkSigner(signer);
}
