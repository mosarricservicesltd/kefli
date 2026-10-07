import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { recordPlayed } from '../src/data/listen';
import { backupDone, markBackupDone, showBackupCard, snoozeBackup, youStats } from '../src/data/you';
import { memoryDb } from './sqlite';

const PK = 'ab'.repeat(32);
const h = (n: number) => n.toString(16).padStart(64, '0');

describe('You (mobile spec 5.8)', () => {
  function world(recovery = true) {
    const db = memoryDb();
    migrate(db);
    ensureIdentityRow(db, 1, PK, 'new', recovery);
    for (let n = 1; 10 >= n; n++) db.run('INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin) VALUES (?, ?, ?, ?, ?, ?, ?)', PK, h(n), 'u', n, 'unread', n === 9 ? 'failed' : 'cached', 's');
    return db;
  }

  test('the counts, the quilt of the newest eight, and the connected browsers', () => {
    const db = world();
    recordPlayed(db, PK, h(3), 1);
    db.run("INSERT INTO devices (device_pubkey, owner, label, connected_at) VALUES ('d1', ?, 'Chrome', 1), ('d2', ?, 'Firefox', 1)", PK, PK);
    db.run("UPDATE devices SET revoked_at = 5 WHERE device_pubkey = 'd2'");
    const s = youStats(db, PK);
    expect([s.saves, s.listened, s.browsers]).toEqual([10, 1, 1]);
    expect(s.quilt.map((q) => q.hash)).toEqual([10, 9, 8, 7, 6, 5, 4, 3].map(h));
    expect(s.quilt[1].failed).toBe(true);
  });

  test('the backup card: until the words are shown, Later hiding it for ten more saves', () => {
    const db = world();
    expect(showBackupCard(db, PK, 10)).toBe(true);
    snoozeBackup(db, 10);
    expect(showBackupCard(db, PK, 19)).toBe(false);
    expect(showBackupCard(db, PK, 20)).toBe(true);
    markBackupDone(db);
    expect(backupDone(db)).toBe(true);
    expect(showBackupCard(db, PK, 50)).toBe(false);
    expect(showBackupCard(world(false), PK, 10)).toBe(false);
  });
});
