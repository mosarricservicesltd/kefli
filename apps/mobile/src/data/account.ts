// Backup space (FD 117, contract 5 and 6; mobile spec 5.4, 5.8; prototype adv-space-*, adv-full, adv-daily,
// adv-toolarge, share-full, share-daily). The library's figures from Kefli's server, the last that GET /account or a
// 413 quota or daily gave, kept on the phone; the saves whose text waits on the phone after Kefli's server refused it,
// read from blobs.last_error ('quota', 'daily', 'too_large', or 'http <status>' for other refusals, NULL once the
// operator holds the blob); and what Advanced and the Saved sheet show from them. Platform-free.
import { readFigures as figuresIn } from '@kefli/protocol';
import type { SqlDb } from './db';

/** A megabyte as Kefli's server counts it. */
export const MB = 1_048_576;
/**
 * The least a text counts for against the quota and the day (C§5): a disk block, which its file takes however few
 * bytes it holds. Kefli's server counts each blob so (store.Cost), in its figures too, and the phone the same way, from
 * this one figure: Backup space's Full, data/backup.ts's reckoning of the room left, and the room a deletion of a blob
 * whose size the phone doesn't know gives back (services/send.ts).
 */
export const BLOCK = 4096;
/** The defaults (C§5), which Backup space shows until Kefli's server has given the library's own. */
export const DEFAULT_QUOTA = 50 * MB;
export const DEFAULT_DAILY = 20 * MB;
const DAY = 86_400;

/** In bytes (C§6): the library's quota and what its blobs take of it, its daily limit and its last 24 hours' uploads. */
export type Figures = { quota: number; used: number; daily: number; today: number };

/**
 * The figures in an answer: GET /account's, a 413 quota or daily's body, or the four figures alone. Null unless all
 * four are whole numbers of bytes (the protocol's readFigures); a body in a version this client doesn't know is
 * refused (C§10).
 */
export function readFigures(body: unknown): Figures | null {
  const v = body && typeof body === 'object' ? (body as { v?: unknown }).v : undefined;
  return v === undefined || v === 1 ? figuresIn(body) : null;
}

/**
 * Keeps an answer's figures as the last the phone has for the identity (C§6), replacing any before. Only for an
 * identity on the phone, whose figures go with it. Returns whether it kept them; an answer without them changes nothing.
 */
export function recordFigures(db: SqlDb, owner: string, figures: unknown, now: number): boolean {
  const f = readFigures(figures);
  if (!f) return false;
  const r = db.run(
    `INSERT INTO account_figures (owner, quota, used, daily, today, at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM identities WHERE pubkey = ?)
     ON CONFLICT (owner) DO UPDATE SET quota = excluded.quota, used = excluded.used, daily = excluded.daily, today = excluded.today, at = excluded.at`,
    owner, f.quota, f.used, f.daily, f.today, now, owner,
  );
  return r.changes > 0;
}

/** The last figures held for the identity, with when they came, or null before the first answer. */
export function accountFigures(db: SqlDb, owner: string): (Figures & { at: number }) | null {
  return db.get<Figures & { at: number }>('SELECT quota, used, daily, today, at FROM account_figures WHERE owner = ?', owner) ?? null;
}

/** A not_registered answer: Kefli's server keeps nothing for this library, so the figures held for it go. */
export function forgetFigures(db: SqlDb, owner: string): void {
  db.run('DELETE FROM account_figures WHERE owner = ?', owner);
}

/**
 * The live saves whose text waits on this phone after Kefli's server refused it, by the reason it gave. RULED: quota,
 * daily and tooLarge count the saves whose text alone isn't backed up: a relay Kefli doesn't run holds the save's
 * newest event (data/backup.ts) and no server holds its text (a move's copy may name a mirror that holds it under the
 * old identity). Each is a save Advanced counts as not backed up whose text is only on this phone and whose link is
 * backed up, as the notices say; a save whose link isn't backed up yet is among those Kefli is still trying to back
 * up, whatever its text waits on. full and dailyRecent say how the space and the day's uploads stand, from every text
 * waiting: full while any waits on the space, which makes Backup space read Full, and dailyRecent counting those
 * refused for the day's uploads in the last 24 hours.
 */
export type Waiting = { quota: number; full: boolean; daily: number; dailyRecent: number; tooLarge: number };

export const NOTHING_WAITS: Waiting = { quota: 0, full: false, daily: 0, dailyRecent: 0, tooLarge: 0 };

type WaitingRow = { quota: number; full: number; daily: number; dailyRecent: number; tooLarge: number };

/** The save's text alone isn't backed up: its newest event is on a relay Kefli doesn't run, and no server holds the text. */
const TEXT_ALONE = 'i.dirty = 0 AND i.backed_event = i.event_id AND b.mirror_at IS NULL';

/**
 * The refusal's time is when it was written (blobs.refused_at); a refusal with no time, from before it was kept,
 * counts as recent.
 */
export function textsWaiting(db: SqlDb, owner: string, now: number): Waiting {
  const r = db.get<WaitingRow>(
    `SELECT COALESCE(SUM(b.last_error = 'quota' AND ${TEXT_ALONE}), 0) AS quota,
       COALESCE(SUM(b.last_error = 'quota'), 0) AS full,
       COALESCE(SUM(b.last_error = 'daily' AND ${TEXT_ALONE}), 0) AS daily,
       COALESCE(SUM(b.last_error = 'daily' AND (b.refused_at IS NULL OR b.refused_at > ?)), 0) AS dailyRecent,
       COALESCE(SUM(b.last_error = 'too_large' AND ${TEXT_ALONE}), 0) AS tooLarge
     FROM items i JOIN blobs b ON b.sha256 = i.text_sha256 AND b.owner = i.owner
     WHERE i.owner = ? AND i.pending_delete_at IS NULL AND b.operator_at IS NULL AND b.last_error IS NOT NULL`,
    now - DAY, owner,
  ) ?? { ...NOTHING_WAITS, full: 0 };
  return { quota: r.quota, full: r.full > 0, daily: r.daily, dailyRecent: r.dailyRecent, tooLarge: r.tooLarge };
}

/** Whether this save's own text waits on the phone for room, a 413 quota or daily, with no server holding it. */
export function waitsForRoom(db: SqlDb, owner: string, hash: string): boolean {
  return !!db.get(
    `SELECT 1 FROM items i JOIN blobs b ON b.sha256 = i.text_sha256 AND b.owner = i.owner
     WHERE i.owner = ? AND i.hash = ? AND b.operator_at IS NULL AND b.mirror_at IS NULL AND b.last_error IN ('quota', 'daily')`,
    owner, hash,
  );
}

/**
 * The saves whose text alone waits for room, and why (FD 117): 'quota' while any text waits on the space, else 'daily'
 * while one waits on a refusal for the day's uploads from the last 24 hours. RULED: n counts every save whose text
 * alone waits for room, the ones on the day's uploads included under 'quota', since a full space holds them back too,
 * and those refused for the day's uploads more than a day ago under 'daily', whose text still waits; so no save whose
 * text alone waits is left among the saves Kefli is still trying to back up while a room notice shows. With none, there
 * is no room notice, though the space may read full.
 */
export type Room = { why: 'quota' | 'daily'; n: number };

export function roomOf(w: Waiting): Room | null {
  const n = w.quota + w.daily;
  if (n === 0) return null;
  if (w.full) return { why: 'quota', n };
  return w.dailyRecent > 0 ? { why: 'daily', n } : null;
}

/** Advanced's one notice about saves not backed up: for room on the space (adv-full) or the day's uploads (adv-daily),
 * for the saves Kefli is still trying to back up (adv-notbacked), or for texts too long to back up (adv-toolarge). */
export type Notice = { kind: 'full' | 'daily' | 'trying' | 'toolarge'; n: number };

/**
 * The first notice that applies (FD 117): room, then the saves Kefli is still trying to back up, then texts too long
 * to back up. notBacked is every save not backed up (data/backup.ts), those whose text waits among them. trying, the
 * saves still to back up once those are left out (adv-notbacked's count), also decides whether the relays' note
 * speaks of "your other saves" (mobile spec 5.8), since a save whose text alone stays on the phone, waiting for room
 * or too long, is on every relay without it.
 */
export function backupNotice(w: Waiting, notBacked: number): { notice: Notice | null; trying: number } {
  const room = roomOf(w);
  const trying = Math.max(0, notBacked - (room ? room.n : 0) - w.tooLarge);
  if (room) return { notice: { kind: room.why === 'quota' ? 'full' : 'daily', n: room.n }, trying };
  if (trying > 0) return { notice: { kind: 'trying', n: trying }, trying };
  return { notice: w.tooLarge > 0 ? { kind: 'toolarge', n: w.tooLarge } : null, trying };
}

/** How the last check of Kefli's server went: under way, answered, failed, or answered that it keeps no library here. */
export type Check = 'checking' | 'ok' | 'failed' | 'unregistered';

/** The Backup space row (FD 117): figures, or, with none held, a check under way, offline, or a check that failed. */
export type Space =
  | { kind: 'figures'; used: number; quota: number; level: 'room' | 'nearly' | 'full' }
  | { kind: 'checking' | 'offline' | 'failed' };

/**
 * RULED: whether figures leave no room for any text: less than a block left, since each text counts a block at least
 * (BLOCK), so Kefli's server refuses every one there however short; at or over the quota among them. Read Full only at
 * the quota, a library a few bytes short of it read as having room while its every text stayed on the phone.
 */
const noRoom = (f: Pick<Figures, 'used' | 'quota'>): boolean => f.quota - f.used < BLOCK;

/** Full while a text waits on the space or no text has room (noRoom); nearly full from 90 %. */
function levelOf(f: Pick<Figures, 'used' | 'quota'>, full: boolean): Space {
  const level = full || noRoom(f) ? 'full' : f.used >= 0.9 * f.quota ? 'nearly' : 'room';
  return { kind: 'figures', used: f.used, quota: f.quota, level };
}

/**
 * The row's state: the last figures held, kept through a check offline or one that fails until a new answer comes;
 * with none, empty against the default quota once Kefli's server has answered that it keeps no library here, otherwise
 * offline, a failed check, or a check under way (adv-space-offline, adv-space-error, adv-space-loading).
 */
export function spaceOf(held: Pick<Figures, 'used' | 'quota'> | null, full: boolean, check: Check, online: boolean): Space {
  if (held) return levelOf(held, full);
  if (check === 'unregistered') return levelOf({ used: 0, quota: DEFAULT_QUOTA }, false);
  if (!online) return { kind: 'offline' };
  return { kind: check === 'failed' ? 'failed' : 'checking' };
}

/**
 * The Saved sheet's line (share-full, share-daily): full while Backup space would read Full, else daily while a text
 * waits on a refusal for the day's uploads from the last 24 hours, else the usual line.
 */
export function shareRoom(held: Pick<Figures, 'used' | 'quota'> | null, w: Waiting): 'full' | 'daily' | null {
  if (w.full || (held !== null && noRoom(held))) return 'full';
  return w.dailyRecent > 0 ? 'daily' : null;
}

/**
 * The figures held, while their leaving no room for a text (noRoom) may still stand. RULED: Kefli's server takes no
 * upload past the quota (but one of a blob the library holds already), so once one of this phone's uploads has gone
 * through since they came, a library they show without room has been given room by deleting, and they no longer tell
 * a share that its text stays here; Backup space shows them as they came until the next answer, and the next text
 * refused for the space makes the sheet say so again.
 */
function standingFigures(db: SqlDb, owner: string): (Figures & { at: number }) | null {
  const held = accountFigures(db, owner);
  if (!held || !noRoom(held)) return held;
  return db.get('SELECT 1 FROM blobs WHERE owner = ? AND operator_at > ?', owner, held.at) ? null : held;
}

/**
 * The line for a share: the library's, as shareRoom. RULED: a save brought back from Archive keeps the text it had, so
 * it takes a room line only while its own text waits for room; one whose text Kefli's server holds has the usual line.
 */
export function shareLine(db: SqlDb, owner: string, now: number, unarchived: string | null): 'full' | 'daily' | null {
  const room = shareRoom(standingFigures(db, owner), textsWaiting(db, owner, now));
  return room && unarchived && !waitsForRoom(db, owner, unarchived) ? null : room;
}
