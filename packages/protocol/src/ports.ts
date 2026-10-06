// The crypto the protocol needs from its platform (mobile spec 2.1, 2.6). On the phone it is
// react-native-quick-crypto (OpenSSL); in the extension WebCrypto; in Node tests node:crypto
// (@shelf/protocol/node). Schnorr, ECDH and NIP-44 are not here: they run in noble through nostr-tools.

export interface CryptoPort {
  randomBytes(length: number): Uint8Array;
  sha256(data: Uint8Array): Uint8Array;
  /** AES-256-GCM with no additional data; returns the ciphertext followed by the 16-byte tag. */
  aesGcmEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Promise<Uint8Array>;
  /** The reverse of aesGcmEncrypt; rejects when the tag doesn't verify. */
  aesGcmDecrypt(key: Uint8Array, nonce: Uint8Array, blob: Uint8Array): Promise<Uint8Array>;
  pbkdf2Sha512(password: Uint8Array, salt: Uint8Array, iterations: number, length: number): Promise<Uint8Array>;
  scrypt(password: Uint8Array, salt: Uint8Array, cost: { N: number; r: number; p: number }, length: number): Promise<Uint8Array>;
}
