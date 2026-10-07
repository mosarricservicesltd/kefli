// Blossom for the text blob (contract 4.2, 5; mobile spec 4.3): the kind 24242 authorisation, upload to the
// operator server (BUD-02), mirroring to a public mirror (BUD-04) and deletion. Each call takes its own
// authorisation with a one-hour expiry. fetch is injected, so the same code runs on the phone and in Node.

import { base64 } from '@scure/base';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { KIND } from './constants';
import type { Signer } from './signer';

export type BlossomVerb = 'upload' | 'delete';

const SHA = /^[0-9a-f]{64}$/;
const trim = (server: string) => server.replace(/\/+$/, '');

/** The Authorization header for one call: kind 24242 with t, x and a one-hour expiration. */
export async function blossomAuth(signer: Signer, verb: BlossomVerb, sha256: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!SHA.test(sha256)) throw new Error('not a sha256');
  const event = await signer.signEvent({
    kind: KIND.blossomAuth,
    created_at: now,
    tags: [['t', verb], ['x', sha256], ['expiration', String(now + 3600)]],
    content: verb === 'upload' ? 'Upload a Shelf text blob' : 'Delete a Shelf text blob',
  });
  return `Nostr ${base64.encode(utf8ToBytes(JSON.stringify(event)))}`;
}

export type BlossomOutcome =
  | { ok: true; url: string }
  /** permanent: a 4xx other than 401 and 429, which a mirror counts as refusing (contract 4.2). */
  | { ok: false; status: number; permanent: boolean; reason: string };

function outcome(status: number, reason: string): BlossomOutcome {
  // Written 500 > status: lizard, which the code-gate uses, reads "status <" as the start of a generic.
  return { ok: false, status, permanent: status >= 400 && 500 > status && status !== 401 && status !== 429, reason };
}

async function reason(res: Response): Promise<string> {
  const header = res.headers.get('x-reason');
  if (header) return header;
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '';
  }
}

/** PUT /upload on the operator server. The descriptor's sha256 must be the blob's. */
export async function uploadBlob(server: string, blob: Uint8Array, sha256: string, signer: Signer, get: typeof fetch = fetch): Promise<BlossomOutcome> {
  const res = await get(`${trim(server)}/upload`, {
    method: 'PUT',
    headers: { Authorization: await blossomAuth(signer, 'upload', sha256), 'Content-Type': 'application/octet-stream', 'X-SHA-256': sha256 },
    body: blob as unknown as BodyInit,
  });
  if (!res.ok) return outcome(res.status, await reason(res));
  const d = (await res.json()) as { sha256?: string; url?: string };
  if (d.sha256 !== sha256) return outcome(502, 'descriptor names another blob');
  return { ok: true, url: d.url ?? `${trim(server)}/${sha256}` };
}

/** PUT /mirror on a mirror, asking it to fetch the blob from url (BUD-04). */
export async function mirrorBlob(mirror: string, url: string, sha256: string, signer: Signer, get: typeof fetch = fetch): Promise<BlossomOutcome> {
  const res = await get(`${trim(mirror)}/mirror`, {
    method: 'PUT',
    headers: { Authorization: await blossomAuth(signer, 'upload', sha256), 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  if (!res.ok) return outcome(res.status, await reason(res));
  const d = (await res.json()) as { sha256?: string; url?: string };
  if (d.sha256 !== sha256) return outcome(502, 'mirror holds another blob');
  return { ok: true, url: d.url ?? `${trim(mirror)}/${sha256}` };
}

/** DELETE /<sha256>; a 404 counts as done (mobile spec 4.3). */
export async function deleteBlob(server: string, sha256: string, signer: Signer, get: typeof fetch = fetch): Promise<BlossomOutcome> {
  const res = await get(`${trim(server)}/${sha256}`, { method: 'DELETE', headers: { Authorization: await blossomAuth(signer, 'delete', sha256) } });
  if (res.ok || res.status === 404) return { ok: true, url: `${trim(server)}/${sha256}` };
  return outcome(res.status, await reason(res));
}
