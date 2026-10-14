// Contract section 9's protocol fixtures through the extension's own CryptoPort (WebCrypto, src/crypto.ts), for what
// the extension makes and opens: the inbox blob (made as the text blob is), the typed-code offer and its seal, and the
// key a mnemonic gives. The protocol package checks the same fixtures on Node's crypto; these must agree with it.
import { base64 } from '@scure/base';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LocalSigner, decryptText, derivePairCode, openOffer, sealOffer, secretKeyFromMnemonic, textHash, type CryptoPort } from '../../../packages/protocol/src';
import { webCrypto } from '../src/crypto';

const dir = join(__dirname, '../../../shared/fixtures/protocol');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (name: string): any => JSON.parse(readFileSync(join(dir, name), 'utf8'));
/** WebCrypto whose randomness is the bytes given, so a seal can be made again with the fixture's IV. */
const replaying = (bytes: Uint8Array): CryptoPort => ({ ...webCrypto, randomBytes: (n) => bytes.slice(0, n) });

test('the text blob is encrypted exactly, and decrypts', async () => {
  const f = load('text.json');
  expect(textHash(f.normalised, webCrypto)).toBe(f.text_hash);
  const blob = await webCrypto.aesGcmEncrypt(base64.decode(f.key), base64.decode(f.nonce), utf8ToBytes(f.normalised));
  expect(base64.encode(blob)).toBe(f.blob);
  expect(bytesToHex(webCrypto.sha256(blob))).toBe(f.sha256);
  expect(await decryptText(base64.decode(f.blob), f, webCrypto)).toBe(f.normalised);
});

test('the inbox blob a save request names is exact, and decrypts to its HTML', async () => {
  const b = load('save-request.json').inbox_blob;
  const blob = await webCrypto.aesGcmEncrypt(base64.decode(b.key), base64.decode(b.nonce), utf8ToBytes(b.html));
  expect(base64.encode(blob)).toBe(b.blob);
  expect(bytesToHex(webCrypto.sha256(blob))).toBe(b.sha256);
  expect(await decryptText(blob, b, webCrypto)).toBe(b.html);
});

// scrypt at N 16,384 in pure JS: a fifth of a second alone, and over four on a loaded machine under coverage
test('the typed code gives its lookup and key, and the offer seals and opens exactly', async () => {
  const f = load('pair-offer.json');
  const { lookup, key } = await derivePairCode(f.code, webCrypto);
  expect(lookup).toBe(f.lookup);
  expect(bytesToHex(key)).toBe(f.key);
  expect(await openOffer(f.sealed, key, webCrypto)).toEqual(f.offer);
  expect(await sealOffer(f.offer, key, replaying(base64.decode(f.sealed)))).toBe(f.sealed);
}, 60_000);

test("the mnemonic gives its key at NIP-06's path", async () => {
  const f = load('keys.json');
  const sk = await secretKeyFromMnemonic(f.mnemonic, webCrypto);
  expect(bytesToHex(sk)).toBe(f.secret_key);
  expect(new LocalSigner(sk).pubkey()).toBe(f.pubkey);
});
