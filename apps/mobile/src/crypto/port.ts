// CryptoPort on react-native-quick-crypto (OpenSSL), the phone's implementation (mobile spec 2.6).
import QC from 'react-native-quick-crypto';
import type { CryptoPort } from '@kefli/protocol';

type Bytes = { buffer: ArrayBufferLike; byteOffset: number; byteLength: number };
const u8 = (b: Bytes) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice();
const buf = (b: Uint8Array) => QC.Buffer.from(b);

export const phoneCrypto: CryptoPort = {
  randomBytes: (n) => u8(QC.randomBytes(n)),
  sha256: (data) => u8(QC.createHash('sha256').update(buf(data)).digest()),
  async aesGcmEncrypt(key, nonce, plaintext) {
    const c = QC.createCipheriv('aes-256-gcm', buf(key), buf(nonce));
    const body = QC.Buffer.concat([c.update(buf(plaintext)), c.final()]);
    return u8(QC.Buffer.concat([body, c.getAuthTag()]));
  },
  async aesGcmDecrypt(key, nonce, blob) {
    if (blob.length < 16) throw new Error('blob shorter than its tag');
    const d = QC.createDecipheriv('aes-256-gcm', buf(key), buf(nonce));
    d.setAuthTag(buf(blob.subarray(blob.length - 16)));
    return u8(QC.Buffer.concat([d.update(buf(blob.subarray(0, blob.length - 16))), d.final()]));
  },
  pbkdf2Sha512: (password, salt, iterations, length) =>
    new Promise((ok, fail) => QC.pbkdf2(buf(password), buf(salt), iterations, length, 'sha512', (e, k) => (e || !k ? fail(e) : ok(u8(k))))),
  scrypt: (password, salt, { N, r, p }, length) =>
    new Promise((ok, fail) => QC.scrypt(buf(password), buf(salt), length, { N, r, p, maxmem: 256 * N * r }, (e, k) => (e || !k ? fail(e) : ok(u8(k))))),
};
