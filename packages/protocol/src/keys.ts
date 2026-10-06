// The recovery code and the key (contract section 2): BIP-39 English, 128 bits of entropy, the seed by
// PBKDF2-HMAC-SHA512 with 2,048 rounds and an empty passphrase, NIP-06 account 0 at m/44'/1237'/0'/0/0.
// PBKDF2 runs through CryptoPort (OpenSSL on the phone), since noble's would be slow on Hermes.

import { HDKey } from '@scure/bip32';
import { entropyToMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { CryptoPort } from './ports';

export const NIP06_PATH = "m/44'/1237'/0'/0/0";

/** Twelve words from 128 random bits. */
export function newMnemonic(crypto: CryptoPort): string {
  return entropyToMnemonic(crypto.randomBytes(16), wordlist);
}

/** Words as typed: lower case, single spaces. Returns null when they aren't a valid BIP-39 English mnemonic. */
export function cleanMnemonic(input: string): string | null {
  const words = input.trim().toLowerCase().split(/\s+/).join(' ');
  return validateMnemonic(words, wordlist) ? words : null;
}

/** The 32-byte secret key for a mnemonic. The English list is ASCII, so NFKD changes nothing and isn't applied. */
export async function secretKeyFromMnemonic(mnemonic: string, crypto: CryptoPort): Promise<Uint8Array> {
  const words = cleanMnemonic(mnemonic);
  if (!words) throw new Error('not a valid recovery code');
  const seed = await crypto.pbkdf2Sha512(utf8ToBytes(words), utf8ToBytes('mnemonic'), 2048, 64);
  const key = HDKey.fromMasterSeed(seed).derive(NIP06_PATH).privateKey;
  seed.fill(0);
  if (!key) throw new Error('derivation gave no key');
  return key;
}
