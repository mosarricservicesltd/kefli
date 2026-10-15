// Signing with the user's own nostr app (contract 2, mobile spec 3.4): NIP-55 Android signers and NIP-46 remote
// signers reached by a pasted bunker:// link. The permissions asked for up front, the link's rules, the capability
// probe every provider passes at sign-in, both providers behind Signer, and the web bookmarks import reads (C§4.6).

import { signedAsAsked, type EventTemplate, type NostrEvent, type Signer, type SignerProvider } from './signer';
import { isXOnlyPubkey } from './pairing';
import { nobleSecp } from './secp';
import { itemHash, withoutUserInfo } from './normalise';

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

/**
 * Whether an error is the signer not answering (no answer in time, refused out of sight, declined, gone) rather than
 * a result: a request that failed this way may succeed later, so what depends on it waits (FD 104, F3).
 */
export function isSignerFailure(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return e instanceof TimeoutError || (typeof code === 'string' && ['timeout', 'background', 'rejected', 'unavailable', 'not_installed'].includes(code));
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, fail) => (t = setTimeout(() => fail(new TimeoutError()), ms)))]).finally(() => clearTimeout(t));
}

/**
 * What a NIP-55 signer app does, through the kefli-nip55 module (mobile spec 8.4). screen: whether a request its
 * resolver declines may open the signer's own screen, or is refused as 'background' to wait (FD 104).
 */
export interface Nip55Port {
  signEvent(pkg: string, eventJson: string, pubkey: string, screen: boolean): Promise<string>;
  nip44Encrypt(pkg: string, plaintext: string, peer: string, pubkey: string, screen: boolean): Promise<string>;
  nip44Decrypt(pkg: string, ciphertext: string, peer: string, pubkey: string, screen: boolean): Promise<string>;
  /** Whether the signer's resolver alone encrypts to the user's own key and decrypts that again (both are needed out of sight). */
  canActInBackground(pkg: string, pubkey: string): Promise<boolean>;
  /** Whether the signer signs this event through its resolver alone, never its screen (decision 104). */
  signInBackground(pkg: string, eventJson: string, pubkey: string): Promise<boolean>;
}

/**
 * What saving signs out of sight (decision 104): the save, deletions, a browser's seal, the relay and server lists,
 * relay and API sign-in, and the backup uploads. Kind 39701 is reserved for v2 and left out.
 */
export const BACKGROUND_KINDS = [30078, 5, 13, 10002, 10063, 22242, 27235, 24242] as const;

/** A permission the signer may lack: a kind to sign, or NIP-44 to its own key, encrypting and decrypting both. */
export type BackgroundNeed = (typeof BACKGROUND_KINDS)[number] | 'nip44';

/**
 * A throwaway event of a kind, for asking whether the signer signs it without asking. Never sent: dated 1970 and empty,
 * so even a leaked list could never replace a real one.
 */
export function probeEvent(kind: number): EventTemplate {
  return { kind, created_at: 1, tags: kind === 30078 ? [['d', 'kefli/probe']] : [], content: '' };
}

/**
 * A NIP-55 signer. A request its screen never answers (the app closed, or killed underneath) fails after the same two
 * minutes a NIP-46 request gets, so the outbox retries it rather than waiting on it for ever. With screen false, a
 * request the signer won't answer out of sight is refused instead of opening its screen (FD 104): what the phone does
 * on its own never puts the signer in front of the person. withScreen() is the same signer for what they started.
 * What it signs is checked against what was asked whatever the port does (F46), as Nip46Signer's is.
 */
export class Nip55Signer implements SignerProvider {
  readonly kind = 'nip55' as const;
  constructor(
    private readonly port: Nip55Port, private readonly pkg: string, private readonly pk: string,
    private readonly timeoutMs = NIP46_TIMEOUT_MS, readonly screen = true,
    /** Checks the signature of what the signer hands back (the phone passes libsecp256k1's). */
    private readonly verify: (sig: string, id: string, pubkey: string) => boolean = nobleSecp.verify,
  ) {}

  /** This signer, allowed to open the signer app's screen: for what the person started and is watching. */
  withScreen(): Nip55Signer {
    return this.screen ? this : new Nip55Signer(this.port, this.pkg, this.pk, this.timeoutMs, true, this.verify);
  }

  /** This signer, never opening the signer app's screen: for what the phone does on its own. */
  outOfSight(): Nip55Signer {
    return this.screen ? new Nip55Signer(this.port, this.pkg, this.pk, this.timeoutMs, false, this.verify) : this;
  }

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
    const signed = JSON.parse(await withTimeout(this.port.signEvent(this.pkg, JSON.stringify({ ...e, pubkey: this.pk }), this.pk, this.screen), this.timeoutMs)) as NostrEvent;
    if (signed?.pubkey !== this.pk) throw new Error('the signer signed with another key');
    if (!signedAsAsked({ ...e, pubkey: this.pk }, signed, this.verify)) throw new Error('the signer’s answer is not the event asked for');
    return signed;
  }

  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return withTimeout(this.port.nip44Encrypt(this.pkg, plaintext, peer, this.pk, this.screen), this.timeoutMs);
  }

  nip44Decrypt(peer: string, ciphertext: string): Promise<string> {
    return withTimeout(this.port.nip44Decrypt(this.pkg, ciphertext, peer, this.pk, this.screen), this.timeoutMs);
  }

  /** What the signer won't do without asking (decision 104), checked through its resolver alone, in order. */
  async missingInBackground(): Promise<BackgroundNeed[]> {
    const missing: BackgroundNeed[] = [];
    if (!(await this.port.canActInBackground(this.pkg, this.pk).catch(() => false))) missing.push('nip44');
    for (const kind of BACKGROUND_KINDS) {
      const json = JSON.stringify({ ...probeEvent(kind), pubkey: this.pk });
      if (!(await this.port.signInBackground(this.pkg, json, this.pk).catch(() => false))) missing.push(kind);
    }
    return missing;
  }

  /**
   * Asks the signer, through its screen, for each permission missing, one after another, so the person can approve
   * each and remember it (decision 104). step(n) before the nth request; a refusal stops and throws.
   */
  async approve(missing: BackgroundNeed[], step: (n: number) => void): Promise<void> {
    const asking = this.withScreen();
    for (const [n, need] of missing.entries()) {
      step(n + 1);
      // both directions: sync and the inbox decrypt out of sight, so a signer that only encrypts isn't enough
      if (need === 'nip44') await asking.nip44Decrypt(this.pk, await asking.nip44Encrypt(this.pk, PROBE_TEXT));
      else await asking.signEvent(probeEvent(need));
    }
  }
}

/** The calls a connected NIP-46 session answers (nostr-tools' BunkerSigner, composed: its constructor is private). */
export interface BunkerLike {
  signEvent(e: EventTemplate): Promise<NostrEvent>;
  nip44Encrypt(peer: string, plaintext: string): Promise<string>;
  nip44Decrypt(peer: string, ciphertext: string): Promise<string>;
  getPublicKey(): Promise<string>;
}

/**
 * A bunker's own refusal reaches nostr-tools' BunkerSigner as the error string of its NIP-46 answer, with no code, so
 * isSignerFailure read it as an answer and the event was dropped. These words mark it as the person or the bunker
 * declining, so what depends on it waits. Any other error string stays an answer: a ciphertext the bunker can't open
 * must not hold sync for ever.
 */
const REFUSAL = /\b(denied|declined?|reject(ed)?|refused?|unauthori[sz]ed|forbidden|cancel(l?ed)?|not (authori[sz]ed|allowed|permitted)|no permission|permission)\b/i;

class BunkerFailure extends Error {
  constructor(message: string, readonly code: 'rejected' | 'unavailable') {
    super(message);
    this.name = 'BunkerFailure';
  }
}

/**
 * A failed bunker request as Kefli reads it: code 'rejected' when its words say it declined, 'unavailable' when the
 * request reached none of the bunker's relays or the session is closed, otherwise an Error carrying its words.
 */
export function bunkerFailure(e: unknown): unknown {
  if (e instanceof TimeoutError || (typeof e === 'object' && e !== null && (e as { code?: unknown }).code !== undefined)) return e;
  // BunkerSigner publishes with Promise.any: every relay of the bunker refused or was down
  if (typeof AggregateError !== 'undefined' && e instanceof AggregateError) return new BunkerFailure('the bunker’s relays are unreachable', 'unavailable');
  const message = typeof e === 'string' ? e : e instanceof Error ? e.message : String(e);
  if (/not open anymore/.test(message)) return new BunkerFailure(message, 'unavailable');
  if (REFUSAL.test(message)) return new BunkerFailure(message, 'rejected');
  return e instanceof Error ? e : new Error(message);
}

export class Nip46Signer implements SignerProvider {
  readonly kind = 'nip46' as const;
  constructor(
    private readonly bunker: BunkerLike, private readonly pk: string, private readonly timeoutMs = NIP46_TIMEOUT_MS,
    /** Checks the signature of what the bunker hands back (the phone passes libsecp256k1's). */
    private readonly verify: (sig: string, id: string, pubkey: string) => boolean = nobleSecp.verify,
  ) {}

  private ask<T>(p: () => Promise<T>): Promise<T> {
    return withTimeout(p(), this.timeoutMs).catch((e: unknown) => {
      throw bunkerFailure(e);
    });
  }

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

  /** The bunker's answer, refused unless it is the event asked for under this key, validly signed (F46). */
  async signEvent(e: EventTemplate): Promise<NostrEvent> {
    const signed = await this.ask(() => this.bunker.signEvent(e));
    if (signed?.pubkey !== this.pk) throw new Error('the signer signed with another key');
    if (!signedAsAsked({ ...e, pubkey: this.pk }, signed, this.verify)) throw new Error('the signer’s answer is not the event asked for');
    return signed;
  }

  nip44Encrypt(peer: string, plaintext: string): Promise<string> {
    return this.ask(() => this.bunker.nip44Encrypt(peer, plaintext));
  }

  nip44Decrypt(peer: string, ciphertext: string): Promise<string> {
    return this.ask(() => this.bunker.nip44Decrypt(peer, ciphertext));
  }
}

/**
 * The web links an import brings in (C§4.6, FD 82): kind 39701 bookmarks (d is the URL without its scheme, imported
 * as https://<d>) and the r tags of the user's kind 10003 and every kind 30003 set. Private entries in content, e and
 * a tags aren't read. Only the user's own events count; each save once, by its hash, in the order found, its link as
 * the platform's URL writes it, or as withoutUserInfo writes it without the user name and password it holds (ruling 8),
 * which the save would otherwise carry to every relay as its address.
 *
 * A link is one normalise takes, as well as the platform's URL: the phone's URL (Expo's, with no Unicode step) takes
 * hosts normalise refuses, such as one with a joiner or a mixed-direction label, and one such bookmark made the
 * sign-in throw at its hash, every time. The hashes seen are a set, not a list searched for each link, which took
 * 30 s for 40,000 links.
 */
export function bookmarkSaves(events: NostrEvent[], pubkey: string): { url: string; hash: string }[] {
  const out: { url: string; hash: string }[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.pubkey !== pubkey) continue;
    for (const u of eventLinks(e)) {
      const saved = bookmarkSave(u);
      if (!saved || seen.has(saved.hash)) continue;
      seen.add(saved.hash);
      out.push(saved);
    }
  }
  return out;
}

// built from a string: the code gate's parser reads a regex literal's escaped slashes as a comment
const WEB_SCHEME = new RegExp('^https?://');

/** The links one event names, in its order: a 39701's d as https://<d>, the r tags of a 10003 or a 30003. */
function eventLinks(e: NostrEvent): string[] {
  if (e.kind === 39701) {
    const d = e.tags.find((t) => t[0] === 'd')?.[1];
    return d ? [`https://${d.replace(WEB_SCHEME, '')}`] : [];
  }
  if (e.kind !== 10003 && e.kind !== 30003) return [];
  return e.tags.filter((t) => t[0] === 'r' && t[1]).map((t) => t[1]);
}

/** A bookmarked link as its save keeps it, with its hash; null for one that isn't a link. */
function bookmarkSave(u: string): { url: string; hash: string } | null {
  try {
    const url = new URL(u);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const link = withoutUserInfo(url.href);
    return { url: link, hash: itemHash(link) };
  } catch {
    return null;
  }
}

/** The links alone, in bookmarkSaves' order. */
export function bookmarkLinks(events: NostrEvent[], pubkey: string): string[] {
  return bookmarkSaves(events, pubkey).map((b) => b.url);
}
