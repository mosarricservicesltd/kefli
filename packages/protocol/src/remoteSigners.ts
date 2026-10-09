// Signing with the user's own nostr app (contract 2, mobile spec 3.4): NIP-55 Android signers and NIP-46 remote
// signers reached by a pasted bunker:// link. The permissions asked for up front, the link's rules, the capability
// probe every provider passes at sign-in, both providers behind Signer, and the web bookmarks import reads (C§4.6).

import type { EventTemplate, NostrEvent, Signer, SignerProvider } from './signer';
import { isXOnlyPubkey } from './pairing';

/** The kinds Kefli signs (C§2): saves, deletions, seals, the two lists, AUTH, NIP-98, Blossom and kind 39701. */
export const SIGNED_KINDS = [30078, 5, 13, 10002, 10063, 22242, 27235, 24242, 39701] as const;

/** NIP-46 connect's perms parameter. */
export function nip46Perms(): string {
  return ['nip44_encrypt', 'nip44_decrypt', ...SIGNED_KINDS.map((k) => `sign_event:${k}`)].join(',');
}

/** NIP-55 get_public_key's permissions, the same list. */
export function nip55Permissions(): { type: string; kind?: number }[] {
  return [{ type: 'nip44_encrypt' }, { type: 'nip44_decrypt' }, ...SIGNED_KINDS.map((kind) => ({ type: 'sign_event', kind }))];
}

export type BunkerLink = { pubkey: string; relays: string[]; secret: string | null };

/**
 * A pasted bunker:// link (C§2, FD 91 (b)): the remote signer's pubkey as 64 hex characters and at least one
 * relay parameter with a wss:// URL; a secret is optional. Anything else is null, the field's error. Only the
 * link's wss:// relays are kept.
 */
export function readBunkerLink(input: string): BunkerLink | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'bunker:') return null;
  const pubkey = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pubkey) || !isXOnlyPubkey(pubkey)) return null;
  const relays = u.searchParams.getAll('relay').filter((r) => /^wss:\/\/[^\s]+$/i.test(r));
  if (!relays.length) return null;
  return { pubkey, relays: [...new Set(relays)], secret: u.searchParams.get('secret') };
}

export const PROBE_TEXT = 'kefli-probe';

/** C§2: encrypt kefli-probe to the signer's own pubkey, decrypt it, compare. A signer that fails is refused. */
export async function probeSigner(s: Signer): Promise<boolean> {
  try {
    const pk = s.pubkey();
    return (await s.nip44Decrypt(pk, await s.nip44Encrypt(pk, PROBE_TEXT))) === PROBE_TEXT;
  } catch {
    return false;
  }
}

/** A NIP-46 request unanswered for two minutes fails and changes nothing (C§2, FD 91 (b)). */
export const NIP46_TIMEOUT_MS = 120_000;

export class TimeoutError extends Error {
  constructor() {
    super('timeout');
    this.name = 'TimeoutError';
  }
}

/** What a failed request to a signer means on screen: no answer in time, or anything else read as declined. */
export function failureOf(e: unknown): 'timeout' | 'declined' {
  return e instanceof TimeoutError || (e as { code?: string } | null)?.code === 'timeout' ? 'timeout' : 'declined';
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, fail) => (t = setTimeout(() => fail(new TimeoutError()), ms)))]).finally(() => clearTimeout(t));
}

/** What a NIP-55 signer app does, through the kefli-nip55 module (mobile spec 8.4). */
export interface Nip55Port {
  signEvent(pkg: string, eventJson: string, pubkey: string): Promise<string>;
  nip44Encrypt(pkg: string, plaintext: string, peer: string, pubkey: string): Promise<string>;
  nip44Decrypt(pkg: string, ciphertext: string, peer: string, pubkey: string): Promise<string>;
  canActInBackground(pkg: string, pubkey: string): Promise<boolean>;
}

/**
 * A NIP-55 signer. A request its screen never answers (the app closed, or killed underneath) fails after the same two
 * minutes a NIP-46 request gets, so the outbox retries it rather than waiting on it for ever.
 */
export class Nip55Signer implements SignerProvider {
  readonly kind = 'nip55' as const;
  constructor(private readonly port: Nip55Port, private readonly pkg: string, private readonly pk: string, private readonly timeoutMs = NIP46_TIMEOUT_MS) {}

  pubkey(): string {
    return this.pk;
  }

  get package(): string {
    return this.pkg;
  }

  async capabilities() {
    return { nip44: true };
  }

  canActInBackground(): Promise<boolean> {
    return this.port.canActInBackground(this.pkg, this.pk);
  }

  async signEvent(e: EventTemplate): Promise<NostrEvent> {
    const signed = JSON.parse(await withTimeout(this.port.signEvent(this.pkg, JSON.stringify({ ...e, pubkey: this.pk }), this.pk), this.timeoutMs)) as NostrEvent;
    if (signed.pubkey !== this.pk) throw new Error('the signer signed with another key');
    return signed;
  }

  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return withTimeout(this.port.nip44Encrypt(this.pkg, plaintext, peer, this.pk), this.timeoutMs);
  }

  nip44Decrypt(peer: string, ciphertext: string): Promise<string> {
    return withTimeout(this.port.nip44Decrypt(this.pkg, ciphertext, peer, this.pk), this.timeoutMs);
  }
}

/** The calls a connected NIP-46 session answers (nostr-tools' BunkerSigner, composed: its constructor is private). */
export interface BunkerLike {
  signEvent(e: EventTemplate): Promise<NostrEvent>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  getPublicKey(): Promise<string>;
}

export class Nip46Signer implements SignerProvider {
  readonly kind = 'nip46' as const;
  constructor(private readonly bunker: BunkerLike, private readonly pk: string, private readonly timeoutMs = NIP46_TIMEOUT_MS) {}

  pubkey(): string {
    return this.pk;
  }

  async capabilities() {
    return { nip44: true };
  }

  /** A live bunker can answer in the background. */
  async canActInBackground() {
    return true;
  }

  async signEvent(e: EventTemplate): Promise<NostrEvent> {
    const signed = await withTimeout(this.bunker.signEvent(e), this.timeoutMs);
    if (signed.pubkey !== this.pk) throw new Error('the signer signed with another key');
    return signed;
  }

  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return withTimeout(this.bunker.nip44Encrypt(peer, plaintext), this.timeoutMs);
  }

  nip44Decrypt(peer: string, ciphertext: string): Promise<string> {
    return withTimeout(this.bunker.nip44Decrypt(peer, ciphertext), this.timeoutMs);
  }
}

/**
 * The web links an import brings in (C§4.6, FD 82): kind 39701 bookmarks (d is the URL without its scheme, imported
 * as https://<d>) and the r tags of the user's kind 10003 and every kind 30003 set. Private entries in content, e and
 * a tags aren't read. Only the user's own events count; each link once, in the order found.
 */
export function bookmarkLinks(events: NostrEvent[], pubkey: string): string[] {
  const out: string[] = [];
  const add = (u: string) => {
    try {
      const url = new URL(u);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !out.includes(url.href)) out.push(url.href);
    } catch {
      // not a link
    }
  };
  for (const e of events) {
    if (e.pubkey !== pubkey) continue;
    if (e.kind === 39701) {
      const d = e.tags.find((t) => t[0] === 'd')?.[1];
      if (d) add(`https://${d.replace(/^https?:\/\//, '')}`);
    } else if (e.kind === 10003 || e.kind === 30003) {
      for (const t of e.tags) if (t[0] === 'r' && t[1]) add(t[1]);
    }
  }
  return out;
}
