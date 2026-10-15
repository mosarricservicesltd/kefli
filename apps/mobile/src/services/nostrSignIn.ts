// Sign in with your nostr app (mobile spec 5.3, 4.6, 4.10, contract 2, 3.1, 4.6; FD 5, FD 41, FD 76, FD 82). With a
// signer from the user's app (NIP-55 or a bunker), the capability probe runs first; then their lists are read from
// the indexer and default relays, their web bookmarks counted, and only then is the identity stored, its restore
// queued and, when Kefli added to their lists or made them, the lists queued to publish. A list neither found nor
// confirmed absent is read again at the next sync, and nothing is published meanwhile. Ports keep it testable.
import { KIND, bookmarkSaves, newest, probeSigner, readRelayList, readServerList, type NostrEvent, type RelayEntry, type Signer } from '@kefli/protocol';
import type { SqlDb } from '../data/db';
import { addressFits } from '../data/saves';
import { adoptUserLists, confirmedAbsent, markListsSettled, recordList, type DefaultsLike } from '../data/lists';
import { queueRecord } from '../data/devices';
import type { Filter } from './sync';

export type SignInPorts = {
  db: SqlDb;
  now: () => number;
  defaults: DefaultsLike;
  query: (relay: string, filters: Filter[]) => Promise<NostrEvent[]>;
};

/**
 * The person's lists as read: their entries, as Kefli uses them (at most LIST_MAX of each), null for a list not found,
 * and the newest copies themselves (relayList, serverList), every entry and tag as their other apps wrote them, which
 * are kept as the lists held (settleUserLists), so the first lists Kefli sends start from them with no second read.
 */
export type UserLists = {
  relays: RelayEntry[] | null; servers: string[] | null; known: boolean; relayList?: NostrEvent | null; serverList?: NostrEvent | null;
};

/**
 * The furthest past this phone's clock a list read here may be dated and still be kept as the list held: the day
 * sync's read allows another device's clock (services/sync.ts SKEW, notYet), which imports this module.
 */
const HELD_AHEAD = 86_400;

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
    relayList, serverList,
  };
}

/**
 * The web links the user's bookmarks name (C§4.6) that aren't saves here yet: each one normalise takes and short
 * enough to be saved (data/saves addressFits), so the import sheet counts only what Bring them in can bring.
 */
export async function findBookmarks(p: SignInPorts, pubkey: string, relays: string[]): Promise<string[]> {
  const asked = [...new Set([...relays, ...p.defaults.indexer])];
  const filters: Filter[] = [{ kinds: [39701, 10003, 30003], authors: [pubkey] }];
  const events = (await Promise.all(asked.map((r) => p.query(r, filters).catch(() => [] as NostrEvent[])))).flat();
  return bookmarkSaves(events, pubkey)
    .filter((b) => addressFits(b.url) && !p.db.get('SELECT 1 FROM items WHERE owner = ? AND hash = ?', pubkey, b.hash))
    .map((b) => b.url);
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
 * The lists once known (4.6): kept, with Kefli's copies added when the switch is on, or the default set when
 * confirmed absent; published only when Kefli changed them. The copies read are kept whole as the lists held
 * (recordList), so the 10002 and 10063 sent from here are theirs entry for entry (data/lists relayListTags): kept as
 * parsed alone, at most LIST_MAX entries each, the first publish waited for a second read of every relay to bring the
 * lists back, and stayed queued while a relay that held them didn't answer. A copy dated more than HELD_AHEAD past
 * this phone's clock gives its entries but isn't kept as held, as sync's read leaves it to wait for its time: kept, it
 * dated every list sent from here after it (nextListTime), which the relays that check dates refuse, and no list
 * another app sent later was ever newer. Returns false while still unknown.
 */
export function settleUserLists(db: SqlDb, now: number, owner: string, d: DefaultsLike, lists: UserLists, keepCopies: boolean): boolean {
  if (!lists.known) return false;
  for (const e of [lists.relayList, lists.serverList]) {
    if (e && e.created_at <= now + HELD_AHEAD) recordList(db, owner, e.kind, e.id, e.created_at, JSON.stringify(e));
  }
  if (adoptUserLists(db, owner, d, lists.relays, lists.servers, keepCopies)) queueRecord(db, now, owner);
  markListsSettled(db, now, owner);
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
