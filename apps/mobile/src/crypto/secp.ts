// The phone's SecpPort: libsecp256k1 through the shelf-secp module (mobile spec 8).
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { SecpPort } from '@shelf/protocol';
import ShelfSecp from '../../modules/shelf-secp/src';

export const nativeSecp: SecpPort = {
  publicKey: (sk) => ShelfSecp.publicKey(bytesToHex(sk)),
  sign: (hash, sk, aux) => ShelfSecp.sign(hash, bytesToHex(sk), aux ?? bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)))),
  verify: (signature, hash, publicKey) => ShelfSecp.verify(signature, hash, publicKey),
  sharedX: (sk, publicKey) => hexToBytes(ShelfSecp.sharedX(bytesToHex(sk), publicKey)),
};
