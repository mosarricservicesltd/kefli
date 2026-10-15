// The identity's relays and servers (mobile spec 4.1, 4.6): seeded from defaults.json for a generated identity,
// read when choosing where saves go. The indexer relays carry the 10002 only. The tables hold what Kefli uses, at
// most LIST_MAX of a list's entries (packages/protocol); the 10002 and 10063 it publishes are the lists held, entry
// for entry, with its own changes (relayListTags, serverListTags).
import { KIND, isRelayUrl, isServerUrl, readServerList, relayTags, sameUrl, type RelayEntry } from '@kefli/protocol';
import type { SqlDb } from './db';
import { enqueue } from './outbox';
import { getSetting, setSetting } from './settings';

export type DefaultsLike = { operator: { relay: string; blossom: string }; relays: string[]; indexer: string[]; mirrors: string[] };

/** A generated identity's lists on its first save (C§3.1, C§4.2): operator plus relays[0..1], read and write;
 *  operator Blossom plus mirrors[0]. Every entry is Kefli's own. Existing rows are left as they are. */
export function seedGeneratedLists(db: SqlDb, owner: string, d: DefaultsLike): void {
  db.tx(() => {
    seedRelays(db, owner, d);
    seedServers(db, owner, d);
  });
}

/** The default 10002 (C§3.1): Kefli's relay and relays[0..1], read and write, with the indexer relays. Returns true. */
function seedRelays(db: SqlDb, owner: string, d: DefaultsLike): boolean {
  const relay = (url: string, source: string, rw: number) =>
    db.run('INSERT OR IGNORE INTO relays (url, owner, read, write, source, added_by_app) VALUES (?, ?, ?, ?, ?, 1)', url, owner, rw, rw, source);
  relay(d.operator.relay, 'operator', 1);
  for (const r of d.relays.slice(0, 2)) relay(r, 'default', 1);
  for (const r of d.indexer) relay(r, 'indexer', 0);
  return true;
}

/** The default 10063 (C§3.1, C§4.2): Kefli's Blossom server and mirrors[0]. Returns true. */
function seedServers(db: SqlDb, owner: string, d: DefaultsLike): boolean {
  const server = (url: string, role: string) =>
    db.run('INSERT OR IGNORE INTO servers (url, owner, role, in_10063, added_by_app) VALUES (?, ?, ?, 1, 1)', url, owner, role);
  server(d.operator.blossom, 'operator');
  if (d.mirrors[0]) server(d.mirrors[0], 'mirror');
  return true;
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

/** The servers in the newest 10063 held, sent or seen (C§8): the text fetch asks them too (F37). */
export function heldServerList(db: SqlDb, owner: string): string[] {
  const raw = db.get<{ raw: string | null }>("SELECT raw FROM lists WHERE owner = ? AND kind = ? AND d = ''", owner, KIND.serverList)?.raw;
  try {
    return raw ? readServerList(JSON.parse(raw) as { tags: string[][] }) : [];
  } catch {
    return [];
  }
}

/**
 * A newer 10063 seen on a relay (C§3.1, C§8, F37): each server it names that this phone doesn't list, and that the
 * 10063 held before (before) didn't name, joins, so restore and the text fetch ask it and the next 10063 sent from
 * here keeps it; one the held list named and the table no longer has was removed here, and stays removed. A server of
 * the person's own that it no longer names was removed elsewhere. Kefli's own entries stay whatever a list says, as in
 * the 10002.
 */
export function keepListedServers(db: SqlDb, owner: string, servers: string[], before: string[] = []): void {
  db.tx(() => {
    const held = db.all<{ url: string; role: string }>('SELECT url, role FROM servers WHERE owner = ?', owner);
    for (const url of servers) {
      if (!held.some((h) => sameUrl(h.url, url)) && !before.some((b) => sameUrl(b, url))) {
        db.run("INSERT OR IGNORE INTO servers (url, owner, role, in_10063, added_by_app) VALUES (?, ?, 'user', 1, 0)", url, owner);
      }
    }
    for (const h of held) {
      if (h.role === 'user' && !servers.some((url) => sameUrl(h.url, url))) db.run('DELETE FROM servers WHERE owner = ? AND url = ?', owner, h.url);
    }
  });
}

/**
 * The tags named name of a list kept as raw JSON whose address ok takes, each address once (the first, slash or not),
 * every one of them: past LIST_MAX too, which only bounds what Kefli uses of a list. Nothing for no list, or one that
 * doesn't read.
 */
function namedIn(raw: string | null, name: string, ok: (url: unknown) => url is string): string[][] {
  let tags: unknown;
  try {
    tags = raw ? (JSON.parse(raw) as { tags?: unknown } | null)?.tags : null;
  } catch {
    return [];
  }
  const seen = new Set<string>();
  return (Array.isArray(tags) ? tags : []).filter((t): t is string[] => {
    if (!Array.isArray(t) || t[0] !== name || !ok(t[1]) || seen.has(bare(t[1]))) return false;
    seen.add(bare(t[1]));
    return true;
  });
}

/**
 * Every relay a 10002 kept as raw JSON names, with its markers as readRelayList reads them: what "the list it held"
 * named (C§3.1), past LIST_MAX too. Read to its first LIST_MAX alone, a relay removed here that the held list named
 * further down came back when another app's newer list moved it up.
 */
export function relaysNamed(raw: string | null): RelayEntry[] {
  return namedIn(raw, 'r', isRelayUrl).map((t) => ({ url: t[1], read: t[2] !== 'write', write: t[2] !== 'read' }));
}

/** Every server a 10063 kept as raw JSON names, past LIST_MAX too (relaysNamed). */
export function serversNamed(raw: string | null): string[] {
  return namedIn(raw, 'server', isServerUrl).map((t) => t[1]);
}

type HeldRelay = { url: string; read: number; write: number; source: string; added_by_app: number; added_at: number | null; prior: string | null };

/** A row's entry before a change, as removing the change brings it back (addRelay, keepListedRelays): JSON of it. */
const priorOf = (r: HeldRelay) => JSON.stringify({ read: r.read, write: r.write, source: r.source, added_by_app: r.added_by_app });

/** The row an addition replaced (prior), or null for none, or one that doesn't read. */
function priorRow(prior: string | null): { read: number; write: number; source: string; added_by_app: number } | null {
  try {
    return prior ? JSON.parse(prior) : null;
  } catch {
    return null;
  }
}

/**
 * One entry of a newer 10002 (keepListedRelays), against the row the table holds for it and the entry the list held
 * before named (was). An entry the held list didn't name joins as the person's own, read or write as the list says,
 * and so does one Kefli holds only as an indexer, the indexer row kept to come back (prior); one the held list named
 * that the table doesn't hold was removed here, its list not yet sent, and stays removed. One of the person's own whose
 * markers the newer list changed from the held list's takes them, unless this phone added it after the list was made.
 * Kefli's own entries (its relay, the backups) keep their markers whatever a list says.
 */
function takeEntry(db: SqlDb, owner: string, e: RelayEntry, row: HeldRelay | undefined, was: RelayEntry | undefined, madeAt: number): void {
  const marks = [Number(e.read), Number(e.write)];
  if (!row) {
    if (!was) db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app) VALUES (?, ?, ?, ?, 'user', 0)", e.url, owner, ...marks);
    return;
  }
  if (row.source === 'indexer') {
    if (!was) db.run("UPDATE relays SET read = ?, write = ?, source = 'user', added_by_app = 0, prior = ? WHERE owner = ? AND url = ?", ...marks, priorOf(row), owner, row.url);
    return;
  }
  if (row.source === 'user' && !addedSince(row, madeAt) && !sameMarks(was, e)) {
    db.run('UPDATE relays SET read = ?, write = ? WHERE owner = ? AND url = ?', ...marks, owner, row.url);
  }
}

/** Whether this phone added a row (in Advanced) after a list was made, which that list then can't change or drop. */
const addedSince = (r: HeldRelay, madeAt: number) => (r.added_at ?? 0) > madeAt;

/** Whether the list held said of an entry what the newer list says: then no other app changed its markers. */
const sameMarks = (was: RelayEntry | undefined, e: RelayEntry) => !!was && was.read === e.read && was.write === e.write;

/** A relay of the person's own that a newer 10002 no longer names: gone, or the indexer row it replaced back as it was. */
function dropOwn(db: SqlDb, owner: string, r: HeldRelay): void {
  const p = priorRow(r.prior);
  if (p?.source === 'indexer') {
    db.run('UPDATE relays SET read = ?, write = ?, source = ?, added_by_app = ?, added_at = NULL, prior = NULL WHERE owner = ? AND url = ?',
      p.read, p.write, p.source, p.added_by_app, owner, r.url);
  } else {
    db.run('DELETE FROM relays WHERE owner = ? AND url = ?', owner, r.url);
  }
}

/**
 * A newer 10002 seen on a relay (C§3.1, FD 113): its entries (at most LIST_MAX, what Kefli uses) taken in against the
 * list held before it (before: every entry it named, its markers too) by takeEntry. A relay of the person's own that
 * the newer list no longer names was removed elsewhere, and goes, unless this phone added it after the list was made
 * (madeAt): an indexer it replaced comes back as it was. Without this, a relay the person's list named that Kefli held
 * as an indexer was never read from or written to, and a marker changed in another app never reached this phone.
 */
export function keepListedRelays(db: SqlDb, owner: string, entries: RelayEntry[], before: RelayEntry[], madeAt: number): void {
  db.tx(() => {
    const rows = new Map(db.all<HeldRelay>('SELECT url, read, write, source, added_by_app, added_at, prior FROM relays WHERE owner = ?', owner).map((r) => [bare(r.url), r]));
    const was = new Map(before.map((e) => [bare(e.url), e]));
    for (const e of entries) takeEntry(db, owner, e, rows.get(bare(e.url)), was.get(bare(e.url)), madeAt);
    const named = new Set(entries.map((e) => bare(e.url)));
    for (const r of rows.values()) {
      if (r.source === 'user' && !named.has(bare(r.url)) && !addedSince(r, madeAt)) dropOwn(db, owner, r);
    }
  });
}

/** Whether this identity's lists have been published (the lists table holds the newest copy sent or seen). */
export function hasList(db: SqlDb, owner: string, kind: number): boolean {
  return !!db.get('SELECT 1 FROM lists WHERE owner = ? AND kind = ?', owner, kind);
}

const isTag = (t: unknown): t is string[] => Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === 'string');

/** The tags of the newest list held, sent or seen, as it was held; null with none, or one that doesn't read. */
function heldTags(db: SqlDb, owner: string, kind: number): string[][] | null {
  const raw = db.get<{ raw: string | null }>("SELECT raw FROM lists WHERE owner = ? AND kind = ? AND d = ''", owner, kind)?.raw;
  try {
    const tags: unknown = raw ? (JSON.parse(raw) as { tags?: unknown } | null)?.tags : null;
    return Array.isArray(tags) ? tags.filter(isTag) : null;
  } catch {
    return null;
  }
}

/**
 * An address as lists compare it, without its trailing slashes (sameUrl), taken off by hand: the regex /\/+$/ backtracks
 * through a run of slashes from every one of them, and a list held from a relay that keeps 64 KB events can carry a tag
 * of 60,000, 46 s on Node at every list sent.
 */
export function bare(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end--;
  return url.slice(0, end);
}

/**
 * The relays changed in Advanced since a 10002 last went out (FD 113): one removed, or put back as it was before it was
 * added, which the list held still names as it was then. The next 10002 shows each as the table holds it, or leaves it
 * out, and once one has gone out they are entries like any other (listEditsSent). Kept with the settings, by owner.
 */
const editsKey = (owner: string) => `lists.edits ${owner}`;

export function listEdits(db: SqlDb, owner: string): string[] {
  try {
    const v: unknown = JSON.parse(getSetting(db, editsKey(owner)) ?? '[]');
    return Array.isArray(v) ? v.filter((u): u is string => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

function noteEdit(db: SqlDb, owner: string, url: string): void {
  setSetting(db, editsKey(owner), JSON.stringify([...new Set([...listEdits(db, owner), url])]));
}

/** A 10002 showing these edits went out: they are the list now. One made while it was being sent waits for the next. */
export function listEditsSent(db: SqlDb, owner: string, sent: string[]): void {
  const left = listEdits(db, owner).filter((u) => !sent.includes(u));
  if (left.length) setSetting(db, editsKey(owner), JSON.stringify(left));
  else db.run('DELETE FROM settings WHERE key = ?', editsKey(owner));
}

type Row = { url: string; read: number; write: number; source: string; added_by_app: number; added_at: number | null };

/** Whether a row is an entry of Kefli's own in the 10002 (its relay, a backup, one added in Advanced): its markers stand. */
const kefliEntry = (r: Row) => r.source !== 'indexer' && (r.added_by_app === 1 || r.added_at !== null);

/** A row as an entry of the 10002, or null for an indexer-only one, which isn't. */
const entryOf = (r: Row | undefined): RelayEntry | null => (r && r.source !== 'indexer' ? { url: r.url, read: !!r.read, write: !!r.write } : null);

/** Whether an r tag says what an entry does; no marker is read and write (NIP-65), as readRelayList reads it. */
const says = (t: string[], e: RelayEntry) => (t[2] !== 'write') === e.read && (t[2] !== 'read') === e.write;

/**
 * One r tag of the list held, as the 10002 sent from here carries it: one of the person's own, or naming a relay the
 * table doesn't hold, as it was held; one of Kefli's own, or a relay changed in Advanced since the last list went out
 * (listEdits), as the table holds it now, its tag kept when the table says the same, or left out ([]) when the table no
 * longer has it in the list.
 */
function sentEntry(t: string[], row: Row | undefined, edited: boolean): string[][] {
  if (!edited && !(row && kefliEntry(row))) return [t];
  const e = entryOf(row);
  if (!e) return [];
  return says(t, e) ? [t] : relayTags([e]);
}

/**
 * The tags of the 10002 Kefli publishes (C§3.1, FD 76, FD 113): the list held, the newest copy sent or seen, entry for
 * entry, with Kefli's own changes. The table holds at most LIST_MAX of a list's entries, and only those Kefli can use,
 * so a list rebuilt from it lost the rest of a nostr user's list, which their other apps share. Every tag of the list
 * held goes out in its place (sentEntry), and after them the table's entries the list doesn't name, in the order they
 * were added. With no list held, as for a generated identity's first, the table is the list.
 */
export function relayListTags(db: SqlDb, owner: string): string[][] {
  const entries = relayEntries(db, owner);
  const held = heldTags(db, owner, KIND.relayList);
  if (!held) return relayTags(entries);
  const rows = new Map(db.all<Row>('SELECT url, read, write, source, added_by_app, added_at FROM relays WHERE owner = ?', owner).map((r) => [bare(r.url), r]));
  const edits = new Set(listEdits(db, owner).map(bare));
  const named = new Set<string>();
  const out: string[][] = [];
  for (const t of held) {
    const url = t[0] === 'r' ? bare(t[1] ?? '') : null;
    if (url !== null) named.add(url);
    out.push(...(url === null ? [t] : sentEntry(t, rows.get(url), edits.has(url))));
  }
  return [...out, ...relayTags(entries.filter((e) => !named.has(bare(e.url))))];
}

/**
 * The tags of the 10063 Kefli publishes (C§3.1, C§4.2): the list held, tag for tag, and after it the servers the table
 * holds that it doesn't name, Kefli's own among them. Kefli only ever adds to a 10063.
 */
export function serverListTags(db: SqlDb, owner: string): string[][] {
  const held = heldTags(db, owner, KIND.serverList) ?? [];
  const named = new Set(held.filter((t) => t[0] === 'server').map((t) => bare(t[1] ?? '')));
  return [...held, ...listServers(db, owner).filter((s) => !named.has(bare(s))).map((s) => ['server', s])];
}

/**
 * Whether the person's own entries are held without the list they came from, as a sign-in leaves them until a read
 * records it (C§3.1: every edit starts from the newest copy seen). A list sent from the tables alone would lose every
 * entry past LIST_MAX and every one Kefli doesn't use, so none is sent until a read brings the list, or confirms it
 * gone from every relay (confirmedAbsent).
 */
export function listsUnread(db: SqlDb, owner: string): boolean {
  const relays = !heldTags(db, owner, KIND.relayList) && !!db.get("SELECT 1 FROM relays WHERE owner = ? AND source = 'user' AND added_at IS NULL", owner);
  return relays || (!heldTags(db, owner, KIND.serverList) && !!db.get("SELECT 1 FROM servers WHERE owner = ? AND role = 'user'", owner));
}

/** Keeps the newest copy: an older one, sent or seen, never replaces it (F36). */
export function recordList(db: SqlDb, owner: string, kind: number, eventId: string, createdAt: number, raw: string): void {
  db.run(`INSERT INTO lists (owner, kind, d, event_id, created_at, raw) VALUES (?, ?, '', ?, ?, ?)
    ON CONFLICT (owner, kind, d) DO UPDATE SET event_id = excluded.event_id, created_at = excluded.created_at, raw = excluded.raw
    WHERE excluded.created_at >= lists.created_at`, owner, kind, eventId, createdAt, raw);
}

/** A new list's created_at: after both of the identity's lists already held, whatever this phone's clock says (F36). */
export function nextListTime(db: SqlDb, owner: string, now: number): number {
  const held = db.get<{ t: number | null }>("SELECT MAX(created_at) AS t FROM lists WHERE owner = ? AND kind IN (?, ?) AND d = ''", owner, KIND.relayList, KIND.serverList)?.t;
  return Math.max(now, (held ?? 0) + 1);
}

/**
 * A nostr user's lists at sign-in (mobile spec 4.6, C§3.1, FD 76): their newest 10002 and 10063 seen on any relay are
 * kept entry for entry, markers too; with Keep backup copies on, the operator relay and defaults.relays[0] join the
 * 10002 and the operator Blossom server and the default mirror the 10063, each marked added_by_app, where not
 * already listed. A list confirmed absent gets the default one, whatever the switch says, and the other list stays
 * theirs. Most nostr users have a 10002 and no 10063: seeding both lists for that put Kefli's three relays in their
 * 10002 with the switch off as well as on, and took each entry of theirs naming one of Kefli's default relays as
 * Kefli's own, so the 10002 sent from here changed its marker. Returns whether the lists must be published: only when
 * Kefli added to them or made them, so a list their other apps share is never rewritten for nothing.
 */
export function adoptUserLists(
  db: SqlDb, owner: string, d: DefaultsLike, relays: RelayEntry[] | null, servers: string[] | null, keepCopies: boolean,
): boolean {
  return db.tx(() => {
    const addedRelays = relays ? keepUserRelays(db, owner, d, relays, keepCopies) : seedRelays(db, owner, d);
    const addedServers = servers ? keepUserServers(db, owner, d, servers, keepCopies) : seedServers(db, owner, d);
    for (const r of d.indexer) db.run("INSERT OR IGNORE INTO relays (url, owner, read, write, source, added_by_app) VALUES (?, ?, 0, 0, 'indexer', 1)", r, owner);
    return addedRelays || addedServers;
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
// built from strings: the code gate's parser reads a regex literal's escaped slashes as a comment
const SCHEME = new RegExp('^[a-z][a-z0-9+.-]*://', 'i');
const WSS = new RegExp('^wss://', 'i');
const RELAY_HOST = new RegExp('^((?:[a-z0-9-]+\\.)+[a-z0-9-]+|localhost|\\[[0-9a-f:]+\\])(:\\d{1,5})?(/[^\\s?#@]*)?$', 'i');

export function relayAddress(typed: string): string | null {
  const s = typed.trim();
  const rest = SCHEME.test(s) ? (WSS.test(s) ? s.slice(6) : null) : s;
  const m = rest === null ? null : RELAY_HOST.exec(rest);
  if (!m) return null;
  const path = m[3] === '/' ? '' : m[3] ?? '';
  return `wss://${m[1].toLowerCase()}${m[2] ?? ''}${path}`;
}

/** Whether the identity's lists are known (4.6): always for Kefli's own; for a nostr user once read or confirmed absent. */
export function listsSettled(db: SqlDb, owner: string): boolean {
  const r = db.get<{ provider: string; lists_settled: number }>('SELECT provider, lists_settled FROM identities WHERE pubkey = ?', owner);
  return !r || r.provider === 'local' || r.lists_settled === 1;
}

/**
 * A nostr user's lists became known (4.6, F4): the identity is marked settled, and saves and deletions that waited
 * (no target, with Keep backup copies off) or went to the interim relays only gain every write relay in the list.
 */
export function markListsSettled(db: SqlDb, now: number, owner: string): void {
  db.tx(() => {
    db.run('UPDATE identities SET lists_settled = 1 WHERE pubkey = ?', owner);
    const relays = writeRelays(db, owner);
    for (const r of db.all<{ id: number }>("SELECT id FROM outbox WHERE signer = ? AND op IN ('publish_item', 'delete_item') AND state IN ('held', 'queued', 'sending')", owner)) {
      for (const url of relays) {
        db.run("INSERT OR IGNORE INTO outbox_targets (outbox_id, target, state, attempts, next_at) VALUES (?, ?, 'pending', 0, ?)", r.id, url, now);
      }
    }
    // saves already sent went to the interim relays only: their own relays get them as signed, as an added relay does
    if (db.get('SELECT 1 FROM items WHERE owner = ? AND published = 1', owner)) {
      for (const r of db.all<{ url: string }>("SELECT url FROM relays WHERE owner = ? AND source = 'user' AND write = 1", owner)) {
        enqueue(db, now, { op: 'copy_relay', signer: owner, subject: r.url, targets: [r.url], lane: 'bulk' });
      }
    }
  });
}

export type RelayRow ={ url: string; source: 'operator' | 'default' | 'user'; removable: boolean };

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
 * A relay the person adds in Advanced (FD 113, C§3.1): it joins the 10002 for reading and writing, and the lists go
 * out again. The library reaches it as already signed: copy_relay copies the newest event of each save and every
 * deletion the other write relays hold, unchanged, so nothing is re-signed from this phone's state, which may be
 * behind another phone's (F16, F35). Changes still waiting or sending here gain it as a target (F17). A row it
 * replaces (an indexer, a nostr user's read-only entry) is kept in prior, for removal to restore (F34). A generated
 * identity that hasn't saved yet gets its default lists first, so its first save still writes to Kefli's relays.
 * Returns false when the relay is already one Kefli writes to.
 */
export function addRelay(db: SqlDb, now: number, owner: string, url: string, d: DefaultsLike): boolean {
  return db.tx(() => {
    // a nostr user's list must be known first, or this would start a list that replaces theirs (4.6)
    if (!listsSettled(db, owner)) return false;
    if (isLocal(db, owner)) seedGeneratedLists(db, owner, d);
    const held = db.get<{ read: number; write: number; source: string; added_by_app: number }>(
      'SELECT read, write, source, added_by_app FROM relays WHERE owner = ? AND url = ?', owner, url);
    if (held?.write && held.source !== 'indexer') return false;
    if (held) {
      db.run("UPDATE relays SET read = 1, write = 1, source = 'user', added_by_app = 0, added_at = ?, prior = ? WHERE owner = ? AND url = ?",
        now, JSON.stringify(held), owner, url);
    } else {
      db.run("INSERT INTO relays (url, owner, read, write, source, added_by_app, added_at) VALUES (?, ?, 1, 1, 'user', 0, ?)", url, owner, now);
    }
    if (hasList(db, owner, KIND.relayList)) publishLists(db, now, owner, []);
    db.run(`INSERT OR IGNORE INTO outbox_targets (outbox_id, target, state, attempts, next_at)
      SELECT id, ?, 'pending', 0, ? FROM outbox WHERE signer = ? AND op IN ('publish_item', 'delete_item') AND state IN ('held', 'queued', 'sending')`,
      url, now, owner);
    if (db.get('SELECT 1 FROM items WHERE owner = ? AND published = 1', owner)) {
      enqueue(db, now, { op: 'copy_relay', signer: owner, subject: url, targets: [url], lane: 'bulk' });
    }
    return true;
  });
}

/**
 * A relay the person added, removed in Advanced (FD 113): Kefli stops writing to it and sends the lists without it,
 * to it as well, so its copy of the 10002 can't bring it back. A row it replaced comes back as it was. What the
 * relay holds stays there. Kefli's relay and the backups aren't removable, since the library outliving the service
 * rests on them (C§1). The change is noted (listEdits), since the list held still names the relay as added.
 */
export function removeRelay(db: SqlDb, now: number, owner: string, url: string): boolean {
  return db.tx(() => {
    if (!relayRows(db, owner).some((r) => r.url === url && r.removable)) return false;
    const prior = db.get<{ prior: string | null }>('SELECT prior FROM relays WHERE owner = ? AND url = ?', owner, url)?.prior;
    if (prior) {
      const p = JSON.parse(prior) as { read: number; write: number; source: string; added_by_app: number };
      db.run('UPDATE relays SET read = ?, write = ?, source = ?, added_by_app = ?, added_at = NULL, prior = NULL WHERE owner = ? AND url = ?',
        p.read, p.write, p.source, p.added_by_app, owner, url);
    } else {
      db.run('DELETE FROM relays WHERE owner = ? AND url = ?', owner, url);
    }
    noteEdit(db, owner, url);
    // a copy still waiting stops, and so do waiting changes' sends to it; a row left with no target goes
    db.run("DELETE FROM outbox WHERE signer = ? AND op = 'copy_relay' AND subject = ? AND state IN ('held', 'queued')", owner, url);
    db.run(`DELETE FROM outbox_targets WHERE target = ? AND state = 'pending'
      AND outbox_id IN (SELECT id FROM outbox WHERE signer = ? AND op IN ('publish_item', 'delete_item') AND state IN ('held', 'queued'))`, url, owner);
    db.run(`DELETE FROM outbox WHERE signer = ? AND op IN ('publish_item', 'delete_item') AND state IN ('held', 'queued')
      AND NOT EXISTS (SELECT 1 FROM outbox_targets t WHERE t.outbox_id = outbox.id)`, owner);
    if (hasList(db, owner, KIND.relayList)) publishLists(db, now, owner, [url]);
    return true;
  });
}

/** The 10002 and 10063 to every write relay and indexer, and to any extra (C§3.1, 4.3). */
function publishLists(db: SqlDb, now: number, owner: string, extra: string[]): void {
  const targets = [...new Set([...writeRelays(db, owner), ...indexerRelays(db, owner), ...extra])];
  enqueue(db, now, { op: 'publish_lists', signer: owner, subject: owner, targets });
}
