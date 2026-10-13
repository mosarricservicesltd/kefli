// The identity's relays and servers (mobile spec 4.1, 4.6): seeded from defaults.json for a generated identity,
// read when building its 10002 and 10063 and choosing where saves go. The indexer relays carry the 10002 only.
import { KIND, type RelayEntry } from '@kefli/protocol';
import type { SqlDb } from './db';
import { addTargets, enqueue } from './outbox';

export type DefaultsLike = { operator: { relay: string; blossom: string }; relays: string[]; indexer: string[]; mirrors: string[] };

/** A generated identity's lists on its first save (C§3.1, C§4.2): operator plus relays[0..1], read and write;
 *  operator Blossom plus mirrors[0]. Every entry is Kefli's own. Existing rows are left as they are. */
export function seedGeneratedLists(db: SqlDb, owner: string, d: DefaultsLike): void {
  db.tx(() => {
    const relay = (url: string, source: string, rw: number) =>
      db.run('INSERT OR IGNORE INTO relays (url, owner, read, write, source, added_by_app) VALUES (?, ?, ?, ?, ?, 1)', url, owner, rw, rw, source);
    relay(d.operator.relay, 'operator', 1);
    for (const r of d.relays.slice(0, 2)) relay(r, 'default', 1);
    for (const r of d.indexer) relay(r, 'indexer', 0);
    const server = (url: string, role: string) =>
      db.run('INSERT OR IGNORE INTO servers (url, owner, role, in_10063, added_by_app) VALUES (?, ?, ?, 1, 1)', url, owner, role);
    server(d.operator.blossom, 'operator');
    if (d.mirrors[0]) server(d.mirrors[0], 'mirror');
  });
}

/** The identity's 10002 entries, in the order they were added; indexer-only rows are not part of it. */
export function relayEntries(db: SqlDb, owner: string): RelayEntry[] {
  return db
    .all<{ url: string; read: number; write: number }>("SELECT url, read, write FROM relays WHERE owner = ? AND source != 'indexer' ORDER BY rowid", owner)
    .map((r) => ({ url: r.url, read: !!r.read, write: !!r.write }));
}

export function writeRelays(db: SqlDb, owner: string): string[] {
  return relayEntries(db, owner).filter((r) => r.write).map((r) => r.url);
}

export function indexerRelays(db: SqlDb, owner: string): string[] {
  return db.all<{ url: string }>("SELECT url FROM relays WHERE owner = ? AND source = 'indexer' ORDER BY rowid", owner).map((r) => r.url);
}

export function listServers(db: SqlDb, owner: string): string[] {
  return db.all<{ url: string }>('SELECT url FROM servers WHERE owner = ? AND in_10063 = 1 ORDER BY rowid', owner).map((r) => r.url);
}

/** Whether this identity's lists have been published (the lists table holds the newest copy sent or seen). */
export function hasList(db: SqlDb, owner: string, kind: number): boolean {
  return !!db.get('SELECT 1 FROM lists WHERE owner = ? AND kind = ?', owner, kind);
}

export function recordList(db: SqlDb, owner: string, kind: number, eventId: string, createdAt: number, raw: string): void {
  db.run("INSERT OR REPLACE INTO lists (owner, kind, d, event_id, created_at, raw) VALUES (?, ?, '', ?, ?, ?)", owner, kind, eventId, createdAt, raw);
}

/**
 * A nostr user's lists at sign-in (mobile spec 4.6, C§3.1, FD 76): their newest 10002 and 10063 seen on any relay are
 * kept entry for entry, markers too; with Keep backup copies on, the operator relay and defaults.relays[0] join the
 * 10002 and the operator Blossom server and the default mirror the 10063, each marked added_by_app, where not
 * already listed. A list confirmed absent gets the default set, whatever the switch says. Returns whether the
 * lists must be published: only when Kefli added to them or made them, so a list their other apps share is never
 * rewritten for nothing.
 */
export function adoptUserLists(
  db: SqlDb, owner: string, d: DefaultsLike, relays: RelayEntry[] | null, servers: string[] | null, keepCopies: boolean,
): boolean {
  return db.tx(() => {
    const seeded = !relays || !servers;
    if (seeded) seedGeneratedLists(db, owner, d);
    const addedRelays = relays ? keepUserRelays(db, owner, d, relays, keepCopies) : false;
    const addedServers = servers ? keepUserServers(db, owner, d, servers, keepCopies) : false;
    for (const r of d.indexer) db.run("INSERT OR IGNORE INTO relays (url, owner, read, write, source, added_by_app) VALUES (?, ?, 0, 0, 'indexer', 1)", r, owner);
    return seeded || addedRelays || addedServers;
  });
}

/** Their relays, markers kept; with the switch on, Kefli's relay and one backup added. Returns whether any were added. */
function keepUserRelays(db: SqlDb, owner: string, d: DefaultsLike, relays: RelayEntry[], keepCopies: boolean): boolean {
  for (const r of relays) {
    db.run("INSERT OR IGNORE INTO relays (url, owner, read, write, source, added_by_app) VALUES (?, ?, ?, ?, 'user', 0)", r.url, owner, r.read ? 1 : 0, r.write ? 1 : 0);
  }
  if (!keepCopies) return false;
  const add = [[d.operator.relay, 'operator'], [d.relays[0], 'default']].filter(([url]) => !!url);
  return add.map(([url, source]) => db.run('INSERT OR IGNORE INTO relays (url, owner, read, write, source, added_by_app) VALUES (?, ?, 1, 1, ?, 1)', url, owner, source).changes)
    .some((n) => n > 0);
}

/** Their servers; with the switch on, Kefli's Blossom server and the default mirror added. Returns whether any were added. */
function keepUserServers(db: SqlDb, owner: string, d: DefaultsLike, servers: string[], keepCopies: boolean): boolean {
  for (const url of servers) db.run("INSERT OR IGNORE INTO servers (url, owner, role, in_10063, added_by_app) VALUES (?, ?, 'user', 1, 0)", url, owner);
  if (!keepCopies) return false;
  const add = [[d.operator.blossom, 'operator'], [d.mirrors[0], 'mirror']].filter(([url]) => !!url);
  return add.map(([url, role]) => db.run('INSERT OR IGNORE INTO servers (url, owner, role, in_10063, added_by_app) VALUES (?, ?, ?, 1, 1)', url, owner, role).changes)
    .some((n) => n > 0);
}

/**
 * Whether a list nobody returned is confirmed absent (4.6, C§3.1): every indexer relay and at least two of the
 * default relays answered (EOSE) without one. Otherwise the read is retried and nothing is published.
 */
export function confirmedAbsent(d: DefaultsLike, answered: Set<string>): boolean {
  return d.indexer.every((r) => answered.has(r)) && d.relays.filter((r) => answered.has(r)).length >= 2;
}

/**
 * A typed relay address as the 10002 holds it (FD 113): wss:// added when no scheme is given, the host lowercased,
 * a bare trailing / dropped. Any other scheme, credentials, a query or a fragment is refused (null). Written
 * without URL, whose parsing Hermes doesn't fully have.
 */
export function relayAddress(typed: string): string | null {
  const s = typed.trim();
  const rest = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? (/^wss:\/\//i.test(s) ? s.slice(6) : null) : s;
  const m = rest === null ? null : /^((?:[a-z0-9-]+\.)+[a-z0-9-]+|localhost|\[[0-9a-f:]+\])(:\d{1,5})?(\/[^\s?#@]*)?$/i.exec(rest);
  if (!m) return null;
  const path = m[3] === '/' ? '' : m[3] ?? '';
  return `wss://${m[1].toLowerCase()}${m[2] ?? ''}${path}`;
}

export type RelayRow = { url: string; source: 'operator' | 'default' | 'user'; removable: boolean };

const isLocal = (db: SqlDb, owner: string) =>
  (db.get<{ provider: string }>('SELECT provider FROM identities WHERE pubkey = ?', owner)?.provider ?? 'local') === 'local';

/**
 * Advanced's write relays (5.8, FD 113), in the 10002's order. A relay of the person's own is removable there on a
 * generated identity, where only Advanced adds one; for a nostr user only when this phone added it, since the rest
 * are the list their other nostr apps share.
 */
export function relayRows(db: SqlDb, owner: string): RelayRow[] {
  const local = isLocal(db, owner);
  return db
    .all<{ url: string; source: RelayRow['source']; added_at: number | null }>(
      "SELECT url, source, added_at FROM relays WHERE owner = ? AND source != 'indexer' AND write = 1 ORDER BY rowid", owner)
    .map((r) => ({ url: r.url, source: r.source, removable: r.source === 'user' && (local || r.added_at !== null) }));
}

/**
 * A relay the person adds in Advanced (FD 113, C§3.1): it joins the 10002 for reading and writing, the lists go out
 * again, and every published save is published to it on the bulk lane, merged into any change already waiting. A
 * generated identity that hasn't saved yet gets its default lists first, so its first save still writes to
 * Kefli's relays. Returns false when the relay is already one Kefli writes to.
 */
export function addRelay(db: SqlDb, now: number, owner: string, url: string, d: DefaultsLike): boolean {
  return db.tx(() => {
    if (isLocal(db, owner)) seedGeneratedLists(db, owner, d);
    const held = db.get<{ write: number; source: string }>('SELECT write, source FROM relays WHERE owner = ? AND url = ?', owner, url);
    if (held?.write && held.source !== 'indexer') return false;
    if (held) db.run("UPDATE relays SET read = 1, write = 1, source = 'user', added_by_app = 0, added_at = ? WHERE owner = ? AND url = ?", now, owner, url);
    else db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app, added_at) VALUES (?, ?, 1, 1, 'user', 0, ?)", url, owner, now);
    if (hasList(db, owner, KIND.relayList)) publishLists(db, now, owner, []);
    const items = db.all<{ hash: string }>('SELECT hash FROM items WHERE owner = ? AND published = 1 AND pending_delete_at IS NULL ORDER BY saved_at DESC', owner);
    for (const { hash } of items) addTargets(db, now, { op: 'publish_item', signer: owner, subject: hash, targets: [url], lane: 'bulk' });
    return true;
  });
}

/**
 * A relay the person added, removed in Advanced (FD 113): Kefli stops writing to it and sends the lists without it,
 * to it as well, so its copy of the 10002 can't bring it back. What it holds stays there. Kefli's relay and the
 * backups aren't removable, since the library outliving the service rests on them (C§1).
 */
export function removeRelay(db: SqlDb, now: number, owner: string, url: string): boolean {
  return db.tx(() => {
    if (!relayRows(db, owner).some((r) => r.url === url && r.removable)) return false;
    db.run('DELETE FROM relays WHERE owner = ? AND url = ?', owner, url);
    // a copy still under way stops: its waiting targets go, and a row left with none goes with them
    db.run("DELETE FROM outbox_targets WHERE target = ? AND state = 'pending' AND outbox_id IN (SELECT id FROM outbox WHERE signer = ? AND op = 'publish_item' AND state = 'queued')", url, owner);
    db.run("DELETE FROM outbox WHERE signer = ? AND op = 'publish_item' AND state = 'queued' AND NOT EXISTS (SELECT 1 FROM outbox_targets t WHERE t.outbox_id = outbox.id)", owner);
    if (hasList(db, owner, KIND.relayList)) publishLists(db, now, owner, [url]);
    return true;
  });
}

/** The 10002 and 10063 to every write relay and indexer, and to any extra (C§3.1, 4.3). */
function publishLists(db: SqlDb, now: number, owner: string, extra: string[]): void {
  const targets = [...new Set([...writeRelays(db, owner), ...indexerRelays(db, owner), ...extra])];
  enqueue(db, now, { op: 'publish_lists', signer: owner, subject: owner, targets });
}
