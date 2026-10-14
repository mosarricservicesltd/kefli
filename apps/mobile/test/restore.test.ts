import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { queueRestore } from '../src/data/settings';
import { beginRestore, restoreCardShows, restoreOf, settleRestore } from '../src/data/restore';
import { memoryDb } from './sqlite';

const PK = 'ab'.repeat(32);
const h = (n: number) => n.toString(16).padStart(64, '0');

function world() {
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, 1, PK, 'recovery_code', true);
  const add = (n: number, textState: string) =>
    db.run("INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, ?, ?, 'unread', ?, 'sync')", PK, h(n), `https://e.com/${n}`, n, textState);
  return { db, add };
}

describe('the restore job (mobile spec 4.10, 5.3)', () => {
  test('N of M counts saves whose text is here or known missing; done once nothing waits', () => {
    const w = world();
    expect(restoreOf(w.db, PK)).toBeNull();
    queueRestore(w.db, 10, PK);
    expect(restoreOf(w.db, PK)).toMatchObject({ state: 'queued', found: 0, total: 0 });
    expect(beginRestore(w.db, 11, PK)).toBe(true);
    expect(beginRestore(w.db, 12, PK)).toBe(true); // still running
    w.add(1, 'remote');
    w.add(2, 'cached');
    w.add(3, 'failed');
    expect(restoreOf(w.db, PK)).toMatchObject({ state: 'running', found: 2, total: 3 });
    // a text unreachable (offline): the job stays running, and the card shows
    expect(settleRestore(w.db, 20, PK)).toBe('running');
    expect(restoreCardShows(restoreOf(w.db, PK), 20)).toBe(true);
    w.db.run("UPDATE items SET text_state = 'cached'");
    expect(settleRestore(w.db, 30, PK)).toBe('done');
    expect(restoreOf(w.db, PK)).toEqual({ state: 'done', found: 3, total: 3, doneAt: 30 });
    // "All 3 saves are back" holds for 3 s, then the card goes
    expect(restoreCardShows(restoreOf(w.db, PK), 32)).toBe(true);
    expect(restoreCardShows(restoreOf(w.db, PK), 33)).toBe(false);
    expect(settleRestore(w.db, 40, PK)).toBe('done');
  });

  test('a restore that finds nothing ends without a card (restore-nothing)', () => {
    const w = world();
    queueRestore(w.db, 10, PK);
    beginRestore(w.db, 11, PK);
    expect(settleRestore(w.db, 12, PK)).toBe('done');
    expect(restoreCardShows(restoreOf(w.db, PK), 12)).toBe(false);
    expect(beginRestore(w.db, 13, PK)).toBe(false);
    expect(settleRestore(w.db, 14, 'cd'.repeat(32))).toBeNull();
  });

  test('saves waiting for the signer keep a restore at 0 of 0 running until they arrive (F14)', () => {
    const w = world();
    queueRestore(w.db, 10, PK);
    beginRestore(w.db, 11, PK);
    expect(settleRestore(w.db, 12, PK, 2)).toBe('running');
    expect(restoreCardShows(restoreOf(w.db, PK), 12)).toBe(true);
    // the signer answers at the next sync and the saves come with their texts
    w.add(1, 'cached');
    w.add(2, 'cached');
    expect(settleRestore(w.db, 20, PK, 0)).toBe('done');
    expect(restoreOf(w.db, PK)).toMatchObject({ state: 'done', found: 2, total: 2 });
  });
});
