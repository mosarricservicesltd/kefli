// The identity's relays and servers (mobile spec 4.1, 4.6): seeded from defaults.json for a generated identity,
// read when building its 10002 and 10063 and choosing where saves go. The indexer relays carry the 10002 only.
import type { RelayEntry } from '@shelf/protocol';
import type { SqlDb } from './db';

export type DefaultsLike = { operator: { relay: string; blossom: string }; relays: string[]; indexer: string[]; mirrors: string[] };

/** A generated identity's lists on its first save (C§3.1, C§4.2): operator plus relays[0..1], read and write;
 *  operator Blossom plus mirrors[0]. Every entry is Shelf's own. Existing rows are left as they are. */
export function seedGeneratedLists(db: SqlDb, owner: string, d: DefaultsLike): void {
  db.tx(() => {
    const relay = (url: string, source: string, rw: number) =>
      db.run('INSERT OR IGNORE INTO relays (url, owner, read, write, source, added_by_shelf) VALUES (?, ?, ?, ?, ?, 1)', url, owner, rw, rw, source);
    relay(d.operator.relay, 'operator', 1);
    for (const r of d.relays.slice(0, 2)) relay(r, 'default', 1);
    for (const r of d.indexer) relay(r, 'indexer', 0);
    const server = (url: string, role: string) =>
      db.run('INSERT OR IGNORE INTO servers (url, owner, role, in_10063, added_by_shelf) VALUES (?, ?, ?, 1, 1)', url, owner, role);
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
