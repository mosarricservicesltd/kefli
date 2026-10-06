// The article text (contract section 4.2): the normalised Markdown, its text_hash, and the encrypted blob.

import { base64 } from '@scure/base';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { CryptoPort } from './ports';
import type { ItemText } from './item';

/**
 * The normalised form text_hash is taken over: NFC, CRLF to LF, trailing whitespace removed from every
 * line, runs of three or more newlines collapsed to two, exactly one trailing newline. On the phone this
 * runs in the parser bundle (Blink), never on Hermes, which hashes the string the bundle returns.
 * RULED: "whitespace" is space and tab, so the rule doesn't depend on an engine's Unicode tables.
 */
export function normaliseMarkdown(markdown: string): string {
  return markdown
    .normalize('NFC')
    .replace(/\r\n/g, '\n')
    // Lines split on LF only, so a lone CR, U+2028 and U+2029 are not line ends here, as in a port that splits on \n.
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n');
}

/** Lowercase hex SHA-256 of the normalised Markdown as UTF-8. */
export function textHash(normalised: string, crypto: CryptoPort): string {
  return bytesToHex(crypto.sha256(utf8ToBytes(normalised)));
}

export interface EncryptedText {
  /** Ciphertext followed by the 16-byte tag, to upload to Blossom. */
  blob: Uint8Array;
  /** The item's text field, without servers, which the outbox fills once the blob is uploaded and mirrored. */
  text: Omit<ItemText, 'servers'>;
}

/** Encrypt normalised Markdown under a fresh key and nonce: AES-256-GCM, no additional data. */
export async function encryptText(normalised: string, crypto: CryptoPort): Promise<EncryptedText> {
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const blob = await crypto.aesGcmEncrypt(key, nonce, utf8ToBytes(normalised));
  return {
    blob,
    text: { sha256: bytesToHex(crypto.sha256(blob)), key: base64.encode(key), nonce: base64.encode(nonce) },
  };
}

/** Decrypt a fetched blob, checking first that it is the blob the item names. */
export async function decryptText(blob: Uint8Array, text: Omit<ItemText, 'servers'>, crypto: CryptoPort): Promise<string> {
  if (bytesToHex(crypto.sha256(blob)) !== text.sha256) throw new Error('blob does not match its sha256');
  const key = base64.decode(text.key);
  const nonce = base64.decode(text.nonce);
  if (key.length !== 32 || nonce.length !== 12) throw new Error('bad key or nonce length');
  return new TextDecoder('utf-8', { fatal: true }).decode(await crypto.aesGcmDecrypt(key, nonce, blob));
}
