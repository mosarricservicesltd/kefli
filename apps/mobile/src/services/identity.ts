// The identity the app signs with (mobile spec 3.1, 3.2). Week 1's slice: a local key, made from a new
// recovery code the first time one is needed and kept in the key file. Block Store and the resolver come next.
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { LocalSigner, newMnemonic, secretKeyFromMnemonic } from '@shelf/protocol';
import { ShelfKeystore } from '../../modules/shelf-keystore/src';
import { phoneCrypto } from '../crypto/port';
import { nativeSecp } from '../crypto/secp';

let signer: LocalSigner | null = null;

export async function currentSigner(): Promise<LocalSigner | null> {
  if (signer) return signer;
  const local = (await ShelfKeystore.read())?.identities.find((i) => i.provider === 'local' && i.sk);
  if (!local?.sk) return null;
  signer = new LocalSigner(hexToBytes(local.sk), nativeSecp);
  return signer;
}

/** The current signer, or a new local identity if there is none (an early share, contract 2). */
export async function ensureSigner(): Promise<LocalSigner> {
  const existing = await currentSigner();
  if (existing) return existing;
  const mnemonic = newMnemonic(phoneCrypto);
  const sk = await secretKeyFromMnemonic(mnemonic, phoneCrypto);
  const s = new LocalSigner(sk.slice(), nativeSecp);
  await ShelfKeystore.write({ v: 1, identities: [{ pubkey: s.pubkey(), provider: 'local', sk: bytesToHex(sk), mnemonic, origin: 'early_share' }] });
  sk.fill(0);
  signer = s;
  return s;
}
