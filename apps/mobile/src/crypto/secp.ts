// The phone's SecpPort: libsecp256k1 through the kefli-secp module (mobile spec 8).
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { SecpPort } from '@kefli/protocol';
import KefliSecp from '../../modules/kefli-secp/src';

export const nativeSecp: SecpPort = {
  publicKey: (sk) => KefliSecp.publicKey(bytesToHex(sk)),
  sign: (hash, sk, aux) => KefliSecp.sign(hash, bytesToHex(sk), aux ?? bytesToHex(globalThis.crypto.getRandomValues(new Uint8Array(32)))),
  verify: (signature, hash, publicKey) => KefliSecp.verify(signature, hash, publicKey),
  sharedX: (sk, publicKey) => hexToBytes(KefliSecp.sharedX(bytesToHex(sk), publicKey)),
};
