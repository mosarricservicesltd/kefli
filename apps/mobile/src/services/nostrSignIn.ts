// Sign in with your nostr app (mobile spec 5.3, 4.6, 4.10, contract 2, 3.1, 4.6; FD 5, FD 41, FD 76, FD 82). With a
// signer from the user's app (NIP-55 or a bunker), the capability probe runs first; then their lists are read from
// the indexer and default relays, their web bookmarks counted, and only then is the identity stored, its restore
// queued and, when Shelf added to their lists or made them, the lists queued to publish. A list neither found nor
// confirmed absent is read again at the next sync, and nothing is published meanwhile. Ports keep it testable.
import { KIND, bookmarkLinks, itemHash, newest, probeSigner, readRelayList, readServerList, type NostrEvent, type RelayEntry, type Signer } from '@shelf/protocol';
import type { SqlDb } from '../data/db';
import { adoptUserLists, confirmedAbsent, type DefaultsLike } from '../data/lists';
import { queueRecord } from '../data/devices';
import type { Filter } from './sync';

export type SignInPorts = {
  db: SqlDb;
  now: () => number;
  defaults: DefaultsLike;
  query: (relay: string, filters: Filter[]) => Promise<NostrEvent[]>;
};

export type UserLists = { relays: RelayEntry[] | null; servers: string[] | null; known: boolean };

/** The newest 10002 and 10063 on the indexer and default relays, and whether a missing one is confirmed absent. */
export async function readUserLists(p: SignInPorts, pubkey: string): Promise<UserLists> {
  const asked = [...new Set([...p.defaults.indexer, ...p.defaults.relays])];
  const answered = new Set<string>();
  const events = (await Promise.all(asked.map((r) => p.query(r, [{ kinds: [KIND.relayList, KIND.serverList], authors: [pubkey] }]).then(
    (e) => (answered.add(r), e),
    () => [] as NostrEvent[],
  )))).flat().filter((e) => e.pubkey === pubkey);
  const relayList = newest(events.filter((e) => e.kind === KIND.relayList));
  const serverList = newest(events.filter((e) => e.kind === KIND.serverList));
  const absent = confirmedAbsent(p.defaults, answered);
  return {
    relays: relayList ? readRelayList(relayList) : null,
    servers: serverList ? readServerList(serverList) : null,
    known: (!!relayList || absent) && (!!serverList || absent),
  };
}

/** The web links the user's bookmarks name (C§4.6) that aren't saves here yet. */
export async function findBookmarks(p: SignInPorts, pubkey: string, relays: string[]): Promise<string[]> {
  const asked = [...new Set([...relays, ...p.defaults.indexer])];
  const filters: Filter[] = [{ kinds: [39701, 10003, 30003], authors: [pubkey] }];
  const events = (await Promise.all(asked.map((r) => p.query(r, filters).catch(() => [] as NostrEvent[])))).flat();
  return bookmarkLinks(events, pubkey).filter((url) => !p.db.get('SELECT 1 FROM items WHERE owner = ? AND hash = ?', pubkey, itemHash(url)));
}

export type Checked = { ok: true; lists: UserLists; links: string[] } | { ok: false; why: 'probe' };

/** Everything sign-in learns before storing anything: the probe, the lists and the bookmarks. */
export async function checkSignIn(p: SignInPorts, signer: Signer): Promise<Checked> {
  if (!(await probeSigner(signer))) return { ok: false, why: 'probe' };
  const pk = signer.pubkey();
  const lists = await readUserLists(p, pk);
  const read = (lists.relays ?? []).filter((r) => r.read).map((r) => r.url);
  const links = await findBookmarks(p, pk, read.length ? read : [p.defaults.operator.relay, ...p.defaults.relays]);
  return { ok: true, lists, links };
}

/**
 * The lists once known (4.6): kept, with Shelf's copies added when the switch is on, or the default set when
 * confirmed absent; published only when Shelf changed them. Returns false while still unknown.
 */
export function settleUserLists(db: SqlDb, now: number, owner: string, d: DefaultsLike, lists: UserLists, keepCopies: boolean): boolean {
  if (!lists.known) return false;
  if (adoptUserLists(db, owner, d, lists.relays, lists.servers, keepCopies)) queueRecord(db, now, owner);
  return true;
}

/** Imported links (FD 82): pending saves at the import time, after the restore's first pass, skipping saves here. */
export function queueImport(db: SqlDb, now: number, owner: string, links: string[]): void {
  db.run("INSERT OR REPLACE INTO jobs (id, kind, state, step, data, started_at, updated_at) VALUES (?, 'import', 'queued', 0, ?, ?, ?)",
    `import:${owner}`, JSON.stringify({ links, at: now }), now, now);
}

export function takeImport(db: SqlDb, owner: string): { links: string[]; at: number } | null {
  const r = db.get<{ data: string }>("SELECT data FROM jobs WHERE id = ? AND state = 'queued'", `import:${owner}`);
  if (!r) return null;
  db.run("UPDATE jobs SET state = 'done' WHERE id = ?", `import:${owner}`);
  return JSON.parse(r.data);
}
