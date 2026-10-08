// The restore job (mobile spec 4.10, 5.3, contract 8): a jobs row that inbound sync carries out, since sync already
// reads the lists, every read relay's saves and deletions, and the texts from each save's servers or the 10063
// list. The card on Saves shows "N of M": M the live saves found after every reachable relay answered (it can
// grow), N those that are back.
//
// RULED: a save counts as back once its text is on the phone or known to be missing everywhere, since a row whose
// text is still to come can't be read yet. The job is done after a sync that left no text waiting; one that ends
// with texts unreachable leaves it running, and the card says it is paused until the network returns.
import type { SqlDb } from './db';

export type RestoreState = 'queued' | 'running' | 'done';
export type Restore = { state: RestoreState; found: number; total: number; doneAt: number | null };

/** The card holds "All N saves are back" this long, then leaves (prototype restoreCard). */
export const DONE_HOLD_S = 3;

const id = (owner: string) => `restore:${owner}`;

export function restoreOf(db: SqlDb, owner: string): Restore | null {
  const job = db.get<{ state: RestoreState; data: string | null }>("SELECT state, data FROM jobs WHERE id = ? AND kind = 'restore'", id(owner));
  if (!job) return null;
  const data = job.data ? (JSON.parse(job.data) as { doneAt?: number }) : {};
  const counts = db.get<{ total: number; waiting: number }>(
    `SELECT COUNT(*) AS total, SUM(CASE WHEN text_state IN ('remote', 'downloading') THEN 1 ELSE 0 END) AS waiting
     FROM items WHERE owner = ? AND pending_delete_at IS NULL`,
    owner,
  ) ?? { total: 0, waiting: 0 };
  return { state: job.state, found: counts.total - (counts.waiting ?? 0), total: counts.total, doneAt: data.doneAt ?? null };
}

/** The card shows while the job runs, and for DONE_HOLD_S after it finishes with saves to show. */
export function restoreCardShows(r: Restore | null, now: number): boolean {
  if (!r) return false;
  if (r.state !== 'done') return true;
  return r.total > 0 && r.doneAt !== null && now - r.doneAt < DONE_HOLD_S;
}

/** A queued restore starts with the next sync. */
export function beginRestore(db: SqlDb, now: number, owner: string): boolean {
  return db.run("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ? AND state = 'queued'", now, id(owner)).changes > 0
    || !!db.get("SELECT 1 FROM jobs WHERE id = ? AND state = 'running'", id(owner));
}

/** After a sync: done when no text is left waiting (texts a server didn't have count as settled). */
export function settleRestore(db: SqlDb, now: number, owner: string): RestoreState | null {
  const r = restoreOf(db, owner);
  if (!r || r.state === 'done') return r?.state ?? null;
  if (r.found < r.total) return r.state;
  db.run("UPDATE jobs SET state = 'done', updated_at = ?, data = ? WHERE id = ?", now, JSON.stringify({ owner, doneAt: now }), id(owner));
  return 'done';
}
