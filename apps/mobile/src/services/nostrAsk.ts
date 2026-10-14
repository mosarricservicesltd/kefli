// Asking the user's nostr app for their key (mobile spec 5.3, 8.4): the phone's signer app through NIP-55 (Android's
// chooser when there are several), or a pasted bunker:// link through NIP-46. Sign-in and switching both use it.
import { bytesToHex } from '@noble/hashes/utils.js';
import { NIP46_TIMEOUT_MS, Nip55Signer, failureOf, type BunkerLink, type SignerProvider } from '@kefli/protocol';
import { KefliNip55, nip55Port } from '../../modules/kefli-nip55/src';
import { phoneCrypto } from '../crypto/port';
import { nativeSecp } from '../crypto/secp';
import { connectBunker } from './nip46';

export type How = { provider: 'nip55'; package: string } | { provider: 'nip46'; bunker: string; client: string };
export type Asked = { signer: SignerProvider; how: How };

/** The signer app's answer, or null when the phone has none. Throws when declined or unanswered. asking: the app is being opened. */
export async function askApp(asking: () => void): Promise<Asked | null> {
  const signers = await KefliNip55.listSigners().catch(() => []);
  if (!signers.length) return null;
  asking();
  const r = await KefliNip55.getPublicKey(signers.length === 1 ? signers[0].package : null);
  return { signer: new Nip55Signer(nip55Port, r.package, r.pubkey, NIP46_TIMEOUT_MS, true, nativeSecp.verify), how: { provider: 'nip55', package: r.package } };
}

/** A remote signer reached by a checked bunker:// link, with a new client key. */
export async function askLink(parsed: BunkerLink, link: string): Promise<Asked> {
  const client = bytesToHex(phoneCrypto.randomBytes(32));
  const { signer } = await connectBunker(parsed, client);
  return { signer, how: { provider: 'nip46', bunker: link.trim(), client } };
}

/** What a failed request means on screen (C§2, FD 91 (b)). */
export const whyFailed = failureOf;
