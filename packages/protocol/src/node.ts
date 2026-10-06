// CryptoPort on node:crypto, for tests and Node tools such as npm run decrypt. Never import this from the app.

import { createCipheriv, createDecipheriv, createHash, pbkdf2, randomBytes, scrypt } from 'node:crypto';
import type { CryptoPort } from './ports';

const u8 = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

export const nodeCrypto: CryptoPort = {
  randomBytes: (n) => u8(randomBytes(n)),
  sha256: (data) => u8(createHash('sha256').update(data).digest()),
  async aesGcmEncrypt(key, nonce, plaintext) {
    const c = createCipheriv('aes-256-gcm', key, nonce);
    return u8(Buffer.concat([c.update(plaintext), c.final(), c.getAuthTag()]));
  },
  async aesGcmDecrypt(key, nonce, blob) {
    if (blob.length < 16) throw new Error('blob shorter than its tag');
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(blob.subarray(blob.length - 16));
    return u8(Buffer.concat([d.update(blob.subarray(0, blob.length - 16)), d.final()]));
  },
  pbkdf2Sha512: (password, salt, iterations, length) =>
    new Promise((ok, fail) => pbkdf2(password, salt, iterations, length, 'sha512', (e, k) => (e ? fail(e) : ok(u8(k))))),
  scrypt: (password, salt, { N, r, p }, length) =>
    new Promise((ok, fail) =>
      scrypt(password, salt, length, { N, r, p, maxmem: 256 * N * r }, (e, k) => (e ? fail(e) : ok(u8(k))))),
};
