// The protocol's CryptoPort on WebCrypto (packages/protocol/src/ports.ts), for the background, the options page
// and the tests. sha256 has to answer synchronously, so it is noble's; scrypt is noble's too, since WebCrypto has
// none. AES-GCM and PBKDF2 are the browser's own.
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { CryptoPort } from '../../../packages/protocol/src/ports';

const buf = (b: Uint8Array) => b.slice().buffer as ArrayBuffer;

async function aesKey(key: Uint8Array, use: KeyUsage) {
  return crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, [use]);
}

export const webCrypto: CryptoPort = {
  randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  sha256: (data) => sha256(data),
  async aesGcmEncrypt(key, nonce, plaintext) {
    return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(nonce) }, await aesKey(key, 'encrypt'), buf(plaintext)));
  },
  async aesGcmDecrypt(key, nonce, blob) {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf(nonce) }, await aesKey(key, 'decrypt'), buf(blob)));
  },
  async pbkdf2Sha512(password, salt, iterations, length) {
    const k = await crypto.subtle.importKey('raw', buf(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-512', salt: buf(salt), iterations }, k, length * 8));
  },
  scrypt: (password, salt, { N, r, p }, length) => scryptAsync(password, salt, { N, r, p, dkLen: length }),
};
