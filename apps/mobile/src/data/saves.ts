// Queues a save (mobile spec 4.3, 5.4): the item row, its staged blob, and the outbox rows, held until the
// share sheet closes without Undo. register runs first if this identity hasn't registered; the upload follows
// it, the mirror follows the upload, and the publish follows the upload (or register, with no text).
import { itemHash } from '@kefli/protocol';
import type { SqlDb } from './db';
import { insertItem, type NewItem } from './items';
import { enqueue, undo } from './outbox';
import { hasList, indexerRelays, listsSettled, writeRelays } from './lists';
import { KEEP_COPIES, getSetting } from './settings';

/** interim: where a save goes while a nostr user's lists aren't known yet, the operator relay and relays[0] (4.6). */
export type SaveTargets = { api: string; blossom: string; mirror: string; interim?: string[] };

export const interimRelays = (d: { operator: { relay: string }; relays: string[] }): string[] => [d.operator.relay, d.relays[0]].filter(Boolean);

/**
 * A save's relays (4.6, F4): the write relays once the lists are known; before that, with Keep backup copies on,
 * the interim relays, and with it off none, so the save waits until the lists settle and give it their relays.
 */
function publishTargets(db: SqlDb, owner: string, t: SaveTargets): string[] {
  if (listsSettled(db, owner)) return writeRelays(db, owner);
  return getSetting(db, KEEP_COPIES) === '0' ? [] : t.interim ?? [];
}
export type StagedBlob = {
  sha256: string; size: number; path: string;
  /** A mirror that already holds the blob, as the one a move's source backed it up to (C§4.8, v1.12). */
  mirror?: string | null;
};

export function ensureIdentityRow(db: SqlDb, now: number, pubkey: string, origin: string, hasRecovery: boolean, provider: 'local' | 'nip55' | 'nip46' = 'local'): void {
  db.run(
    "INSERT OR IGNORE INTO identities (pubkey, provider, role, origin, has_recovery, created_at) VALUES (?, ?, 'active', ?, ?, ?)",
    pubkey, provider, origin, hasRecovery ? 1 : 0, now,
  );
}

/**
 * A repeat save (contract 4.1, flow decision 89): an archived save is un-archived with saved_at set to the new
 * save's time and republished; an unread one is left unchanged. The existing text is kept. Returns the held rows.
 */
function repeatSave(db: SqlDb, now: number, item: NewItem, register: number | null): number[] {
  const existing = db.get<{ state: string }>('SELECT state FROM items WHERE owner = ? AND hash = ?', item.owner, item.hash);
  if (existing?.state !== 'archived') return [];
  db.run("UPDATE items SET state = 'unread', saved_at = ?, modified_at = ?, dirty = 1 WHERE owner = ? AND hash = ?", item.savedAt, now, item.owner, item.hash);
  return [enqueue(db, now, { op: 'publish_item', signer: item.owner, subject: item.hash, targets: writeRelays(db, item.owner), dependsOn: register, held: true })];
}

function registerFirst(db: SqlDb, now: number, owner: string, t: SaveTargets): number | null {
  const registered = db.get<{ registered_at: number | null }>('SELECT registered_at FROM identities WHERE pubkey = ?', owner)?.registered_at;
  // register isn't Undo-able: it is queued at once and merges with any other pending registration.
  return registered ? null : enqueue(db, now, { op: 'register', signer: owner, subject: owner, targets: [`${t.api}/register`] });
}

/**
 * A text's sends (4.3): its blob staged, the upload to the operator, and the mirror after it, to the mirror that already
 * holds the blob when there is one. Returns the upload's row, then the mirror's.
 */
export function queueText(db: SqlDb, now: number, owner: string, hash: string, blob: StagedBlob, t: SaveTargets, held: boolean, register: number | null): number[] {
  const mirror = blob.mirror ?? null;
  db.run('INSERT OR REPLACE INTO blobs (sha256, hash, kind, staged_path, size, owner, mirror_at, mirror_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    blob.sha256, hash, 'text', blob.path, blob.size, owner, mirror ? now : null, mirror);
  const upload = enqueue(db, now, { op: 'upload_blob', signer: owner, subject: blob.sha256, payload: { sha256: blob.sha256 }, targets: [t.blossom], dependsOn: register, held });
  return [upload, enqueue(db, now, { op: 'mirror_blob', signer: owner, subject: blob.sha256, payload: { sha256: blob.sha256 }, targets: [mirror ?? t.mirror], dependsOn: upload, held })];
}

/**
 * A save's sends (4.3): the text's upload and mirror if it has text, then its publish to every write relay (C§3.1),
 * after the upload, which a refusal of the text releases (send.ts, v1.12). held: the share sheet's rows wait for it to
 * close without Undo.
 */
export function queueSends(db: SqlDb, now: number, owner: string, hash: string, blob: StagedBlob | null, t: SaveTargets, held: boolean, register: number | null): number[] {
  const rows = blob ? queueText(db, now, owner, hash, blob, t, held, register) : [];
  rows.push(enqueue(db, now, { op: 'publish_item', signer: owner, subject: hash, targets: publishTargets(db, owner, t), dependsOn: rows[0] ?? register, held }));
  return rows;
}

/** Whether any of owner's saves names this text, one waiting on its delete's Undo included. */
export function namesText(db: SqlDb, owner: string, sha256: string): boolean {
  return !!db.get('SELECT 1 FROM items WHERE owner = ? AND text_sha256 = ?', owner, sha256);
}

/** A text no save of the owner's needs sent any more: its upload and mirror leave the outbox, one under way too (C§4.1). */
export function withdrawText(db: SqlDb, owner: string, sha256: string): void {
  db.run("DELETE FROM outbox WHERE signer = ? AND subject = ? AND op IN ('upload_blob', 'mirror_blob')", owner, sha256);
}

export type BlobRow = { size: number | null; operator_at: number | null; mirror_at: number | null; mirror_url: string | null };

/** This phone's blob of a text, staged here for owner: its size, and when the operator and a mirror took it. */
export const blobRow = (db: SqlDb, owner: string, sha256: string) =>
  db.get<BlobRow>('SELECT size, operator_at, mirror_at, mirror_url FROM blobs WHERE sha256 = ? AND owner = ?', sha256, owner);

/**
 * Where a text no save names is deleted from (4.3): every server the save named and the mirror this phone's upload
 * reached. The operator is among them once this phone's upload got there, since the upload records it (send.ts, F33).
 */
export function textHolders(named: string | null, blob: BlobRow | undefined): string[] {
  const mirror = blob?.mirror_at && blob.mirror_url ? [blob.mirror_url] : [];
  return [...new Set([...(named ? (JSON.parse(named) as string[]) : []), ...mirror])];
}

/**
 * A blob deletion's payload: the hash, and when this phone knows them, the blob's size and when the operator took it,
 * so the operator's confirmation adds to the room the last known figures leave (C§5, data/backup.ts).
 */
export function blobDeletion(sha256: string, blob: BlobRow | undefined): { sha256: string; size?: number; up?: number } {
  return { sha256, ...(blob?.size ? { size: blob.size } : {}), ...(blob?.operator_at ? { up: blob.operator_at } : {}) };
}

/**
 * A blob's deletion from these servers (4.3), after the row dependsOn names if any. It joins one still waiting for the
 * same blob, so a deletion queued for one server never drops another's, as when a mirror's copy lands after the save
 * went (C§4.1); a deletion already under way takes this one's servers when it ends (finish's supersede).
 */
export function queueBlobDelete(db: SqlDb, now: number, owner: string, sha256: string, targets: string[], payload: unknown, dependsOn: number | null = null): void {
  const waiting = db.get<{ id: number }>("SELECT id FROM outbox WHERE op = 'delete_blob' AND signer = ? AND subject = ? AND state IN ('held', 'queued')", owner, sha256);
  if (!waiting) {
    enqueue(db, now, { op: 'delete_blob', signer: owner, subject: sha256, payload, targets, dependsOn, lane: 'bulk' });
    return;
  }
  for (const t of targets) db.run("INSERT OR IGNORE INTO outbox_targets (outbox_id, target, state, attempts, next_at) VALUES (?, ?, 'pending', 0, ?)", waiting.id, t, now);
}

/**
 * A dead row back in the queue, its targets due now; or, when a pending row for the same change already carries it,
 * gone. detach: it waited on a row that died, and goes without it. Returns whether it was kept.
 */
function revive(db: SqlDb, now: number, r: { id: number; op: string; signer: string; subject: string }, detach: boolean): boolean {
  if (db.get("SELECT 1 FROM outbox WHERE op = ? AND signer = ? AND subject = ? AND state IN ('held', 'queued')", r.op, r.signer, r.subject)) {
    db.run('DELETE FROM outbox WHERE id = ?', r.id);
    return false;
  }
  db.run(`UPDATE outbox SET state = 'queued'${detach ? ', depends_on = NULL' : ''} WHERE id = ?`, r.id);
  db.run("UPDATE outbox_targets SET state = 'pending', next_at = ? WHERE outbox_id = ? AND state != 'ok'", now, r.id);
  return true;
}

/**
 * Saves the code before v1.12 held back (C§4.2; 11.1, item 2), put back at start: it finds nothing once they have
 * gone. Returns how many rows it put back.
 * - An upload the operator refused with a 4xx went dead and took the save's publish with it, so the save never reached
 *   a relay. Its publish goes now, without the text, and the upload and its mirror are tried again, as any refused text
 *   is; a text refused for good since, over 8 MB, stays as it is.
 * - A publish that died with an upload which failed for good on the phone, its staged text gone, goes without it.
 * - An upload a 413 sent a day off held its save back for that day; it is tried now, and its refusal releases the save.
 */
export function reviveRefused(db: SqlDb, now: number): number {
  return db.tx(() => reviveUploads(db, now) + revivePublishes(db, now) + wakeDayWaits(db, now));
}

function reviveUploads(db: SqlDb, now: number): number {
  const dead = db.all<{ id: number; signer: string; subject: string }>(
    `SELECT o.id, o.signer, o.subject FROM outbox o JOIN blobs b ON b.sha256 = o.subject AND b.owner = o.signer
     WHERE o.op = 'upload_blob' AND o.state = 'dead' AND b.operator_at IS NULL AND b.last_error IS NULL
       AND EXISTS (SELECT 1 FROM outbox_targets t WHERE t.outbox_id = o.id AND t.last_error LIKE 'HTTP 4%')`);
  for (const u of dead) {
    // read before the upload is touched: a deleted row's dependents lose their link to it
    const after = db.all<{ id: number; op: string; subject: string }>(
      "SELECT id, op, subject FROM outbox WHERE depends_on = ? AND state = 'dead' AND op IN ('publish_item', 'mirror_blob')", u.id);
    const kept = revive(db, now, { ...u, op: 'upload_blob' }, false);
    for (const d of after) {
      if (d.op === 'publish_item' || kept) revive(db, now, { ...d, signer: u.signer }, d.op === 'publish_item');
      else db.run('DELETE FROM outbox WHERE id = ?', d.id);
    }
  }
  return dead.length;
}

/** Publishes dead beside an upload refused on the phone: from v1.12 such an upload releases its save first (send.ts). */
function revivePublishes(db: SqlDb, now: number): number {
  const dead = db.all<{ id: number; signer: string; subject: string }>(
    `SELECT p.id, p.signer, p.subject FROM outbox p JOIN outbox u ON u.id = p.depends_on
     WHERE p.op = 'publish_item' AND p.state = 'dead' AND u.op = 'upload_blob' AND u.state = 'dead'
       AND EXISTS (SELECT 1 FROM outbox_targets t WHERE t.outbox_id = u.id AND t.state = 'rejected')`);
  for (const p of dead) revive(db, now, { ...p, op: 'publish_item' }, true);
  return dead.length;
}

/** The longest wait the outbox sets an upload short of a refusal (backoff, 4.3); a longer one is a 413's day. */
const LONGEST_BACKOFF = 3600;

/**
 * Uploads a 413 sent a day off before v1.12: their wait is longer than any backoff, and their blob has no reason,
 * which v1.12 records with every refusal it waits a day on (send.ts). They fall due now.
 */
function wakeDayWaits(db: SqlDb, now: number): number {
  return db.run(
    `UPDATE outbox_targets SET next_at = ? WHERE state = 'pending' AND next_at > ? AND outbox_id IN (
       SELECT o.id FROM outbox o JOIN blobs b ON b.sha256 = o.subject AND b.owner = o.signer
       WHERE o.op = 'upload_blob' AND o.state = 'queued' AND b.operator_at IS NULL AND b.last_error IS NULL)`,
    now, now + LONGEST_BACKOFF,
  ).changes;
}

/** The texts no save names: the saves' texts read once into a set (NOT IN), since items has no index on text_sha256. */
const ORPHANS = "FROM blobs WHERE kind = 'text' AND sha256 NOT IN (SELECT text_sha256 FROM items WHERE text_sha256 IS NOT NULL)";

/**
 * Blobs no save names any more, a deleted save's or one whose text another phone's replaced: their rows go, and the
 * staged files they kept are returned for the caller to remove (4.1). An upload still under way for one finds no save
 * naming it and deletes it from the server it reached (send.ts). It runs after every outbox run, so it reads the saves
 * once rather than once for each text.
 */
export function orphanBlobs(db: SqlDb): string[] {
  return db.tx(() => {
    const rows = db.all<{ staged_path: string | null }>(`SELECT staged_path ${ORPHANS}`);
    if (rows.length) db.run(`DELETE ${ORPHANS}`);
    return rows.map((r) => r.staged_path).filter((p): p is string => !!p);
  });
}


/**
 * Returns the held outbox rows, for release when the sheet closes (or undo). A save whose page couldn't be fetched
 * yet (offline, text_state queued) is kept on the phone only: its publish waits for the parse (4.3), so it can still
 * be re-keyed by its final address (FD 80).
 */
export function queueSave(db: SqlDb, now: number, item: NewItem, blob: StagedBlob | null, t: SaveTargets): number[] {
  return db.tx(() => {
    const register = registerFirst(db, now, item.owner, t);
    if (db.get('SELECT 1 FROM items WHERE owner = ? AND hash = ?', item.owner, item.hash)) return repeatSave(db, now, item, register);
    insertItem(db, now, item);
    const held = item.textState === 'queued' ? [] : queueSends(db, now, item.owner, item.hash, blob, t, true, register);
    // The lists go out on the first save (C§3.1): the 10002 to the write relays and the indexer, the 10063 to the
    // write relays. Not Undo-able: an identity keeps its lists whether or not this save stays.
    // A nostr user's lists go out only once known, so a failed read never replaces the list their apps share (4.6).
    if (!hasList(db, item.owner, 10002) && listsSettled(db, item.owner)) {
      const relays = writeRelays(db, item.owner);
      enqueue(db, now, { op: 'publish_lists', signer: item.owner, subject: item.owner, targets: [...new Set([...relays, ...indexerRelays(db, item.owner)])], dependsOn: register });
    }
    return held;
  });
}

export { registerFirst };

/** What a share found before it saved: nothing (a new save), or the save already here and its state. */
export type Prior = { state: 'unread' | 'archived'; saved_at: number; dirty: number; modified_at: number | null } | null;

export function priorOf(db: SqlDb, owner: string, hash: string): Prior {
  return db.get<NonNullable<Prior>>('SELECT state, saved_at, dirty, modified_at FROM items WHERE owner = ? AND hash = ? AND pending_delete_at IS NULL', owner, hash) ?? null;
}

/**
 * Undo on the Saved sheet (mobile spec 5.4, 4.3): the held rows go. A new save goes with its search entry and staged
 * blob, whose paths are returned for the caller to delete with the save's files; an archived save the share brought
 * back is archived again as it was. An unread save shared again changed nothing, so there is nothing to undo.
 */
export function undoSave(db: SqlDb, owner: string, hash: string, held: number[], prior: Prior): { staged: string[] } {
  return db.tx(() => {
    undo(db, held);
    if (prior) {
      db.run('UPDATE items SET state = ?, saved_at = ?, dirty = ?, modified_at = ? WHERE owner = ? AND hash = ?', prior.state, prior.saved_at, prior.dirty, prior.modified_at, owner, hash);
      return { staged: [] };
    }
    const row = db.get<{ id: number; text_sha256: string | null }>('SELECT id, text_sha256 FROM items WHERE owner = ? AND hash = ?', owner, hash);
    if (!row) return { staged: [] };
    const staged = row.text_sha256
      ? db.all<{ staged_path: string | null }>('SELECT staged_path FROM blobs WHERE sha256 = ? AND owner = ?', row.text_sha256, owner).map((b) => b.staged_path).filter((p): p is string => !!p)
      : [];
    if (row.text_sha256) db.run('DELETE FROM blobs WHERE sha256 = ? AND owner = ?', row.text_sha256, owner);
    db.run('DELETE FROM items_fts WHERE rowid = ?', row.id);
    db.run('DELETE FROM cover_drawn WHERE hash = ?', hash);
    db.run('DELETE FROM items WHERE id = ?', row.id);
    return { staged };
  });
}

/** Imported links (FD 82, C§4.6): pending saves at the import time, each fetched and parsed as an offline share is. */
export function queueImported(db: SqlDb, owner: string, links: string[], at: number, t: SaveTargets): number {
  let n = 0;
  for (const url of links) {
    const hash = itemHashOf(url);
    if (!hash || db.get('SELECT 1 FROM items WHERE owner = ? AND hash = ?', owner, hash)) continue;
    queueSave(db, at, {
      owner, hash, url, canonical: null, title: null, site: null, byline: null, savedAt: at, words: null, lang: null, hero: null,
      text: null, textHash: null, textState: 'queued', sharedUrl: url, origin: 'import',
    }, null, t);
    n++;
  }
  return n;
}

function itemHashOf(url: string): string | null {
  try {
    return itemHash(url);
  } catch {
    return null;
  }
}
