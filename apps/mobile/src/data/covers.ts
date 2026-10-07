// Signature 1, drawn once (mobile spec 6.4, MS Signature 1): a cover draws itself once per surface, as its save
// lands in front of you; never on scroll, a tab switch, a re-render or after Undo. cover_drawn keeps when each
// draw started (epoch ms; 0 for a cover that was simply there, drawn), so an interrupted draw carries on.
import type { SqlDb } from './db';

export type Surface = 'list' | 'sheet' | 'welcome';

/** How long a cover with n leaves takes to draw: 520 ms plus 34 ms per further leaf (ShelfCover.motion.once). */
export function drawMs(leaves: number, once = { durationMs: 520, staggerMs: 34 }): number {
  return once.durationMs + Math.max(0, leaves - 1) * once.staggerMs;
}

/**
 * The draws for saves on a surface. A hash with no record is new: it draws from now if the surface is in front of
 * you, otherwise it is recorded as already drawn. Returns each hash's draw start (0 when drawn).
 */
export function coverDraws(db: SqlDb, hashes: string[], surface: Surface, nowMs: number, onScreen: boolean): Map<string, number> {
  const out = new Map<string, number>();
  if (!hashes.length) return out;
  return db.tx(() => {
    for (const hash of hashes) {
      const r = db.get<{ drawn_at: number }>('SELECT drawn_at FROM cover_drawn WHERE hash = ? AND surface = ?', hash, surface);
      if (r) {
        out.set(hash, r.drawn_at);
        continue;
      }
      const start = onScreen ? nowMs : 0;
      db.run('INSERT INTO cover_drawn (hash, surface, drawn_at) VALUES (?, ?, ?)', hash, surface, start);
      out.set(hash, start);
    }
    return out;
  });
}

/** Saves already on the phone when the list first shows count as drawn: they didn't land in front of you. */
export function markDrawn(db: SqlDb, hashes: string[], surface: Surface): void {
  db.tx(() => {
    for (const hash of hashes) db.run('INSERT OR IGNORE INTO cover_drawn (hash, surface, drawn_at) VALUES (?, ?, 0)', hash, surface);
  });
}

/** Whether a draw that started at start is still running at now. */
export function drawing(start: number, nowMs: number, ms: number): boolean {
  return start > 0 && ms > nowMs - start;
}
