// Blossom for the text blob (contract 4.2, 5; mobile spec 4.3): the kind 24242 authorisation, upload to the
// operator server (BUD-02), mirroring to a public mirror (BUD-04) and deletion. Each call takes its own
// authorisation with a one-hour expiry. fetch is injected, so the same code runs on the phone and in Node.

import { base64 } from '@scure/base';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { KIND } from './constants';
import { withoutTrailingSlashes } from './lists';
import type { Signer } from './signer';

export type BlossomVerb = 'upload' | 'delete';

const SHA = /^[0-9a-f]{64}$/;
/** A server's address without the slashes at its end, which a path then joins with one. */
const trim = withoutTrailingSlashes;

/** The Authorization header for one call: kind 24242 with t, x and a one-hour expiration. */
export async function blossomAuth(signer: Signer, verb: BlossomVerb, sha256: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  if (!SHA.test(sha256)) throw new Error('not a sha256');
  const event = await signer.signEvent({
    kind: KIND.blossomAuth,
    created_at: now,
    tags: [['t', verb], ['x', sha256], ['expiration', String(now + 3600)]],
    content: verb === 'upload' ? 'Upload a Kefli text blob' : 'Delete a Kefli text blob',
  });
  return `Nostr ${base64.encode(utf8ToBytes(JSON.stringify(event)))}`;
}

/**
 * A library's fair use in bytes (contract 5, 6; v1.12): its quota and what its blobs take of it, the most its uploads
 * may add in any 24 hours and what they added in the last 24. A 413 quota or daily carries them, as GET /account does.
 */
export type AccountFigures = { quota: number; used: number; daily: number; today: number };

const FIGURES = ['quota', 'used', 'daily', 'today'] as const;

/** The figures in a parsed body, when all four are whole, non-negative numbers of bytes; otherwise null. */
export function readFigures(body: unknown): AccountFigures | null {
  if (!body || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;
  if (!FIGURES.every((k) => Number.isSafeInteger(o[k]) && (o[k] as number) >= 0)) return null;
  return { quota: o.quota as number, used: o.used as number, daily: o.daily as number, today: o.today as number };
}

export type BlossomOutcome =
  | { ok: true; url: string }
  /**
   * permanent: a 4xx other than 401 and 429, which a mirror counts as refusing (contract 4.2). reason: X-Reason, else the
   * body's error (BUD-01), so quota, daily or too_large from the operator (contract 5). figures: a 413's, when it has them.
   */
  | { ok: false; status: number; permanent: boolean; reason: string; figures?: AccountFigures };

/** A call the server refused. */
type Refused = Extract<BlossomOutcome, { ok: false }>;

function outcome(status: number, reason: string): Refused {
  // Written 500 > status: lizard, which the code-gate uses, reads "status <" as the start of a generic.
  return { ok: false, status, permanent: status >= 400 && 500 > status && status !== 401 && status !== 429, reason };
}

function parsed(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A refusal read whole: its reason from X-Reason or the body's error, and the body's figures if it carries them. */
async function refusal(res: Response): Promise<Refused> {
  const text = await res.text().catch(() => '');
  const body = parsed(text);
  const error = typeof body?.error === 'string' ? body.error : null;
  const figures = readFigures(body);
  const out = outcome(res.status, res.headers.get('x-reason') || error || text.slice(0, 200));
  return figures ? { ...out, figures } : out;
}

/** PUT /upload on the operator server. The descriptor's sha256 must be the blob's. */
export async function uploadBlob(server: string, blob: Uint8Array, sha256: string, signer: Signer, get: typeof fetch = fetch): Promise<BlossomOutcome> {
  const res = await get(`${trim(server)}/upload`, {
    method: 'PUT',
    headers: { Authorization: await blossomAuth(signer, 'upload', sha256), 'Content-Type': 'application/octet-stream', 'X-SHA-256': sha256 },
    body: blob as unknown as BodyInit,
  });
  if (!res.ok) return refusal(res);
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
  if (!res.ok) return refusal(res);
  const d = (await res.json()) as { sha256?: string; url?: string };
  if (d.sha256 !== sha256) return outcome(502, 'mirror holds another blob');
  return { ok: true, url: d.url ?? `${trim(mirror)}/${sha256}` };
}

/**
 * A deletion's outcome: done, with the status the server answered, or refused as any call is. A 404 is done too, the
 * server holding no such blob, but it freed nothing there, so a caller that counts room (C§5) counts it only for a 2xx.
 */
export type DeleteOutcome = { ok: true; url: string; status: number } | Refused;

/** DELETE /<sha256>; a 404 counts as done (mobile spec 4.3), its status kept with it. */
export async function deleteBlob(server: string, sha256: string, signer: Signer, get: typeof fetch = fetch): Promise<DeleteOutcome> {
  const res = await get(`${trim(server)}/${sha256}`, { method: 'DELETE', headers: { Authorization: await blossomAuth(signer, 'delete', sha256) } });
  if (res.ok || res.status === 404) return { ok: true, url: `${trim(server)}/${sha256}`, status: res.status };
  return refusal(res);
}
