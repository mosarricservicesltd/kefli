// Pending parses (mobile spec 4.5 phase 7, 5.4): saves whose page hasn't been fetched and parsed yet, one at a time.
// A share made offline waits here keyed by its shared address; once parsed, an unpublished save is re-keyed by its
// final address and canonical (FD 80), joining the existing save if there is one (the repeat-save rule, G2), and
// then its text and save go out. A page that definitely can't be read is published without text.
import { withoutUserInfo } from '@kefli/protocol';
import type { SqlDb } from './db';
import { enqueue } from './outbox';
import { addressFits, fitSave, registerFirst, queueSends, queueText, type PageFields, type SaveTargets, type StagedBlob } from './saves';
import { writeRelays } from './lists';
import { waitsOnDelete } from './inbox';

export type Pending = {
  id: number; hash: string; url: string; shared_url: string | null; published: number; event_id: string | null; x_state: string | null;
  /**
   * When it was last tried and couldn't be had (F12), as pendingParses reads it; null for one never tried, which a
   * page that never answers can't fail yet (page.ts ANSWER_WAIT_SECONDS).
   */
  timed_out_at?: number | null;
  /**
   * The save's own time (C§4.1), as pendingParses reads it: how long an http one has waited for https, and any one
   * for its page to answer (page.ts).
   */
  saved_at?: number;
};

/**
 * Saves waiting for their parse: those that haven't timed out first, oldest first, then those that have, the one
 * that timed out longest ago first (F12). RULED: plain http pages come after all the rest. Each is fetched over https
 * alone (net/http overHttps), and an old site with no https can take the whole 20 s to fail there, so an import of
 * old bookmarks spends its slowest last; one refused there waits until it is three days old, then fails (page.ts
 * HTTPS_WAIT_SECONDS), and one that only cleartext could fetch fails at once (net/http Blocked). Any page that never
 * answers fails once its save is 14 days old and tried again (page.ts ANSWER_WAIT_SECONDS).
 */
export function pendingParses(db: SqlDb, owner: string): Pending[] {
  return db.all<Pending>(
    // the person's own saves before an import's, which may run to thousands and take days past the day's 20 MB (FD 117)
    `SELECT id, hash, url, shared_url, published, event_id, x_state, timed_out_at, saved_at FROM items WHERE owner = ? AND text_state = 'queued' AND pending_delete_at IS NULL
     ORDER BY lower(substr(url, 1, 7)) = 'http://', COALESCE(timed_out_at, 0), origin = 'import', saved_at, id`,
    owner,
  );
}

/** A pending parse whose page timed out, or whose X post X didn't answer, goes to the back of the queue (F12). */
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

/** Puts a parse's text on the phone for the save at hash (services/pending.ts), throwing when it can't. */
export type WriteText = (hash: string) => void;

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
 * A parse that succeeded: the row takes the article and its text goes out. A save not yet published goes with it
 * (upload, mirror, publish), the publish going without the text if the operator refuses it (send.ts). For a save
 * already published, as one another phone sent without text (C§4.1), the text is its only change: it is uploaded and
 * mirrored, and the save is published again naming it only once the operator and a mirror hold it, through the
 * mirror's republish (send.ts), since a refusal leaves it nothing new to send (C§4.2, v1.12). The row stays clean, so
 * a newer copy from another phone is taken over it, the text kept by the merge (data/sync.ts). RULED: the page's
 * fields are fitted under the event ceiling (data/saves fitSave), and a final address too long for the event isn't
 * adopted, so the save keeps the address it has, and its hash, with the text. Whichever it keeps, it keeps without
 * a user name and password (contract 4.3, ruling 8), as a browser's request or an older row may hold them. The text is
 * written (write) before the row says it has it, at the hash the save is kept at: a write that fails, as on a full
 * disk, throws, and the transaction takes the re-key back with everything else, so the save waits for its parse
 * rather than reading as cached with no text on the phone. RULED: a save whose page lands on the address of a save waiting
 * on its delete's Undo takes nothing yet, as a browser's request for such a save waits (services/inbox take): merged
 * into it, it was deleted with it when the toast closed, though the person never deleted it. It waits for its parse
 * at its own address, so once the delete is done it becomes a new save there, and once it is undone it joins that one.
 * The inbox's own parse lands at its request's address (protocol pairing canonicalOf), so this is a pending parse's.
 */
export function applyParsed(
  db: SqlDb, now: number, owner: string, p: Pending, parsed: Parsed, blob: StagedBlob, t: SaveTargets, write: WriteText,
): Applied {
  return db.tx(() => {
    // deleted while its page was fetched, or waiting on its delete's Undo: the row takes nothing, as one that joined
    // another save takes nothing, so the caller drops the staged text
    if (!live(db, p)) return { hash: p.hash, merged: true };
    const unpublished = !p.published && !p.event_id;
    const final = withoutUserInfo(parsed.url);
    const adopted = unpublished && addressFits(final);
    const page = fittedAt(adopted ? final : withoutUserInfo(p.url), parsed);
    const moves = adopted && parsed.hash !== p.hash;
    if (moves && waitsOnDelete(db, owner, parsed.hash)) return { hash: p.hash, merged: true };
    const where = moves ? rekey(db, now, owner, p, parsed.hash) : { hash: p.hash, merged: false };
    if (where.merged) return where;
    write(where.hash);
    // a save not yet published is marked changed for its sends; one already out stays clean (above)
    const changed = Number(unpublished);
    db.run(
      `UPDATE items SET url = ?, canonical = ?, title = ?, site = ?, byline = ?, lang = ?, hero = ?, words = ?, text_sha256 = ?,
        text_key = ?, text_nonce = ?, text_hash = ?, text_state = 'cached', fail_reason = NULL,
        modified_at = CASE WHEN ? THEN ? ELSE modified_at END, dirty = CASE WHEN ? THEN 1 ELSE dirty END WHERE id = ?`,
      page.url, page.canonical, page.title, page.site, page.byline, page.lang, page.hero, parsed.words,
      parsed.text.sha256, parsed.text.key, parsed.text.nonce, parsed.textHash, changed, now, changed, p.id,
    );
    const register = registerFirst(db, now, owner, t);
    if (unpublished) queueSends(db, now, owner, where.hash, blob, t, false, register);
    else queueText(db, now, owner, where.hash, blob, t, false, register);
    return where;
  });
}

/**
 * The link a save keeps as its row now holds it, without a user name and password (contract 4.3, ruling 8): read in
 * the transaction that writes it, so a newer copy merged while the page was fetched keeps its address.
 */
function linkKept(db: SqlDb, id: number): string {
  return withoutUserInfo(db.get<{ url: string }>('SELECT url FROM items WHERE id = ?', id)!.url);
}

/**
 * A page that can't be read (an HTTP error, not HTML, too large, not readable): the save goes out without text. One
 * already published, as another phone's without text, has nothing new to send, its text still null (C§4.2, v1.12):
 * only this phone notes that the page couldn't be read, so a phone that holds the text isn't asked to send it again.
 * RULED: either keeps its link without a user name and password, as a browser's request or an older row may hold
 * them: the link is what Original, Open in browser and the published item are given.
 */
export function applyFailed(db: SqlDb, now: number, owner: string, p: Pending, reason: string, t: SaveTargets): void {
  db.tx(() => {
    if (!live(db, p)) return;
    const url = linkKept(db, p.id);
    if (p.published || p.event_id) {
      db.run("UPDATE items SET url = ?, text_state = 'failed', fail_reason = ? WHERE id = ?", url, reason, p.id);
      return;
    }
    db.run("UPDATE items SET url = ?, text_state = 'failed', fail_reason = ?, modified_at = ?, dirty = 1 WHERE id = ?", url, reason, now, p.id);
    queueSends(db, now, owner, p.hash, null, t, false, registerFirst(db, now, owner, t));
  });
}

/**
 * An X post's check found its article (5.4): the save now parses that address, and is re-keyed by it (FD 80). RULED:
 * an article address too long for the save's event (data/saves addressFits) is no article Kefli can keep, as on the
 * sheet: the save keeps the post's address and is read as the post, so it is never left at one it can't publish. The
 * article's address is kept without a user name and password (contract 4.3, ruling 8).
 */
export function xFound(db: SqlDb, p: Pending, found: string): Pending {
  const article = withoutUserInfo(found);
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
