// Second-phone pairing on the phone (mobile spec 3.3, 5.3, 5.8, contract 2 and 6). The source (Add another
// device) posts the mnemonic sealed under the QR's secret and six digits; the target (Scan from my other phone)
// fetches it with a throwaway key, opens it, and refuses a mnemonic whose key isn't the QR's pubkey. Each end asks the
// API through net/http apiFetch, which follows no redirect and has the whole answer within the API's 15 s: a 3xx, or
// an API that never answers, is offline, where a redirect's page was taken for the API's answer. Ports keep both ends
// testable.
import {
  LocalSigner, derivePhonePair, httpAuth, newPhonePair, openPhoneOffer, sealPhoneOffer, secretKeyFromMnemonic,
  type CryptoPort, type PhoneQr,
} from '@kefli/protocol';
import { apiFetch } from '../net/http';
import { registered, type ConnectPorts } from './connect';

export type ShowPorts = Pick<ConnectPorts, 'db' | 'now' | 'owner' | 'defaults' | 'signer' | 'fetch' | 'crypto' | 'runOutbox'> & {
  mnemonic: () => Promise<string | null>;
};

/** A fresh QR and six digits with the offer posted, or offline. */
export async function showPhonePair(p: ShowPorts): Promise<{ qr: PhoneQr; six: string } | 'offline'> {
  const [d, signer, words] = await Promise.all([p.defaults(), p.signer(), p.mnemonic()]);
  if (!signer || !words || !(await registered(p))) return 'offline';
  const { qr, six } = newPhonePair(p.crypto, p.owner, p.now());
  const { lookup, key } = derivePhonePair(qr.secret, six);
  const body = JSON.stringify({ v: 1, lookup, offer: await sealPhoneOffer(words, key, p.crypto) });
  const url = `${d.operator.api}/phone-offers`;
  try {
    const res = await apiFetch(p.fetch)(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Authorization: await httpAuth(signer, url, 'POST', body, p.crypto) } });
    return res.ok ? { qr, six } : 'offline';
  } catch {
    return 'offline';
  }
}

/** Scan from my other phone's ports. */
export type TakePorts = { fetch: typeof fetch; crypto: CryptoPort; api: string };

/** The mnemonic for a scanned QR and its six digits; wrong when no offer opens with them, offline when unreachable. */
export async function takePhonePair(p: TakePorts, qr: PhoneQr, six: string): Promise<{ mnemonic: string } | 'wrong' | 'offline'> {
  const { lookup, key } = derivePhonePair(qr.secret, six);
  const url = `${p.api}/phone-offers/${lookup}`;
  const throwaway = new LocalSigner(p.crypto.randomBytes(32));
  let res: Response;
  try {
    res = await apiFetch(p.fetch)(url, { method: 'GET', headers: { Authorization: await httpAuth(throwaway, url, 'GET', null, p.crypto) } });
  } catch {
    return 'offline';
  }
  if (res.status === 404) return 'wrong';
  if (!res.ok) return 'offline';
  const body = (await res.json().catch(() => null)) as { offer?: unknown } | null;
  const mnemonic = typeof body?.offer === 'string' ? await openPhoneOffer(body.offer, key, p.crypto) : null;
  if (!mnemonic) return 'wrong';
  // the key must be the QR's, so an offer swapped on the server can't hand over someone else's library
  const sk = await secretKeyFromMnemonic(mnemonic, p.crypto).catch(() => null);
  if (!sk || new LocalSigner(sk).pubkey() !== qr.pubkey) return 'wrong';
  return { mnemonic };
}
