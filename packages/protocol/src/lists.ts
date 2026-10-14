// The user's relay list (NIP-65 kind 10002) and Blossom server list (BUD-03 kind 10063), contract 3.1, 4.2;
// mobile spec 4.6. Builders, readers that keep what they don't understand, and the pure merge for Keep backup
// copies: Kefli's entries are added only where missing, and every other entry keeps its place and marker.
import { KIND } from './constants';
import { signWithinCeiling } from './events';
import type { NostrEvent, Signer } from './signer';

export type RelayEntry = { url: string; read: boolean; write: boolean };

/** Relay URLs compare without a trailing slash, as NIP-65 lists write them either way. */
export const sameUrl = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

export function relayTags(entries: RelayEntry[]): string[][] {
  return entries.filter((e) => e.read || e.write).map((e) => (e.read && e.write ? ['r', e.url] : ['r', e.url, e.read ? 'read' : 'write']));
}

/**
 * The most entries read from one 10002 or 10063. NIP-65 asks for two to four relays of each kind; the phone asks every
 * read relay at each sync and sends each save to every write relay, so a list of 10,000, which a relay keeping 64 KB
 * events holds, cost a socket a relay at every sync and an outbox target a relay for every save. A longer list is
 * read to its first 50 usable entries, in its order.
 */
export const LIST_MAX = 50;

// built from strings: the code gate's parser reads a regex literal's escaped slashes as a comment
const RELAY_URL = new RegExp('^wss?://[^\\s/?#@]+(?:[/?#]\\S*)?$', 'i');
const SERVER_URL = new RegExp('^https?://[^\\s/?#@]+(?:[/?#]\\S*)?$', 'i');
const usable = (url: unknown, form: RegExp): url is string => typeof url === 'string' && url.length <= 2048 && form.test(url);

/** Whether url can be a relay's: ws:// or wss://, a host, no credentials or spaces. */
export const isRelayUrl = (url: unknown): url is string => usable(url, RELAY_URL);
/** Whether url can be a Blossom server's: http:// or https://, a host, no credentials or spaces. */
export const isServerUrl = (url: unknown): url is string => usable(url, SERVER_URL);

/** The tags named name whose value passes ok, each address once (slash or not), at most LIST_MAX. */
function listed(event: Pick<NostrEvent, 'tags'>, name: string, ok: (url: unknown) => url is string): string[][] {
  const seen = new Set<string>();
  const out: string[][] = [];
  for (const t of event.tags) {
    if (out.length >= LIST_MAX) break;
    if (t[0] !== name || !ok(t[1]) || seen.has(t[1].replace(/\/+$/, ''))) continue;
    seen.add(t[1].replace(/\/+$/, ''));
    out.push(t);
  }
  return out;
}

/** A 10002's entries; an r tag without a marker is read and write (NIP-65). Relay addresses only, at most LIST_MAX. */
export function readRelayList(event: Pick<NostrEvent, 'tags'>): RelayEntry[] {
  return listed(event, 'r', isRelayUrl).map((t) => ({ url: t[1], read: t[2] !== 'write', write: t[2] !== 'read' }));
}

/** A 10063's servers: http(s) addresses only, at most LIST_MAX. */
export function readServerList(event: Pick<NostrEvent, 'tags'>): string[] {
  return listed(event, 'server', isServerUrl).map((t) => t[1]);
}

/** Keep backup copies (CR12): add each missing relay, read and write, at the end; leave the rest untouched. */
export function withBackupRelays(existing: RelayEntry[], add: string[]): { entries: RelayEntry[]; added: string[] } {
  const entries = existing.map((e) => ({ ...e }));
  const added: string[] = [];
  for (const url of add) {
    if (!entries.some((e) => sameUrl(e.url, url))) {
      entries.push({ url, read: true, write: true });
      added.push(url);
    }
  }
  return { entries, added };
}

export function withBackupServers(existing: string[], add: string[]): { servers: string[]; added: string[] } {
  const servers = [...existing];
  const added = add.filter((url) => !servers.some((s) => sameUrl(s, url)));
  servers.push(...added);
  return { servers, added };
}

export function buildRelayList(signer: Signer, entries: RelayEntry[], createdAt: number): Promise<NostrEvent> {
  return signWithinCeiling(signer, { kind: KIND.relayList, created_at: createdAt, tags: relayTags(entries), content: '' });
}

export function buildServerList(signer: Signer, servers: string[], createdAt: number): Promise<NostrEvent> {
  return signWithinCeiling(signer, { kind: KIND.serverList, created_at: createdAt, tags: servers.map((s) => ['server', s]), content: '' });
}

/** The newest copy seen on any relay: an edit always starts from it (FD 76). */
export function newest<T extends Pick<NostrEvent, 'created_at' | 'id'>>(copies: T[]): T | null {
  return copies.reduce<T | null>((best, e) => (!best || e.created_at > best.created_at || (e.created_at === best.created_at && e.id < best.id) ? e : best), null);
}
