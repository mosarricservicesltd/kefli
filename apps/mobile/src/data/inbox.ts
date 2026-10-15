// The inbox (mobile spec 4.7, contract 4.4): browser saves arriving as gift wraps on the operator relay. Every
// wrap's outcome is kept in inbox_seen, so each is acted on once; failed_blob keeps its rumor in wrap_json and is
// tried again at each drain, since the subscription no longer reaches it. An accepted request becomes a save as a
// share does, through queueSave, so the repeat-save rule applies (contract 4.1); its sends go out at once. A wrap
// that made or matched a save is closed with a kind 5 for it and, from contract 1.12, a delete of its inbox blob, so
// a capture takes room in the library's storage on the operator's server only until the phone has taken it.
//
// RULED: a request with HTML joins Saves as text_state 'fetching' ("Getting the text…") until its inbox blob is
// read; pending parses (phase 7) take only 'queued', so they never fetch the page over a browser's own HTML. The
// browser's label is kept in origin_device for the row's "From Chrome".
import { browserSavedAt, isXPost, itemHash, withoutUserInfo, type SaveRequest } from '@kefli/protocol';
import type { SqlDb } from './db';
import type { NewItem } from './items';
import { enqueue, release } from './outbox';
import { queueSave, type SaveTargets } from './saves';

export type Outcome =
  | 'created' | 'merged' | 'unarchived' | 'failed_blob' | 'failed_parse' | 'ignored_foreign' | 'ignored_version' | 'ignored_token';

/** An inbox blob expires 14 days after capture (C§4.4); the page is fetched instead. */
export const INBOX_BLOB_LIFE = 14 * 86_400;

/**
 * A wrap's standing: the outcome it was given, so it is acted on once; 'waiting' for one a drain tried and couldn't
 * open or take yet, which the next drain tries again; null for one never tried.
 */
export function seenState(db: SqlDb, wrapId: string): Outcome | 'waiting' | null {
  return db.get<{ outcome: Outcome | 'waiting' }>('SELECT outcome FROM inbox_seen WHERE wrap_id = ?', wrapId)?.outcome ?? null;
}

/**
 * A wrap the phone couldn't open or take yet (F3) is noted as waiting, with when a drain first tried it, and is no
 * outcome (seenState): the next drain tries it again. Returns when the first try was, from which the
 * week it is waited for runs. Counted from its created_at, as it was, a wrap the phone first saw a week late (NIP-59
 * backdates it two days; a phone off for five) was filed as not ours at the first signer out of sight, and the save lost.
 */
export function waitingSince(db: SqlDb, now: number, wrapId: string, owner: string): number {
  db.run("INSERT INTO inbox_seen (wrap_id, owner, seen_at, outcome) VALUES (?, ?, ?, 'waiting') ON CONFLICT (wrap_id) DO NOTHING", wrapId, owner, now);
  return db.get<{ seen_at: number }>("SELECT seen_at FROM inbox_seen WHERE wrap_id = ? AND outcome = 'waiting'", wrapId)?.seen_at ?? now;
}

export type Seen = { owner: string; outcome: Outcome; requestD?: string | null; device?: string | null; hash?: string | null; wrapJson?: string | null };

export function recordSeen(db: SqlDb, now: number, wrapId: string, s: Seen): void {
  db.run(
    `INSERT INTO inbox_seen (wrap_id, owner, seen_at, request_d, device, hash, wrap_json, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (wrap_id) DO UPDATE SET seen_at = excluded.seen_at, hash = COALESCE(excluded.hash, hash), wrap_json = excluded.wrap_json, outcome = excluded.outcome`,
    wrapId, s.owner, now, s.requestD ?? null, s.device ?? null, s.hash ?? null, s.wrapJson ?? null, s.outcome,
  );
}

/**
 * How long the outcome of a wrap nothing was taken from is kept: two weeks, the week a wrap may hold the cursor
 * (WRAP_PATIENCE) and the two days a drain reads back past it (WRAP_LOOKBACK), with days to spare. Older, the wrap
 * is outside every drain's window, so its row only grew the table: by up to 28,800 rows a day under the most the
 * relay lets everyone together send one person (C§3.2), and a kind 5 for each 50 of them at Delete my data.
 */
export const SEEN_KEEP = 14 * 86_400;

/**
 * Forgets the outcomes kept longer than SEEN_KEEP of wraps nothing was taken from. A save's (created, merged,
 * un-archived), a blob still waited for and a wrap still waiting stay: a replay of a taken wrap must stay a repeat.
 */
export function forgetIgnored(db: SqlDb, now: number, owner: string): void {
  db.run(
    "DELETE FROM inbox_seen WHERE owner = ? AND seen_at < ? AND outcome IN ('ignored_foreign', 'ignored_token', 'ignored_version', 'failed_parse')",
    owner, now - SEEN_KEEP,
  );
}

/**
 * A deep read part way down an inbox window too large for one (services/inbox.ts): the until its next answer starts
 * at, when it began, and whether a wrap read since was left unopened. Kept with the settings, so a scan goes on where
 * it stopped after the app is closed: begun again at each open, one in a window too large for one open's reads never
 * ended, and the cursor never moved again.
 */
export type InboxScan = { until: number; startedAt: number; left: boolean };

const scanKey = (relay: string, owner: string) => `inbox.scan ${owner} ${relay}`;

export function inboxScan(db: SqlDb, relay: string, owner: string): InboxScan | null {
  const raw = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', scanKey(relay, owner))?.value;
  try {
    const s = JSON.parse(raw ?? 'null') as Partial<InboxScan> | null;
    return s && Number.isFinite(s.until) && Number.isFinite(s.startedAt) ? { until: s.until!, startedAt: s.startedAt!, left: s.left === true } : null;
  } catch {
    return null;
  }
}

export function keepInboxScan(db: SqlDb, relay: string, owner: string, scan: InboxScan): void {
  db.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', scanKey(relay, owner), JSON.stringify(scan));
}

export function endInboxScan(db: SqlDb, relay: string, owner: string): void {
  db.run('DELETE FROM settings WHERE key = ?', scanKey(relay, owner));
}

/** A wrap whose blob couldn't be read yet: the rumor and seal kept for the retry, and the save its drain made or matched. */
export type Kept = { wrap_id: string; wrap_json: string; hash: string | null };

export function failedBlobs(db: SqlDb, owner: string): Kept[] {
  return db.all("SELECT wrap_id, wrap_json, hash FROM inbox_seen WHERE owner = ? AND outcome = 'failed_blob' AND wrap_json IS NOT NULL ORDER BY seen_at", owner);
}

/** The save at this hash as the inbox finds it again: where its text is, and whether its delete waits on Undo (4.3). */
export type SaveState = { text_state: string; pending_delete_at: number | null };

export function savedState(db: SqlDb, owner: string, hash: string): SaveState | undefined {
  return db.get<SaveState>('SELECT text_state, pending_delete_at FROM items WHERE owner = ? AND hash = ?', owner, hash);
}

/** Whether the save at this hash waits on its delete's Undo (4.3), which a request for it waits for too. */
export function waitsOnDelete(db: SqlDb, owner: string, hash: string): boolean {
  return (savedState(db, owner, hash)?.pending_delete_at ?? null) !== null;
}

/** A request's save (C§4.3): an X post's by its own address, which is checked first, any other's by its address and canonical. */
export function requestHash(r: SaveRequest): string {
  return isXPost(r.url) ? itemHash(r.url) : itemHash(r.url, r.canonical);
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
 * What the extension read of the page, which stands until the parse. An X post's is the post's, not its article's,
 * which is checked first, as for a shared one (5.4), so none of it is kept.
 */
function readByBrowser(r: SaveRequest): Pick<NewItem, 'canonical' | 'title' | 'site' | 'byline' | 'lang' | 'hero' | 'xState'> {
  if (isXPost(r.url)) return { canonical: null, title: null, site: null, byline: null, lang: null, hero: null, xState: 'pending' };
  return { canonical: r.canonical, title: r.title, site: r.site, byline: r.byline, lang: r.lang, hero: r.hero, xState: null };
}

/**
 * An accepted request becomes a save (C§4.4): created, an archived save un-archived, or matched. A save still
 * fetching its blob (a drain cut short) carries on fetching. Its address is kept without a user name and password
 * (ruling 8), as the extension sends one from v1.12 and its hash never had them: a browser from before, or another
 * client, sent them, and they were kept on the row, shown on it and fetched with.
 */
export function admit(db: SqlDb, now: number, owner: string, r: SaveRequest, label: string, t: SaveTargets): Admitted {
  return db.tx(() => {
    const hash = requestHash(r);
    const blob = usesBlob(r, now);
    const url = withoutUserInfo(r.url);
    const existing = db.get<{ state: string; text_state: string }>('SELECT state, text_state FROM items WHERE owner = ? AND hash = ?', owner, hash);
    const held = queueSave(db, now, {
      owner, hash, url, ...readByBrowser(r), savedAt: browserSavedAt(r.captured_at, now), words: null,
      text: null, textHash: null, textState: 'queued', sharedUrl: url, origin: 'browser',
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

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Whether something other than a capture holds this blob: a save on this phone names it as its text, this phone
 * staged it, or a delete of it already waits in the outbox.
 */
function accountedFor(db: SqlDb, owner: string, sha256: string): boolean {
  return !!db.get(
    `SELECT 1 FROM items WHERE text_sha256 = ?
     UNION ALL SELECT 1 FROM blobs WHERE sha256 = ?
     UNION ALL SELECT 1 FROM outbox WHERE op = 'delete_blob' AND signer = ? AND subject = ? AND state IN ('held', 'queued', 'sending')
     LIMIT 1`,
    sha256, sha256, owner, sha256,
  );
}

/**
 * The request's inbox blob, deleted from the operator Blossom server with the user's key once its wrap has made or
 * matched a save (C§4.4, v1.12), which the server allows the library the blob counts against (C§5); a 404 counts as
 * done (4.3). It goes whether or not its HTML was read: an X post's is discarded, a repeat save needs none, and the
 * server's 14 days run from the upload, which a browser offline at capture makes later than captured_at.
 *
 * RULED: a user's delete removes every upload of the blob counted against the library (C§5), so a request naming a
 * save's own text, which only a faulty or hostile browser could send, would delete that text from the operator. Such
 * a blob is left alone, and so is an address that isn't a sha256, which the delete's authorisation can't name, so its
 * row would be tried again for ever.
 */
export function queueDeleteInboxBlob(db: SqlDb, now: number, owner: string, sha256: unknown, operatorBlossom: string, read?: CaptureRead): void {
  if (typeof sha256 !== 'string' || !SHA256.test(sha256) || accountedFor(db, owner, sha256)) return;
  enqueue(db, now, { op: 'delete_blob', signer: owner, subject: sha256, payload: { sha256, ...read }, targets: [operatorBlossom], lane: 'bulk' });
}

/**
 * A capture the phone read (RULED): its size, the room its delete gives back in the library's storage, and up, when
 * the phone found it on the operator. The delete's payload carries both, as a delete of the phone's own text carries
 * its size and when the operator took it, for the room reckoned once the operator confirms it (C§5). up is no earlier
 * than the browser's upload, so that room is never reckoned larger than it is. A capture the phone didn't read (a
 * repeat save's, an X post's, one gone or past its 14 days) has neither: once the operator confirms its delete with a
 * 2xx, it gives back a block, the least the operator counts a blob for (services/send.ts freedRoom). One the operator
 * no longer holds, deleted already or let go of once past its 14 days, is answered 404 and gives back none.
 */
export type CaptureRead = { size: number; up: number };

/**
 * A wrap that created, un-archived or matched a save, closed in one transaction (C§4.4): its outcome recorded, a kind
 * 5 for it queued for the operator relay, and with it the delete of its inbox blob, if the request names one.
 */
export function closeWrap(
  db: SqlDb, now: number, wrapId: string, s: Seen, operator: { relay: string; blossom: string }, html: SaveRequest['html'], read?: CaptureRead,
): void {
  db.tx(() => {
    recordSeen(db, now, wrapId, s);
    queueDeleteWrap(db, now, s.owner, wrapId, operator.relay);
    if (html) queueDeleteInboxBlob(db, now, s.owner, html.sha256, operator.blossom, read);
  });
}
