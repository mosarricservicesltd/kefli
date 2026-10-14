// Inbound sync's writes (mobile spec 4.5): a verified, decrypted save merged into its row, a kind 5 applied,
// the per-relay cursors, and the queue of texts to fetch. Platform-free; files are the caller's (services/sync.ts).
//
// RULED: an event with v above 1 that is newer than the local row goes to items_future and the local row is
// removed with its pending sends, since this phone may not write over a version it doesn't understand (C§10);
// an older one is ignored. A save with no text arrives as text_state 'queued', so this phone tries the parse.
import { ITEM_D_PREFIX, deletedDs, deletionRemoves, isServerUrl, mergeItem, wordReached } from '@kefli/protocol';
import { addressIndex } from './libraryKey';
import type { LocalVersion, MergeOutcome, NostrEvent, ParsedItem } from '@kefli/protocol';
import type { SqlDb } from './db';
import { enqueue } from './outbox';
import { writeRelays } from './lists';

export type Stream = 'items' | 'deletions';
/** The cursor streams: saves and deletions per read relay, and the inbox on the operator relay (4.7). */
export type CursorStream = Stream | 'inbox';

type Row = {
  id: number; event_id: string | null; event_created_at: number | null; dirty: number; modified_at: number | null;
  text_sha256: string | null; text_servers: string | null; text_state: string; position_word: number;
};

export type Applied = {
  outcome: MergeOutcome | 'future' | 'ignored';
  /** The row's previous text, now replaced: its files go once no row holds the hash. */
  textReplaced?: boolean;
  /** A remote position for the article open in the Reader, held until the Reader closes. */
  heldWord?: number;
};

const str = (v: unknown, max = Infinity) => (typeof v === 'string' && v !== '' && v.length <= max ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function version(r: Row | undefined): LocalVersion | null {
  return r ? { eventId: r.event_id, createdAt: r.event_created_at, dirty: !!r.dirty, modifiedAt: r.modified_at } : null;
}

const STRINGS = ['canonical', 'title', 'site', 'byline', 'lang', 'hero', 'source_ref', 'audio_pref'] as const;

/**
 * The most servers a text is fetched from: its own (the operator's and a mirror, C§4.2, a move's target's too) and
 * then the 10063's. Each may take a minute to fail, and a save from another client named 10,000.
 */
export const TEXT_SERVERS_MAX = 10;

/** Blob servers as a fetch can use them: http(s) addresses only, without a trailing slash, each once, at most n. */
export function blobServers(servers: unknown[], n = TEXT_SERVERS_MAX): string[] {
  const out = new Set<string>();
  for (const s of servers) {
    if (out.size >= n) break;
    if (isServerUrl(s)) out.add(s.replace(/\/+$/, ''));
  }
  return [...out];
}

/**
 * text, only when its sha256 is 64 hex, the address every server is asked at (one that isn't would be asked for as a
 * path on each server), and its key and nonce are strings; servers kept as blobServers reads them.
 */
function textOf(t: unknown) {
  const o = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
  const [sha256, key, nonce] = [str(o.sha256), str(o.key), str(o.nonce)];
  if (!sha256 || !/^[0-9a-f]{64}$/.test(sha256) || !key || !nonce) return null;
  const servers = Array.isArray(o.servers) ? blobServers(o.servers) : [];
  return { text_sha256: sha256, text_key: key, text_nonce: nonce, text_servers: JSON.stringify(servers) };
}

const NO_TEXT = { text_sha256: null, text_key: null, text_nonce: null, text_servers: null };

/** The row's columns from item JSON, each field checked, since another client wrote it (C§10). */
export function itemColumns({ item, extra }: ParsedItem, event: NostrEvent) {
  const o = item as unknown as Record<string, unknown>;
  const strings = Object.fromEntries(STRINGS.map((k) => [k, str(o[k])])) as Record<(typeof STRINGS)[number], string | null>;
  const raw = num(item.words);
  const words = raw !== null && raw >= 0 ? Math.round(raw) : null;
  const progress = num(item.progress) ?? 0;
  const text = textOf(item.text);
  return {
    ...strings, ...(text ?? NO_TEXT),
    url: item.url, saved_at: num(item.saved_at) ?? event.created_at, state: item.state === 'archived' ? 'archived' : 'unread',
    progress, words, title: strings.title, text_hash: text ? str(item.text_hash) : null, source_kind: str(item.source_kind) ?? 'web',
    extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
    position_word: wordReached({ progress, words }),
  };
}

function writeColumns(db: SqlDb, id: number, c: ReturnType<typeof itemColumns>, event: NostrEvent) {
  db.run(
    `UPDATE items SET url = ?, canonical = ?, title = ?, site = ?, byline = ?, saved_at = ?, state = ?, progress = ?, words = ?,
      lang = ?, text_sha256 = ?, text_key = ?, text_nonce = ?, text_servers = ?, text_hash = ?, hero = ?, source_kind = ?,
      source_ref = ?, audio_pref = ?, extra = ?, position_word = ?, event_id = ?, event_created_at = ?, published = 1, dirty = 0,
      remote_d = ?
     WHERE id = ?`,
    c.url, c.canonical, c.title, c.site, c.byline, c.saved_at, c.state, c.progress, c.words, c.lang, c.text_sha256, c.text_key,
    c.text_nonce, c.text_servers, c.text_hash, c.hero, c.source_kind, c.source_ref, c.audio_pref, c.extra, c.position_word,
    event.id, event.created_at, dOf(event), id,
  );
}

/** An event's d tag: the address a save was seen at (F5). */
const dOf = (event: NostrEvent) => event.tags.find((t) => t[0] === 'd')?.[1] ?? null;

/** Removes a row with its search entry and pending sends (Listen history goes by cascade). */
export function removeItem(db: SqlDb, id: number, owner: string, hash: string): void {
  db.run('DELETE FROM items_fts WHERE rowid = ?', id);
  db.run('DELETE FROM items WHERE id = ?', id);
  db.run("DELETE FROM outbox WHERE op = 'publish_item' AND signer = ? AND subject = ? AND state != 'sending'", owner, hash);
}

/** Whether any row still holds this hash's files (text, blocks, images are per hash, 4.1). */
export function hashInUse(db: SqlDb, hash: string): boolean {
  return !!db.get('SELECT 1 FROM items WHERE hash = ?', hash);
}

/** The losing text's blob, if this phone uploaded it and no row names it any more, is deleted from its servers (4.5). */
function retireBlob(db: SqlDb, now: number, owner: string, sha256: string, servers: string | null) {
  const mine = db.get<{ operator_at: number | null }>('SELECT operator_at FROM blobs WHERE sha256 = ? AND owner = ?', sha256, owner);
  if (!mine?.operator_at || db.get('SELECT 1 FROM items WHERE text_sha256 = ?', sha256)) return;
  const targets = servers ? (JSON.parse(servers) as string[]) : [];
  if (targets.length) enqueue(db, now, { op: 'delete_blob', signer: owner, subject: sha256, payload: { sha256 }, targets, lane: 'bulk' });
}

function insertRemote(db: SqlDb, now: number, owner: string, hash: string, c: ReturnType<typeof itemColumns>, event: NostrEvent) {
  const id = db.run(
    "INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, modified_at) VALUES (?, ?, ?, ?, 'unread', ?, 'sync', ?)",
    owner, hash, c.url, c.saved_at, c.text_sha256 ? 'remote' : 'queued', now,
  ).lastInsertRowId;
  writeColumns(db, id, c, event);
}

function takeRemote(db: SqlDb, now: number, owner: string, row: Row, c: ReturnType<typeof itemColumns>, event: NostrEvent, open: boolean): Applied {
  const textReplaced = !!row.text_sha256 && row.text_sha256 !== c.text_sha256;
  const heldWord = open && c.position_word !== row.position_word ? c.position_word : undefined;
  writeColumns(db, row.id, open ? { ...c, position_word: row.position_word } : c, event);
  if (row.text_sha256 !== c.text_sha256) {
    db.run('UPDATE items SET text_state = ?, fail_reason = NULL WHERE id = ?', c.text_sha256 ? 'remote' : 'queued', row.id);
    if (textReplaced) {
      db.run('DELETE FROM items_fts WHERE rowid = ?', row.id);
      retireBlob(db, now, owner, row.text_sha256!, row.text_servers);
    }
  }
  return { outcome: 'take', textReplaced, heldWord };
}

/**
 * Merges one verified, decrypted save of owner's into its row. openHash is the article open in the Reader,
 * whose remote position waits until the Reader closes.
 */
export function applyItem(db: SqlDb, now: number, owner: string, hash: string, event: NostrEvent, parsed: ParsedItem, openHash?: string | null): Applied {
  return db.tx(() => {
    const row = db.get<Row>('SELECT * FROM items WHERE owner = ? AND hash = ?', owner, hash);
    if (parsed.item.v !== 1) return future(db, owner, hash, event, row, parsed.item.v);
    const outcome = mergeItem(version(row), event);
    // a save deleted here stays deleted while its kind 5 waits to go out, which a read reaching back a day (F36) would
    // otherwise undo from a relay the kind 5 hasn't reached; once it is out, whatever the relays still hold is read again
    if (outcome === 'insert' && deletionWaiting(db, owner, hash)) return { outcome: 'ignored' };
    const c = itemColumns(parsed, event);
    if (outcome === 'insert') insertRemote(db, now, owner, hash, c, event);
    if (outcome === 'take') return takeRemote(db, now, owner, row!, c, event, hash === openHash);
    if (outcome === 'republish') {
      // The local change goes out above the remote: the publish is built at send time with created_at > this.
      db.run('UPDATE items SET event_created_at = MAX(COALESCE(event_created_at, 0), ?) WHERE id = ?', event.created_at, row!.id);
      enqueue(db, now, { op: 'publish_item', signer: owner, subject: hash, targets: writeRelays(db, owner) });
    }
    return { outcome };
  });
}

const deletionWaiting = (db: SqlDb, owner: string, hash: string) =>
  !!db.get("SELECT 1 FROM outbox WHERE op = 'delete_item' AND signer = ? AND subject = ? AND state IN ('held', 'queued', 'sending')", owner, hash);

function future(db: SqlDb, owner: string, hash: string, event: NostrEvent, row: Row | undefined, v: unknown): Applied {
  if (!(typeof v === 'number' && v > 1)) return { outcome: 'ignored' };
  const d = dOf(event) ?? ITEM_D_PREFIX + hash;
  const held = db.get<{ created_at: number }>('SELECT created_at FROM items_future WHERE owner = ? AND d = ?', owner, d);
  if (held && held.created_at >= event.created_at) return { outcome: 'ignored' };
  if (row && row.event_created_at !== null && row.event_created_at >= event.created_at) return { outcome: 'ignored' };
  db.run('INSERT OR REPLACE INTO items_future (owner, d, event_json, created_at) VALUES (?, ?, ?, ?)', owner, d, JSON.stringify(event), event.created_at);
  if (row) removeItem(db, row.id, owner, hash);
  return { outcome: 'future', textReplaced: !!row };
}

/** Applies a verified kind 5 of owner's; returns the hashes removed, whose files go once no row holds them. */
export function applyDeletion(db: SqlDb, owner: string, event: NostrEvent): string[] {
  return applyDeletions(db, owner, [event]);
}

/**
 * Applies verified kind 5s of owner's together; returns the hashes removed. A kind 5 removes what any older one
 * naming the same address does (deletionRemoves), so each address is applied once, at the newest kind 5 naming it,
 * and the saves' addresses are worked out once (addressIndex): the work grows with the addresses named and the saves
 * held, not with their product, so thousands of kind 5s can't hold the sync.
 */
export function applyDeletions(db: SqlDb, owner: string, events: NostrEvent[]): string[] {
  const named = new Map<string, number>();
  for (const e of events) for (const d of deletedDs(e, owner)) named.set(d, Math.max(named.get(d) ?? -Infinity, e.created_at));
  if (!named.size) return [];
  return db.tx(() => {
    const removed: string[] = [];
    const future = new Set(db.all<{ d: string }>('SELECT d FROM items_future WHERE owner = ?', owner).map((r) => r.d));
    // addresses are keyed from v1.10 (F5): each is found through the address a save is known at
    const at = addressIndex(db, owner);
    for (const [d, deletedAt] of named) {
      if (future.has(d)) db.run('DELETE FROM items_future WHERE owner = ? AND d = ? AND created_at <= ?', owner, d, deletedAt);
      for (const hash of at.get(d) ?? []) {
        const row = db.get<Row>('SELECT * FROM items WHERE owner = ? AND hash = ?', owner, hash);
        if (!row || !deletionRemoves(version(row)!, deletedAt)) continue;
        removeItem(db, row.id, owner, hash);
        removed.push(hash);
      }
    }
    return removed;
  });
}

export type Cursor = { since: number; backfilled: boolean };

export function getCursor(db: SqlDb, relay: string, stream: CursorStream, owner: string): Cursor | null {
  const r = db.get<{ since: number; backfilled: number }>('SELECT since, backfilled FROM sync_cursors WHERE relay = ? AND stream = ? AND owner = ?', relay, stream, owner);
  return r ? { since: r.since, backfilled: !!r.backfilled } : null;
}

export function setCursor(db: SqlDb, now: number, relay: string, stream: CursorStream, owner: string, since: number): void {
  db.run(
    `INSERT INTO sync_cursors (relay, stream, owner, since, backfilled, last_eose_at) VALUES (?, ?, ?, ?, 1, ?)
     ON CONFLICT (relay, stream, owner) DO UPDATE SET since = MAX(since, excluded.since), backfilled = 1, last_eose_at = excluded.last_eose_at`,
    relay, stream, owner, since, now,
  );
}

export function readRelays(db: SqlDb, owner: string): string[] {
  return db.all<{ url: string }>("SELECT url FROM relays WHERE owner = ? AND source != 'indexer' AND read = 1 ORDER BY rowid", owner).map((r) => r.url);
}

export type TextJob = { id: number; owner: string; hash: string; title: string | null; site: string | null; url: string;
  text_sha256: string; text_key: string; text_nonce: string; text_servers: string | null };

/** Texts still to fetch: the article being opened first, then unread newest first, then archived (4.5). */
export function textQueue(db: SqlDb, owner: string, first?: string | null): TextJob[] {
  return db.all<TextJob>(
    `SELECT id, owner, hash, title, site, url, text_sha256, text_key, text_nonce, text_servers FROM items
     WHERE owner = ? AND text_state = 'remote' AND text_sha256 IS NOT NULL AND pending_delete_at IS NULL
     ORDER BY hash = ? DESC, state = 'archived', saved_at DESC, id`,
    owner, first ?? '',
  );
}

/** A save's search entry: title, site, address and its spoken words (4.9), rowid = items.id. */
export function indexText(db: SqlDb, row: { id: number; title: string | null; site: string | null; url: string }, spoken: string): void {
  db.tx(() => {
    db.run('DELETE FROM items_fts WHERE rowid = ?', row.id);
    db.run('INSERT INTO items_fts (rowid, title, site, url, body) VALUES (?, ?, ?, ?, ?)', row.id, row.title ?? '', row.site ?? '', row.url, spoken);
  });
}

/** A fetched text is on the phone, and searchable. */
export function textCached(db: SqlDb, job: TextJob, spoken: string): void {
  db.tx(() => {
    db.run("UPDATE items SET text_state = 'cached', fail_reason = NULL WHERE id = ? AND text_sha256 = ?", job.id, job.text_sha256);
    indexText(db, job, spoken);
  });
}

/** No server had the blob: the Reader shows "Couldn't get the text" (4.5). */
export function textMissing(db: SqlDb, job: TextJob): void {
  db.run("UPDATE items SET text_state = 'failed', fail_reason = 'blob_missing' WHERE id = ? AND text_sha256 = ?", job.id, job.text_sha256);
}
