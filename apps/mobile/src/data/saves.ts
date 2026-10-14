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
export type StagedBlob = { sha256: string; size: number; path: string };

/** The page's fields a save's event carries (C§4.1), beside its fixed ones. */
export type PageFields = { url: string; canonical: string | null; title: string | null; site: string | null; byline: string | null; lang: string | null; hero: string | null };

/**
 * RULED: the most a save's page fields may take, as the JSON its item holds. NIP-44 pads an item over 8 KB to the
 * next 2 KB, so 10,240 bytes of item is the most whose event stays under the 16 KB ceiling (C§3.3); this leaves 1 KB
 * of that for the rest (the text's key and servers, the hash, the reading position). A save over it was refused by
 * its own buildItemEvent at every send, so it never left the phone, and nothing said so.
 */
export const PAGE_FIELDS_BYTES = 9_216;

/** UTF-8 bytes of s as JSON writes it, null as null. */
function jsonBytes(s: string | null): number {
  const j = JSON.stringify(s);
  let n = 0;
  for (let i = 0; i < j.length; i++) {
    const c = j.charCodeAt(i);
    if (c < 0x80) {
      n += 1;
    } else if (c < 0x800) {
      n += 2;
    } else if (c >= 0xd800 && c < 0xdc00) {
      // a pair (JSON.stringify writes a lone half as \u escapes)
      n += 4;
      i++;
    } else {
      n += 3;
    }
  }
  return n;
}

const fieldBytes = (f: PageFields): number =>
  jsonBytes(f.url) + jsonBytes(f.canonical) + jsonBytes(f.title) + jsonBytes(f.site) + jsonBytes(f.byline) + jsonBytes(f.lang) + jsonBytes(f.hero);

/** s cut to at most n characters with an ellipsis, never between the halves of a surrogate pair. */
function cut(s: string | null, n: number): string | null {
  if (s === null || s.length <= n) return s;
  const end = (s.charCodeAt(n - 2) & 0xfc00) === 0xd800 ? n - 2 : n - 1;
  return `${s.slice(0, end)}…`;
}

/** What goes, in order, from a save too large for its event: the picture, the canonical, then the words get shorter. */
const SHEDS: ((f: PageFields) => Partial<PageFields>)[] = [
  () => ({ hero: null }),
  () => ({ canonical: null }),
  (f) => ({ title: cut(f.title, 300), byline: cut(f.byline, 100), site: cut(f.site, 100), lang: f.lang && f.lang.length > 35 ? null : f.lang }),
  () => ({ byline: null, site: null, lang: null }),
  (f) => ({ title: cut(f.title, 80) }),
  () => ({ title: null }),
];

/**
 * A save's page fields fitted under the event ceiling (C§3.3), or null when its address alone won't fit. A save that
 * fits is left as it is; one that doesn't loses its hero, then its canonical (its hash is made already), then has its
 * title, byline and site cut down, then loses them.
 */
export function fitSave<T extends PageFields>(f: T): T | null {
  let fitted = f;
  for (const shed of SHEDS) {
    if (fieldBytes(fitted) <= PAGE_FIELDS_BYTES) return fitted;
    fitted = { ...fitted, ...shed(fitted) };
  }
  return fieldBytes(fitted) <= PAGE_FIELDS_BYTES ? fitted : null;
}

/** True when a save of this address alone fits its event: one that doesn't can never be published. */
export const addressFits = (url: string): boolean =>
  fitSave({ url, canonical: null, title: null, site: null, byline: null, lang: null, hero: null }) !== null;

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
 * A save's sends (4.3): the blob's upload and mirror if it has text, then its publish to every write relay (C§3.1),
 * each after the one it needs. held: the share sheet's rows wait for it to close without Undo.
 */
export function queueSends(db: SqlDb, now: number, owner: string, hash: string, blob: StagedBlob | null, t: SaveTargets, held: boolean, register: number | null): number[] {
  const rows: number[] = [];
  let upload: number | null = null;
  if (blob) {
    db.run('INSERT OR REPLACE INTO blobs (sha256, hash, kind, staged_path, size, owner) VALUES (?, ?, ?, ?, ?, ?)', blob.sha256, hash, 'text', blob.path, blob.size, owner);
    upload = enqueue(db, now, { op: 'upload_blob', signer: owner, subject: blob.sha256, payload: { sha256: blob.sha256 }, targets: [t.blossom], dependsOn: register, held });
    rows.push(upload);
    rows.push(enqueue(db, now, { op: 'mirror_blob', signer: owner, subject: blob.sha256, payload: { sha256: blob.sha256 }, targets: [t.mirror], dependsOn: upload, held }));
  }
  rows.push(enqueue(db, now, { op: 'publish_item', signer: owner, subject: hash, targets: publishTargets(db, owner, t), dependsOn: upload ?? register, held }));
  return rows;
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

/**
 * Imported links (FD 82, C§4.6): pending saves at the import time, each fetched and parsed as an offline share is.
 * One transaction for them all: a commit each, every one synced to storage, held the app for 43 s over 10,000.
 */
export function queueImported(db: SqlDb, owner: string, links: string[], at: number, t: SaveTargets): number {
  return db.tx(() => {
    let n = 0;
    for (const url of links) {
      const hash = itemHashOf(url);
      // a link too long for its event could never be published: findBookmarks leaves it out of the count too
      if (!hash || !addressFits(url) || db.get('SELECT 1 FROM items WHERE owner = ? AND hash = ?', owner, hash)) continue;
      queueSave(db, at, {
        owner, hash, url, canonical: null, title: null, site: null, byline: null, savedAt: at, words: null, lang: null, hero: null,
        text: null, textHash: null, textState: 'queued', sharedUrl: url, origin: 'import',
      }, null, t);
      n++;
    }
    return n;
  });
}

function itemHashOf(url: string): string | null {
  try {
    return itemHash(url);
  } catch {
    return null;
  }
}
