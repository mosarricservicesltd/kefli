import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { asksBeforeSaving, checkDue, recordCheck } from '../src/data/nostrCheck';
import { unsentSaves } from '../src/data/backup';
import { devicePrefs, getSetting, restorePrefs, setSetting, wipe } from '../src/data/settings';
import { memoryDb } from './sqlite';

const PK = 'a'.repeat(64);
const h = (n: number) => n.toString(16).padStart(64, '0');

function world() {
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, 1, PK, 'new', true);
  const add = (n: number, o: { event_id?: string | null; dirty?: number; text_sha256?: string | null; pending_delete_at?: number | null } = {}) =>
    db.run(
      `INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, event_id, dirty, text_sha256, pending_delete_at)
       VALUES (?, ?, ?, 1, 'unread', 'cached', 'share', ?, ?, ?, ?)`,
      PK, h(n), `https://e.com/${n}`, o.event_id === undefined ? `ev${n}` : o.event_id, o.dirty ?? 0, o.text_sha256 ?? null, o.pending_delete_at ?? null,
    );
  const blob = (sha: string, operatorAt: number | null, mirrorAt: number | null) =>
    db.run("INSERT INTO blobs (sha256, hash, kind, owner, operator_at, mirror_at) VALUES (?, ?, 'text', ?, ?, ?)", sha, h(0), PK, operatorAt, mirrorAt);
  return { db, add, blob };
}

describe('saving without asking, as last checked (FD 104)', () => {
  test('unchecked, nothing is stamped and a check is due', () => {
    const { db } = world();
    expect(asksBeforeSaving(db)).toBe(false);
    expect(checkDue(db, 1_000)).toBe(true);
  });

  test('a check that finds something missing stamps the row; one that finds nothing clears it', () => {
    const { db } = world();
    recordCheck(db, 1_000, [13, 10063, 24242]);
    expect(asksBeforeSaving(db)).toBe(true);
    recordCheck(db, 2_000, []);
    expect(asksBeforeSaving(db)).toBe(false);
  });

  test('the next check is due a day after the last', () => {
    const { db } = world();
    recordCheck(db, 1_000, []);
    expect(checkDue(db, 1_000 + 86_399)).toBe(false);
    expect(checkDue(db, 1_000 + 86_400)).toBe(true);
  });
});

describe('signing out (FD 105)', () => {
  test('counts the saves it would lose: unsent, changed, or with text no server holds', () => {
    const w = world();
    w.add(1); // sent, nothing pending
    w.add(2, { event_id: null }); // never sent
    w.add(3, { dirty: 1 }); // a change not yet sent
    w.add(4, { text_sha256: 'b'.repeat(64) }); // sent, but its text reached no server (the declined upload)
    w.blob('b'.repeat(64), null, null);
    w.add(5, { text_sha256: 'c'.repeat(64) }); // its text on Kefli's server, waiting only for the mirror
    w.blob('c'.repeat(64), 100, null);
    w.add(6, { event_id: null, pending_delete_at: 5 }); // being deleted anyway
    expect(unsentSaves(w.db, PK)).toBe(3);
  });

  test('keeps the reader and voice settings across the wipe, and nothing else', () => {
    const { db } = world();
    for (const [k, v] of [['reader.size', '19'], ['reader.palette', 'dark'], ['voice.speed', '1.25'], ['voice.id', 'en-gb-x'], ['voice.wps.en-gb-x', '2.6'], ['welcome.answered', '1'], ['nostr.asks', '1']]) setSetting(db, k, v);
    const kept = devicePrefs(db);
    wipe(db);
    restorePrefs(db, kept);
    expect(Object.fromEntries(db.all<{ key: string; value: string }>('SELECT key, value FROM settings ORDER BY key').map((r) => [r.key, r.value]))).toEqual({
      'reader.palette': 'dark', 'reader.size': '19', 'voice.id': 'en-gb-x', 'voice.speed': '1.25', 'voice.wps.en-gb-x': '2.6',
    });
    expect(getSetting(db, 'welcome.answered')).toBeNull();
    expect(db.all('SELECT 1 FROM identities')).toEqual([]);
  });
});
