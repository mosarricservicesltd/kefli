// NIP-98 HTTP auth for the operator API (contract 6).

import { base64 } from '@scure/base';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { KIND } from './constants';
import type { CryptoPort } from './ports';
import type { Signer } from './signer';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** The Authorization header value: Nostr <base64 of the signed kind 27235>. body is the exact bytes sent. */
export async function httpAuth(
  signer: Signer,
  url: string,
  method: HttpMethod,
  body: Uint8Array | string | null,
  crypto: CryptoPort,
  now = Math.floor(Date.now() / 1000),
): Promise<string> {
  const tags = [['u', url], ['method', method]];
  if (method !== 'GET') {
    const bytes = body === null ? new Uint8Array() : typeof body === 'string' ? utf8ToBytes(body) : body;
    tags.push(['payload', bytesToHex(crypto.sha256(bytes))]);
  }
  const event = await signer.signEvent({ kind: KIND.httpAuth, created_at: now, tags, content: '' });
  return `Nostr ${base64.encode(utf8ToBytes(JSON.stringify(event)))}`;
}
