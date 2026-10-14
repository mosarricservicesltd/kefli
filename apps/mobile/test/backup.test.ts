// The backup space's reckoning (contract 5, v1.12; data/backup.ts): the room the last known figures leave, from what
// this phone has had the operator take and delete since, and the oldest text waiting for room that fits it.
import { migrate } from '../src/data/schema';
import { forgetFreed, nextForRoom, noteFreed, roomLeft, type KnownFigures } from '../src/data/backup';
import { enqueue } from '../src/data/outbox';
import { getSetting, setSetting } from '../src/data/settings';
import { memoryDb } from './sqlite';

const PK = 'ab'.repeat(32);
const F: KnownFigures = { quota: 10_000, used: 9_000, daily: 20_000, today: 0, at: 1_000 };
const sha = (n: number) => n.toString(16).padStart(64, '0');

function world() {
  const db = memoryDb();
  migrate(db);
  const blob = (n: number, o: { size?: number | null; operator_at?: number | null; last_error?: string | null } = {}) => {
    db.run('INSERT INTO blobs (sha256, hash, kind, size, owner, operator_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?)',
      sha(n), sha(n), 'text', o.size === undefined ? 100 : o.size, PK, o.operator_at ?? null, o.last_error ?? null);
    return enqueue(db, 900 + n, { op: 'upload_blob', signer: PK, subject: sha(n), payload: { sha256: sha(n) }, targets: ['http://blossom'] });
  };
  return { db, blob };
}

describe('the room the last known figures leave (C§5)', () => {
  test('their quota less their use, less what the operator took since, plus what it deleted since of what they counted', () => {
    const w = world();
    expect(roomLeft(w.db, PK, F)).toBe(1_000);
    // taken before the figures: they counted it; taken after: it comes off
    w.blob(1, { size: 400, operator_at: 900 });
    w.blob(2, { size: 300, operator_at: 1_100 });
    expect(roomLeft(w.db, PK, F)).toBe(700);
    // deleted after the figures, of a blob they counted (or whose upload time isn't known): it gives the room back
    noteFreed(w.db, PK, { at: 1_200, size: 250, up: 900 });
    noteFreed(w.db, PK, { at: 1_200, size: 50, up: null });
    // deleted before the figures, or a blob taken after them, gives back nothing they counted
    noteFreed(w.db, PK, { at: 990, size: 5_000, up: 800 });
    noteFreed(w.db, PK, { at: 1_300, size: 5_000, up: 1_100 });
    expect(roomLeft(w.db, PK, F)).toBe(1_000);
    // another library's deletions are its own
    expect(roomLeft(w.db, 'cd'.repeat(32), F)).toBe(1_000);
  });

  test('the newest 200 deletions are kept, a library leaving the phone takes them, and a damaged record reads as none', () => {
    const w = world();
    for (let i = 0; 205 > i; i++) noteFreed(w.db, PK, { at: 2_000 + i, size: 1, up: null });
    expect(roomLeft(w.db, PK, F)).toBe(1_000 + 200);
    forgetFreed(w.db, PK);
    expect(getSetting(w.db, `space.freed.${PK}`)).toBeNull();
    setSetting(w.db, `space.freed.${PK}`, '{not json');
    expect(roomLeft(w.db, PK, F)).toBe(1_000);
    setSetting(w.db, `space.freed.${PK}`, JSON.stringify({ at: 2_000, size: 9 }));
    expect(roomLeft(w.db, PK, F)).toBe(1_000);
    setSetting(w.db, `space.freed.${PK}`, JSON.stringify([{ at: 2_000, size: 9, up: null }, { at: 'x', size: 9 }, null, 7]));
    expect(roomLeft(w.db, PK, F)).toBe(1_009);
  });

  test('the oldest text waiting on quota that fits, and only one waiting on quota, unsent, and not held', () => {
    const w = world();
    const big = w.blob(1, { size: 900, last_error: 'quota' });
    const small = w.blob(2, { size: 200, last_error: 'quota' });
    w.blob(3, { size: 10, last_error: 'daily' });
    w.blob(4, { size: 10, last_error: 'too_large' });
    w.blob(5, { size: 10, last_error: 'quota', operator_at: 5 });
    expect(nextForRoom(w.db, PK, 1_000)).toBe(big);
    expect(nextForRoom(w.db, PK, 500)).toBe(small);
    expect(nextForRoom(w.db, PK, 100)).toBeNull();
    expect(nextForRoom(w.db, 'cd'.repeat(32), 1_000)).toBeNull();
    w.db.run("UPDATE outbox SET state = 'sending' WHERE id = ?", small);
    expect(nextForRoom(w.db, PK, 500)).toBeNull();
    // a blob whose size isn't known is tried: a refusal stops the run
    w.blob(6, { size: null, last_error: 'quota' });
    expect(nextForRoom(w.db, PK, 0)).not.toBeNull();
  });
});
