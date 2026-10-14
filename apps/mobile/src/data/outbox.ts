// The outbox (mobile spec 4.3): every write that leaves the phone, as a row per (op, signer, subject) with
// one target per relay or server. Platform-free: the network is the sender's (src/services/send.ts).
//
// - A new change merges into a held or queued row. A change from an Undo-able action merging into a queued row
//   turns it held with was_queued set, and any change merging into a held row sets was_queued too, so Undo
//   keeps it. A change made while a row is sending waits in a new row, which replaces it when the attempt ends.
// - Undo deletes the held rows, except that a was_queued row goes back to queued.
// - Each target retries on its own, from 30 s doubling to an hour (a sender may ask for a set wait instead).
// - A row succeeds as soon as any target is ok, which releases its dependents; it is deleted once every target
//   is ok, rejected or gave_up. A row whose targets all finish without success goes dead, and so do the rows
//   that depend on it.
import type { Param, SqlDb } from './db';

export type Lane = 'interactive' | 'bulk';
export type RowState = 'held' | 'queued' | 'sending' | 'dead';
export type TargetState = 'pending' | 'ok' | 'rejected' | 'gave_up';

export type OutboxRow = {
  id: number; op: string; signer: string; subject: string; payload: string | null; depends_on: number | null;
  lane: Lane; not_before: number | null; created_at: number; state: RowState; was_queued: number;
};
export type OutboxTarget = {
  outbox_id: number; target: string; state: TargetState; attempts: number; next_at: number; last_error: string | null; event_id: string | null;
};

export type Enqueue = {
  op: string; signer: string; subject: string; payload?: unknown; targets: string[];
  dependsOn?: number | null; lane?: Lane; held?: boolean;
};

/** What a sender reports for one target after an attempt. */
export type TargetResult =
  | { target: string; kind: 'ok'; eventId?: string }
  | { target: string; kind: 'retry'; error: string; waitSec?: number }
  | { target: string; kind: 'rejected'; error: string }
  | { target: string; kind: 'gave_up'; error: string }
  /** Replace this target with another, as a mirror that refuses does (contract 4.2); delaySec before trying it. */
  | { target: string; kind: 'retarget'; next: string; error: string; delaySec?: number };

/** 30 s, doubling to an hour. */
export function backoff(attempts: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
}

const PENDING = "state IN ('held','queued')";

function pendingRow(db: SqlDb, op: string, signer: string, subject: string): OutboxRow | undefined {
  return db.get<OutboxRow>(`SELECT * FROM outbox WHERE op = ? AND signer = ? AND subject = ? AND ${PENDING}`, op, signer, subject);
}

/**
 * A target with no address is refused before anything is written: its row would never send, back off or give up,
 * since a result's target = ? never matches NULL, and whatever waits on it would wait for ever (F19).
 */
function setTargets(db: SqlDb, id: number, targets: string[], now: number) {
  if (targets.some((t) => typeof t !== 'string' || !t)) throw new Error('an outbox target needs an address');
  db.run('DELETE FROM outbox_targets WHERE outbox_id = ?', id);
  for (const t of new Set(targets)) {
    db.run("INSERT INTO outbox_targets (outbox_id, target, state, attempts, next_at) VALUES (?, ?, 'pending', 0, ?)", id, t, now);
  }
}

/** Adds a change, merging it into the pending row for the same op, signer and subject. Returns the row's id. */
export function enqueue(db: SqlDb, now: number, e: Enqueue): number {
  return db.tx(() => {
    const payload = e.payload === undefined ? null : JSON.stringify(e.payload);
    const existing = pendingRow(db, e.op, e.signer, e.subject);
    if (!existing) {
      const r = db.run(
        'INSERT INTO outbox (op, signer, subject, payload, depends_on, lane, created_at, state, was_queued) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)',
        e.op, e.signer, e.subject, payload, e.dependsOn ?? null, e.lane ?? 'interactive', now, e.held ? 'held' : 'queued',
      );
      setTargets(db, r.lastInsertRowId, e.targets, now);
      return r.lastInsertRowId;
    }
    let state = existing.state;
    let wasQueued = existing.was_queued;
    if (existing.state === 'queued' && e.held) {
      state = 'held';
      wasQueued = 1;
    } else if (existing.state === 'held') {
      wasQueued = 1;
    }
    db.run(
      'UPDATE outbox SET payload = ?, depends_on = COALESCE(?, depends_on), state = ?, was_queued = ?, not_before = NULL WHERE id = ?',
      payload, e.dependsOn ?? null, state, wasQueued, existing.id,
    );
    setTargets(db, existing.id, e.targets, now);
    return existing.id;
  });
}

/** The Undo window closed without Undo: held rows go to the queue. */
export function release(db: SqlDb, ids: number[]): void {
  db.tx(() => {
    for (const id of ids) db.run("UPDATE outbox SET state = 'queued', was_queued = 0 WHERE id = ? AND state = 'held'", id);
  });
}

/** Undo: held rows go, except a was_queued row, which returns to the queue and sends the reverted state. */
export function undo(db: SqlDb, ids: number[]): void {
  db.tx(() => {
    for (const id of ids) {
      const r = db.get<OutboxRow>('SELECT * FROM outbox WHERE id = ?', id);
      if (r?.state !== 'held') continue;
      if (r.was_queued) db.run("UPDATE outbox SET state = 'queued', was_queued = 0 WHERE id = ?", id);
      else db.run('DELETE FROM outbox WHERE id = ?', id);
    }
  });
}

/** Held rows left by a process death are queued at the next start (4.3). */
export function releaseOrphans(db: SqlDb): void {
  db.run("UPDATE outbox SET state = 'queued', was_queued = 0 WHERE state = 'held'");
  db.run("UPDATE outbox SET state = 'queued' WHERE state = 'sending'");
}

/** A row's dependency is met once the row it depends on has gone (succeeded) or has any target ok. */
const DEP_MET = `(o.depends_on IS NULL OR NOT EXISTS (SELECT 1 FROM outbox d WHERE d.id = o.depends_on)
  OR EXISTS (SELECT 1 FROM outbox_targets dt WHERE dt.outbox_id = o.depends_on AND dt.state = 'ok'))`;

/** The next row ready to send, interactive first, oldest first, with the targets due now. */
export function nextDue(db: SqlDb, now: number): { row: OutboxRow; targets: OutboxTarget[] } | null {
  const row = db.get<OutboxRow>(
    `SELECT o.* FROM outbox o WHERE o.state = 'queued' AND (o.not_before IS NULL OR o.not_before <= ?) AND ${DEP_MET}
     AND EXISTS (SELECT 1 FROM outbox_targets t WHERE t.outbox_id = o.id AND t.state = 'pending' AND t.next_at <= ?)
     ORDER BY CASE o.lane WHEN 'interactive' THEN 0 ELSE 1 END, o.created_at, o.id LIMIT 1`,
    now, now,
  );
  if (!row) return null;
  const targets = db.all<OutboxTarget>("SELECT * FROM outbox_targets WHERE outbox_id = ? AND state = 'pending' AND next_at <= ? ORDER BY target", row.id, now);
  return { row, targets };
}

/** When the next row can be sent, for the scheduler, or null when nothing is waiting. */
export function nextWakeAt(db: SqlDb): number | null {
  const r = db.get<{ at: number | null }>(
    `SELECT MIN(MAX(t.next_at, COALESCE(o.not_before, 0))) AS at FROM outbox o JOIN outbox_targets t ON t.outbox_id = o.id
     WHERE o.state = 'queued' AND t.state = 'pending' AND ${DEP_MET}`,
  );
  return r?.at ?? null;
}

/**
 * The rows of op waiting on row id go without it, and so never die with it: a save's publish once the operator refuses
 * the text it waited for (4.3, C§4.2, v1.12).
 */
export function releaseDependents(db: SqlDb, id: number, op: string): void {
  db.run("UPDATE outbox SET depends_on = NULL WHERE depends_on = ? AND op = ? AND state != 'dead'", id, op);
}

/**
 * releaseDependents for every row a query names (ids, a SELECT of outbox ids taking params), in one statement: a
 * refusal for room releases the saves of every text it holds (data/backup.ts holdUploads), thousands for an import,
 * and depends_on has no index, so a statement a row read the outbox through once for each.
 */
export function releaseDependentsIn(db: SqlDb, ids: string, params: Param[], op: string): void {
  db.run(`UPDATE outbox SET depends_on = NULL WHERE op = ? AND state != 'dead' AND depends_on IN (${ids})`, op, ...params);
}

/** A row's waiting targets fall due now, as a text that fits the room a deletion made does (C§5). */
export function wake(db: SqlDb, id: number, now: number): void {
  db.run("UPDATE outbox_targets SET next_at = ? WHERE outbox_id = ? AND state = 'pending'", now, id);
}

export function begin(db: SqlDb, id: number): void {
  db.run("UPDATE outbox SET state = 'sending' WHERE id = ? AND state = 'queued'", id);
}

function applyResult(db: SqlDb, now: number, id: number, r: TargetResult) {
  const t = db.get<OutboxTarget>('SELECT * FROM outbox_targets WHERE outbox_id = ? AND target = ?', id, r.target);
  if (!t) return;
  switch (r.kind) {
    case 'ok':
      db.run("UPDATE outbox_targets SET state = 'ok', last_error = NULL, event_id = ? WHERE outbox_id = ? AND target = ?", r.eventId ?? null, id, r.target);
      return;
    case 'retry': {
      const attempts = t.attempts + 1;
      db.run('UPDATE outbox_targets SET attempts = ?, next_at = ?, last_error = ? WHERE outbox_id = ? AND target = ?',
        attempts, now + (r.waitSec ?? backoff(attempts)), r.error, id, r.target);
      return;
    }
    case 'rejected':
    case 'gave_up':
      db.run('UPDATE outbox_targets SET state = ?, last_error = ? WHERE outbox_id = ? AND target = ?', r.kind, r.error, id, r.target);
      return;
    case 'retarget':
      db.run('DELETE FROM outbox_targets WHERE outbox_id = ? AND target = ?', id, r.target);
      db.run("INSERT OR REPLACE INTO outbox_targets (outbox_id, target, state, attempts, next_at, last_error) VALUES (?, ?, 'pending', 0, ?, ?)",
        id, r.next, now + (r.delaySec ?? 0), r.error);
  }
}

function killDependents(db: SqlDb, id: number) {
  for (const d of db.all<{ id: number }>("SELECT id FROM outbox WHERE depends_on = ? AND state != 'dead'", id)) {
    db.run("UPDATE outbox SET state = 'dead' WHERE id = ?", d.id);
    killDependents(db, d.id);
  }
}

export type Finished = 'done' | 'dead' | 'queued' | 'superseded';

/** Records an attempt's results and settles the row. */
export function finish(db: SqlDb, now: number, id: number, results: TargetResult[]): Finished {
  return db.tx(() => {
    const row = db.get<OutboxRow>('SELECT * FROM outbox WHERE id = ?', id);
    if (!row) return 'done';
    for (const r of results) applyResult(db, now, id, r);
    // A change made during the attempt waits in its own row, which carries the latest state to every target,
    // including any this attempt hadn't reached yet
    const next = pendingRow(db, row.op, row.signer, row.subject);
    if (next) {
      db.run(`INSERT OR IGNORE INTO outbox_targets (outbox_id, target, state, attempts, next_at)
        SELECT ?, target, 'pending', 0, ? FROM outbox_targets WHERE outbox_id = ? AND state = 'pending'`, next.id, now, id);
      db.run('DELETE FROM outbox WHERE id = ?', id);
      return 'superseded';
    }
    const ts = db.all<OutboxTarget>('SELECT * FROM outbox_targets WHERE outbox_id = ?', id);
    const anyOk = ts.some((t) => t.state === 'ok');
    if (ts.every((t) => t.state !== 'pending')) {
      if (anyOk) {
        db.run('DELETE FROM outbox WHERE id = ?', id);
        return 'done';
      }
      db.run("UPDATE outbox SET state = 'dead' WHERE id = ?", id);
      killDependents(db, id);
      return 'dead';
    }
    db.run("UPDATE outbox SET state = 'queued' WHERE id = ?", id);
    return 'queued';
  });
}
