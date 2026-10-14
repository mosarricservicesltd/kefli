// Pending parses (mobile spec 4.5 phase 7, 5.4): saves whose page hasn't been fetched and parsed yet, one at a time.
// A share made offline waits here keyed by its shared address; once parsed, an unpublished save is re-keyed by its
// final address and canonical (FD 80), joining the existing save if there is one (the repeat-save rule, G2), and
// then its text and save go out. A page that definitely can't be read is published without text.
import type { SqlDb } from './db';
import { enqueue } from './outbox';
import { addressFits, fitSave, registerFirst, queueSends, type PageFields, type SaveTargets, type StagedBlob } from './saves';
import { writeRelays } from './lists';

export type Pending = { id: number; hash: string; url: string; shared_url: string | null; published: number; event_id: string | null; x_state: string | null };

/**
 * Saves waiting for their parse: those that haven't timed out first, oldest first, then those that have, the one
 * that timed out longest ago first (F12). RULED: plain http pages come after all the rest. Release builds allow no
 * cleartext, so such a fetch fails at once, and that reads as offline, which stops the queue: one http save, first in
 * line, held every save behind it at every sync, for good.
 */
export function pendingParses(db: SqlDb, owner: string): Pending[] {
  return db.all<Pending>(
    `SELECT id, hash, url, shared_url, published, event_id, x_state FROM items WHERE owner = ? AND text_state = 'queued' AND pending_delete_at IS NULL
     ORDER BY lower(substr(url, 1, 7)) = 'http://', COALESCE(timed_out_at, 0), saved_at, id`,
    owner,
  );
}

/** A pending parse whose page timed out goes to the back of the queue (F12). */
export function timedOut(db: SqlDb, now: number, id: number): void {
  db.run('UPDATE items SET timed_out_at = ? WHERE id = ?', now, id);
}

export type Parsed = {
  /** The hash of the final address and canonical. */
  hash: string; url: string; canonical: string | null; title: string | null; site: string | null; byline: string | null;
  lang: string | null; hero: string | null; words: number;
  text: { sha256: string; key: string; nonce: string }; textHash: string;
};

export type Applied = { hash: string; merged: boolean };

/**
 * Moves an unpublished save to its final hash (FD 80): its row, search entry and cover record, so the cover
 * crossfades once without drawing again. If that hash is already a save, the provisional row goes and the existing
 * save is un-archived as a repeat save is (G2).
 */
function rekey(db: SqlDb, now: number, owner: string, from: Pending, to: string): Applied {
  const existing = db.get<{ id: number; state: string }>('SELECT id, state FROM items WHERE owner = ? AND hash = ?', owner, to);
  if (!existing) {
    db.run('UPDATE items SET hash = ? WHERE id = ?', to, from.id);
    db.run('INSERT OR IGNORE INTO cover_drawn (hash, surface, drawn_at) SELECT ?, surface, 0 FROM cover_drawn WHERE hash = ?', to, from.hash);
    return { hash: to, merged: false };
  }
  db.run('DELETE FROM items_fts WHERE rowid = ?', from.id);
  db.run('DELETE FROM items WHERE id = ?', from.id);
  if (existing.state === 'archived') {
    db.run("UPDATE items SET state = 'unread', saved_at = ?, modified_at = ?, dirty = 1 WHERE id = ?", now, now, existing.id);
    enqueue(db, now, { op: 'publish_item', signer: owner, subject: to, targets: writeRelays(db, owner) });
  }
  return { hash: to, merged: true };
}

/**
 * RULED: a waiting save is still the one its parse began for: its row is there, under the same hash, and not waiting
 * on a delete's Undo. A save deleted while its page was fetched had its text uploaded anyway, to servers no delete
 * would ever clear, its sends queued for a row that was gone, and its search entry written for it.
 */
function live(db: SqlDb, p: Pending): boolean {
  return !!db.get('SELECT 1 FROM items WHERE id = ? AND hash = ? AND pending_delete_at IS NULL', p.id, p.hash);
}

/** The page's fields fitted under the event ceiling (C§3.3) at this address; with every one shed if even that fails. */
function fittedAt(url: string, parsed: Parsed): PageFields {
  const fields = { url, canonical: parsed.canonical, title: parsed.title, site: parsed.site, byline: parsed.byline, lang: parsed.lang, hero: parsed.hero };
  return fitSave(fields) ?? { url, canonical: null, title: null, site: null, byline: null, lang: null, hero: null };
}

/**
 * A parse that succeeded: the row takes the article and its text goes out (upload, mirror, publish). RULED: the
 * page's fields are fitted under the event ceiling (data/saves fitSave), and a final address too long for the event
 * isn't adopted, so the save keeps the address it has, and its hash, with the text.
 */
export function applyParsed(db: SqlDb, now: number, owner: string, p: Pending, parsed: Parsed, blob: StagedBlob, t: SaveTargets): Applied {
  return db.tx(() => {
    // deleted while its page was fetched, or waiting on its delete's Undo: the row takes nothing, as one that joined
    // another save takes nothing, so the caller drops the staged text
    if (!live(db, p)) return { hash: p.hash, merged: true };
    const unpublished = !p.published && !p.event_id;
    const adopted = unpublished && addressFits(parsed.url);
    const page = fittedAt(adopted ? parsed.url : p.url, parsed);
    const where = adopted && parsed.hash !== p.hash ? rekey(db, now, owner, p, parsed.hash) : { hash: p.hash, merged: false };
    if (where.merged) return where;
    db.run(
      `UPDATE items SET url = ?, canonical = ?, title = ?, site = ?, byline = ?, lang = ?, hero = ?, words = ?, text_sha256 = ?,
        text_key = ?, text_nonce = ?, text_hash = ?, text_state = 'cached', fail_reason = NULL, modified_at = ?, dirty = 1 WHERE id = ?`,
      page.url, page.canonical, page.title, page.site, page.byline, page.lang, page.hero, parsed.words,
      parsed.text.sha256, parsed.text.key, parsed.text.nonce, parsed.textHash, now, p.id,
    );
    queueSends(db, now, owner, where.hash, blob, t, false, registerFirst(db, now, owner, t));
    return where;
  });
}

/** A page that can't be read (an HTTP error, not HTML, too large, not readable): the save goes out without text. */
export function applyFailed(db: SqlDb, now: number, owner: string, p: Pending, reason: string, t: SaveTargets): void {
  db.tx(() => {
    if (!live(db, p)) return;
    db.run("UPDATE items SET text_state = 'failed', fail_reason = ?, modified_at = ?, dirty = 1 WHERE id = ?", reason, now, p.id);
    queueSends(db, now, owner, p.hash, null, t, false, registerFirst(db, now, owner, t));
  });
}

/**
 * An X post's check found its article (5.4): the save now parses that address, and is re-keyed by it (FD 80). RULED:
 * an article address too long for the save's event (data/saves addressFits) is no article Kefli can keep, as on the
 * sheet: the save keeps the post's address and is read as the post, so it is never left at one it can't publish.
 */
export function xFound(db: SqlDb, p: Pending, article: string): Pending {
  if (!addressFits(article)) {
    db.run("UPDATE items SET x_state = 'none' WHERE id = ?", p.id);
    return { ...p, x_state: 'none' };
  }
  db.run('UPDATE items SET url = ?, x_state = NULL WHERE id = ?', article, p.id);
  return { ...p, url: article, x_state: null };
}

/** An X post with no article in it: the save goes out without text, and its row opens the post (5.4). */
export function xNoArticle(db: SqlDb, now: number, owner: string, p: Pending, t: SaveTargets): void {
  db.tx(() => {
    db.run("UPDATE items SET x_state = 'none' WHERE id = ?", p.id);
    applyFailed(db, now, owner, p, 'x_no_article', t);
  });
}
