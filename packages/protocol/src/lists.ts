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

/** A 10002's entries; an r tag without a marker is read and write (NIP-65). */
export function readRelayList(event: Pick<NostrEvent, 'tags'>): RelayEntry[] {
  return event.tags
    .filter((t) => t[0] === 'r' && typeof t[1] === 'string')
    .map((t) => ({ url: t[1], read: t[2] !== 'write', write: t[2] !== 'read' }));
}

export function readServerList(event: Pick<NostrEvent, 'tags'>): string[] {
  return event.tags.filter((t) => t[0] === 'server' && typeof t[1] === 'string').map((t) => t[1]);
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
