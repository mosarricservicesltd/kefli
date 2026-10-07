// The inbox (mobile spec 4.7, contract 4.4): browser saves arriving as gift wraps on the operator relay. Every
// wrap's outcome is kept in inbox_seen, so each is acted on once; failed_blob keeps its rumor in wrap_json and is
// tried again at each drain, since the subscription no longer reaches it. An accepted request becomes a save as a
// share does, through queueSave, so the repeat-save rule applies (contract 4.1); its sends go out at once.
//
// RULED: a request with HTML joins Saves as text_state 'fetching' ("Getting the text…") until its inbox blob is
// read; pending parses (phase 7) take only 'queued', so they never fetch the page over a browser's own HTML. The
// browser's label is kept in origin_device for the row's "From Chrome".
import { browserSavedAt, isXPost, itemHash, type SaveRequest } from '@shelf/protocol';
import type { SqlDb } from './db';
import { enqueue, release } from './outbox';
import { queueSave, type SaveTargets } from './saves';

export type Outcome =
  | 'created' | 'merged' | 'unarchived' | 'failed_blob' | 'failed_parse' | 'ignored_foreign' | 'ignored_version' | 'ignored_token';

/** An inbox blob expires 14 days after capture (C§4.4); the page is fetched instead. */
export const INBOX_BLOB_LIFE = 14 * 86_400;

export function seenOutcome(db: SqlDb, wrapId: string): Outcome | null {
  return db.get<{ outcome: Outcome }>('SELECT outcome FROM inbox_seen WHERE wrap_id = ?', wrapId)?.outcome ?? null;
}

export type Seen = { owner: string; outcome: Outcome; requestD?: string | null; device?: string | null; hash?: string | null; wrapJson?: string | null };

export function recordSeen(db: SqlDb, now: number, wrapId: string, s: Seen): void {
  db.run(
    `INSERT INTO inbox_seen (wrap_id, owner, seen_at, request_d, device, hash, wrap_json, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (wrap_id) DO UPDATE SET seen_at = excluded.seen_at, hash = COALESCE(excluded.hash, hash), wrap_json = excluded.wrap_json, outcome = excluded.outcome`,
    wrapId, s.owner, now, s.requestD ?? null, s.device ?? null, s.hash ?? null, s.wrapJson ?? null, s.outcome,
  );
}

/** Wraps whose blob couldn't be read yet, with the rumor and seal kept for the retry. */
export function failedBlobs(db: SqlDb, owner: string): { wrap_id: string; wrap_json: string }[] {
  return db.all("SELECT wrap_id, wrap_json FROM inbox_seen WHERE owner = ? AND outcome = 'failed_blob' AND wrap_json IS NOT NULL ORDER BY seen_at", owner);
}

/** The browser's name for the row: the brand before " on " in its label ("Chrome on a Windows laptop"). */
export function browserName(label: string): string {
  return label.split(/\s+on\s+/)[0].trim() || label;
}

/** Whether the request's HTML can still be read: there is some, the address isn't an X post, and the blob hasn't expired. */
export function usesBlob(r: SaveRequest, now: number): boolean {
  return r.html !== null && !isXPost(r.url) && now < r.captured_at + INBOX_BLOB_LIFE;
}

export type Admitted = { outcome: 'created' | 'merged' | 'unarchived'; hash: string; fetch: boolean };

/**
 * An accepted request becomes a save (C§4.4): created, an archived save un-archived, or matched. A save still
 * fetching its blob (a drain cut short) carries on fetching.
 */
export function admit(db: SqlDb, now: number, owner: string, r: SaveRequest, label: string, t: SaveTargets): Admitted {
  return db.tx(() => {
    const x = isXPost(r.url);
    const hash = x ? itemHash(r.url) : itemHash(r.url, r.canonical);
    const blob = usesBlob(r, now);
    const existing = db.get<{ state: string; text_state: string }>('SELECT state, text_state FROM items WHERE owner = ? AND hash = ?', owner, hash);
    // The extension's metadata stands until the parse; an X post is checked first, as a shared one is (5.4).
    const held = queueSave(db, now, {
      owner, hash, url: r.url, canonical: x ? null : r.canonical, title: x ? null : r.title, site: x ? null : r.site, byline: x ? null : r.byline,
      savedAt: browserSavedAt(r.captured_at, now), words: null, lang: x ? null : r.lang, hero: x ? null : r.hero,
      text: null, textHash: null, textState: 'queued', sharedUrl: r.url, origin: 'browser', xState: x ? 'pending' : null,
    }, null, t);
    release(db, held);
    if (existing) {
      return { outcome: existing.state === 'archived' ? 'unarchived' : 'merged', hash, fetch: blob && existing.text_state === 'fetching' };
    }
    db.run("UPDATE items SET origin_device = ?, text_state = ? WHERE owner = ? AND hash = ?", label, blob ? 'fetching' : 'queued', owner, hash);
    return { outcome: 'created', hash, fetch: blob };
  });
}

/** The blob is gone or never came: the save fetches its page as any pending save does. */
export function giveUpBlob(db: SqlDb, owner: string, hash: string): void {
  db.run("UPDATE items SET text_state = 'queued' WHERE owner = ? AND hash = ? AND text_state = 'fetching'", owner, hash);
}

/** A device's last save, for its row. */
export function noteDeviceSave(db: SqlDb, now: number, owner: string, token: string): void {
  db.run('UPDATE devices SET last_save_at = ? WHERE owner = ? AND token = ?', now, owner, token);
}

/** Only a wrap that created, un-archived or matched a save is deleted (C§4.4), with a kind 5 to the operator relay. */
export function queueDeleteWrap(db: SqlDb, now: number, owner: string, wrapId: string, operatorRelay: string): void {
  enqueue(db, now, { op: 'delete_wrap', signer: owner, subject: wrapId, payload: { id: wrapId }, targets: [operatorRelay], lane: 'bulk' });
}
