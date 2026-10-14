// Backup space's data (FD 117, C§5, C§6; mobile spec 5.4, 5.8): the figures kept from Kefli's server, the saves whose
// text waits on the phone by the reason it was refused, and what Advanced and the Saved sheet show from them.
import {
  DEFAULT_QUOTA, MB, NOTHING_WAITS, accountFigures, backupNotice, forgetFigures, readFigures, recordFigures, roomOf, shareLine,
  shareRoom, spaceOf, textsWaiting, waitsForRoom, type Waiting,
} from '../src/data/account';
import { notBackedUp } from '../src/data/backup';
import { migrate } from '../src/data/schema';
import { ensureIdentityRow } from '../src/data/saves';
import { wipe } from '../src/data/settings';
import { memoryDb } from './sqlite';

const ME = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const DAY = 86_400;
// the refusal's time is written by SQLite's clock, which is the phone's, so these tests run on it too
const NOW = Math.floor(Date.now() / 1000);
const FIGURES = { v: 1, quota: 50 * MB, used: Math.round(12.43 * MB), daily: 20 * MB, today: Math.round(0.31 * MB) };

function world() {
  const db = memoryDb();
  migrate(db);
  ensureIdentityRow(db, NOW, ME, 'new', true);
  return db;
}

let n = 0;
/** A save of the owner's whose text this phone staged, with its blob's state. */
function save(db: ReturnType<typeof world>, blob: { last_error?: string | null; operator_at?: number | null; mirror_at?: number | null } = {}, owner = ME) {
  n++;
  const hash = n.toString(16).padStart(64, '0');
  const sha = (n + 0x1000).toString(16).padStart(64, '0');
  db.run(
    "INSERT INTO items (owner, hash, url, saved_at, state, text_state, origin, text_sha256, event_id, published, backed_event) VALUES (?, ?, ?, ?, 'unread', 'cached', 'share', ?, ?, 1, ?)",
    owner, hash, `https://example.com/${n}`, NOW, sha, `e${n}`, `e${n}`,
  );
  db.run('INSERT INTO blobs (sha256, hash, kind, size, owner, operator_at, mirror_at, last_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha, hash, 'text', 20_000, owner, blob.operator_at ?? null, blob.mirror_at ?? null, blob.last_error ?? null);
  return { hash, sha };
}

describe('the figures from Kefli’s server (C§6)', () => {
  test('an answer’s four figures are read, a 413’s error and any unknown field aside', () => {
    expect(readFigures(FIGURES)).toEqual({ quota: 50 * MB, used: Math.round(12.43 * MB), daily: 20 * MB, today: Math.round(0.31 * MB) });
    expect(readFigures({ ...FIGURES, error: 'quota', extra: true })).toEqual(readFigures(FIGURES));
    // the four alone, as a caller holding them already may pass them
    expect(readFigures({ quota: 1, used: 0, daily: 2, today: 0 })).toEqual({ quota: 1, used: 0, daily: 2, today: 0 });
  });

  test('an answer without all four as whole bytes, or in a version this client doesn’t know, has none', () => {
    for (const bad of [null, undefined, 'x', 5, [], { ...FIGURES, v: 2 }, { ...FIGURES, used: -1 }, { ...FIGURES, quota: 1.5 },
      { ...FIGURES, daily: '20' }, { ...FIGURES, today: null }, { v: 1, quota: 1, used: 0, daily: 2 }, { ...FIGURES, used: 2 ** 60 }]) {
      expect(readFigures(bad)).toBeNull();
    }
  });

  test('the last answer is kept, with when it came, replacing the one before', () => {
    const db = world();
    expect(accountFigures(db, ME)).toBeNull();
    expect(recordFigures(db, ME, FIGURES, 100)).toBe(true);
    expect(accountFigures(db, ME)).toEqual({ quota: 50 * MB, used: FIGURES.used, daily: 20 * MB, today: FIGURES.today, at: 100 });
    expect(recordFigures(db, ME, { ...FIGURES, used: 49 * MB, error: 'quota' }, 200)).toBe(true);
    expect(accountFigures(db, ME)).toMatchObject({ used: 49 * MB, at: 200 });
  });

  test('an answer without figures leaves the last one as it was', () => {
    const db = world();
    recordFigures(db, ME, FIGURES, 100);
    expect(recordFigures(db, ME, { v: 1, error: 'too_large' }, 200)).toBe(false);
    expect(accountFigures(db, ME)).toMatchObject({ used: FIGURES.used, at: 100 });
  });

  test('figures are kept only for an identity on this phone, and go with it', () => {
    const db = world();
    expect(recordFigures(db, OTHER, FIGURES, 100)).toBe(false);
    expect(accountFigures(db, OTHER)).toBeNull();
    ensureIdentityRow(db, NOW, OTHER, 'new', true);
    recordFigures(db, OTHER, FIGURES, 100);
    recordFigures(db, ME, FIGURES, 100);
    // a move's last step removes its source's identity row
    db.run('DELETE FROM identities WHERE pubkey = ?', OTHER);
    expect(accountFigures(db, OTHER)).toBeNull();
    expect(accountFigures(db, ME)).not.toBeNull();
  });

  test('a library’s wipe (Delete my data, Sign out) leaves no figures behind', () => {
    const db = world();
    recordFigures(db, ME, FIGURES, 100);
    wipe(db);
    expect(db.get('SELECT COUNT(*) AS n FROM account_figures')).toEqual({ n: 0 });
  });

  test('a not_registered answer forgets the figures held', () => {
    const db = world();
    recordFigures(db, ME, FIGURES, 100);
    forgetFigures(db, ME);
    expect(accountFigures(db, ME)).toBeNull();
  });
});

describe('texts waiting on the phone (blobs.last_error)', () => {
  test('each live save counts under the reason Kefli’s server gave, while no server holds its text', () => {
    const db = world();
    save(db, { last_error: 'quota' });
    save(db, { last_error: 'quota' });
    save(db, { last_error: 'daily' });
    save(db, { last_error: 'too_large' });
    save(db, { last_error: 'http 400' });
    save(db);
    save(db, { operator_at: NOW, mirror_at: NOW });
    expect(textsWaiting(db, ME, NOW)).toEqual({ quota: 2, full: true, daily: 1, dailyRecent: 1, tooLarge: 1 });
  });

  test('nothing waits in an empty library, or one whose texts all went', () => {
    const db = world();
    expect(textsWaiting(db, ME, NOW)).toEqual(NOTHING_WAITS);
    save(db, { operator_at: NOW });
    expect(textsWaiting(db, ME, NOW)).toEqual(NOTHING_WAITS);
  });

  test('a text the operator has taken since no longer waits, whatever reason is left', () => {
    const db = world();
    save(db, { last_error: 'quota', operator_at: NOW });
    expect(textsWaiting(db, ME, NOW)).toEqual(NOTHING_WAITS);
  });

  test('a save deleted, or waiting on its delete’s Undo, isn’t counted, nor another library’s', () => {
    const db = world();
    ensureIdentityRow(db, NOW, OTHER, 'new', true);
    const a = save(db, { last_error: 'quota' });
    save(db, { last_error: 'daily' }, OTHER);
    db.run('UPDATE items SET pending_delete_at = ? WHERE hash = ?', NOW, a.hash);
    expect(textsWaiting(db, ME, NOW)).toEqual(NOTHING_WAITS);
    db.run('DELETE FROM items WHERE hash = ?', a.hash);
    expect(textsWaiting(db, ME, NOW)).toEqual(NOTHING_WAITS);
  });

  test('a text a mirror holds already, as a move’s copy may, makes the space full but isn’t only on this phone', () => {
    const db = world();
    save(db, { last_error: 'quota', mirror_at: NOW });
    save(db, { last_error: 'too_large', mirror_at: NOW });
    expect(textsWaiting(db, ME, NOW)).toEqual({ ...NOTHING_WAITS, full: true });
  });

  test('a refusal for the day’s uploads counts as recent for 24 hours from when it was written', () => {
    const db = world();
    const { sha } = save(db);
    db.run("UPDATE blobs SET last_error = 'daily' WHERE sha256 = ?", sha);
    expect(textsWaiting(db, ME, NOW)).toMatchObject({ daily: 1, dailyRecent: 1 });
    db.run('UPDATE blobs SET refused_at = ? WHERE sha256 = ?', NOW - DAY - 1, sha);
    expect(textsWaiting(db, ME, NOW)).toMatchObject({ daily: 1, dailyRecent: 0 });
    // refused again a day later: recent again
    db.run("UPDATE blobs SET last_error = 'daily' WHERE sha256 = ?", sha);
    expect(textsWaiting(db, ME, NOW)).toMatchObject({ daily: 1, dailyRecent: 1 });
  });

  test('a refusal with no time, written before the time was kept, counts as recent', () => {
    const db = world();
    const { sha } = save(db, { last_error: 'daily' });
    db.run('UPDATE blobs SET refused_at = NULL WHERE sha256 = ?', sha);
    expect(textsWaiting(db, ME, NOW).dailyRecent).toBe(1);
  });

  test('each counted save is one Advanced counts as not backed up', () => {
    const db = world();
    for (const last_error of ['quota', 'daily', 'too_large']) save(db, { last_error });
    const w = textsWaiting(db, ME, NOW);
    expect(notBackedUp(db, ME)).toBe(w.quota + w.daily + w.tooLarge);
  });

  test('a save’s own text waits for room only on a 413 quota or daily that no server has since overtaken', () => {
    const db = world();
    const q = save(db, { last_error: 'quota' });
    const d = save(db, { last_error: 'daily' });
    const big = save(db, { last_error: 'too_large' });
    const taken = save(db, { last_error: 'quota', operator_at: NOW });
    const mirrored = save(db, { last_error: 'quota', mirror_at: NOW });
    const fine = save(db);
    expect([q, d, big, taken, mirrored, fine].map((s) => waitsForRoom(db, ME, s.hash))).toEqual([true, true, false, false, false, false]);
    expect(waitsForRoom(db, OTHER, q.hash)).toBe(false);
  });
});

const W = (w: Partial<Waiting>): Waiting => ({ ...NOTHING_WAITS, ...w });

describe('Advanced’s notice slot (FD 117)', () => {
  test('room on the space comes first, counting every text waiting for room', () => {
    expect(roomOf(W({ quota: 2, full: true, daily: 1, dailyRecent: 1 }))).toEqual({ why: 'quota', n: 3 });
    expect(backupNotice(W({ quota: 2, full: true, daily: 1, tooLarge: 1 }), 5)).toEqual({ notice: { kind: 'full', n: 3 }, trying: 1 });
  });

  test('then the day’s uploads, while one was refused for them in the last 24 hours', () => {
    expect(backupNotice(W({ daily: 3, dailyRecent: 1 }), 3)).toEqual({ notice: { kind: 'daily', n: 3 }, trying: 0 });
    // refused more than a day ago: Kefli is about to try again, so they are among the saves it is still trying
    expect(roomOf(W({ daily: 3 }))).toBeNull();
    expect(backupNotice(W({ daily: 3 }), 3)).toEqual({ notice: { kind: 'trying', n: 3 }, trying: 3 });
  });

  test('then the saves Kefli is still trying to back up, then the texts too long to back up', () => {
    expect(backupNotice(W({ tooLarge: 1 }), 3)).toEqual({ notice: { kind: 'trying', n: 2 }, trying: 2 });
    expect(backupNotice(W({ tooLarge: 2 }), 2)).toEqual({ notice: { kind: 'toolarge', n: 2 }, trying: 0 });
  });

  test('no notice while every save is backed up', () => {
    expect(backupNotice(NOTHING_WAITS, 0)).toEqual({ notice: null, trying: 0 });
  });

  test('the saves Kefli is still trying for never count below none', () => {
    expect(backupNotice(W({ quota: 2, full: true }), 1).trying).toBe(0);
  });
});

describe('the Backup space row (FD 117)', () => {
  const F = { quota: 50 * MB, used: Math.round(12.43 * MB) };
  test('the figures held, with nearly full from 90 % and Full at the quota or while a text waits on the space', () => {
    expect(spaceOf(F, false, 'ok', true)).toEqual({ kind: 'figures', used: F.used, quota: F.quota, level: 'room' });
    expect(spaceOf({ ...F, used: 45 * MB - 1 }, false, 'ok', true)).toMatchObject({ level: 'room' });
    expect(spaceOf({ ...F, used: 45 * MB }, false, 'ok', true)).toMatchObject({ level: 'nearly' });
    expect(spaceOf({ ...F, used: 50 * MB }, false, 'ok', true)).toMatchObject({ level: 'full' });
    expect(spaceOf({ ...F, used: 120 * MB }, false, 'ok', true)).toMatchObject({ level: 'full', used: 120 * MB });
    expect(spaceOf({ ...F, used: Math.round(49.96 * MB) }, true, 'ok', true)).toMatchObject({ level: 'full' });
    expect(spaceOf(F, true, 'ok', true)).toMatchObject({ level: 'full' });
  });

  test('figures held stay through a check offline or one that fails, until a new answer comes', () => {
    for (const check of ['checking', 'failed'] as const) {
      for (const online of [true, false]) expect(spaceOf(F, false, check, online)).toMatchObject({ kind: 'figures', used: F.used });
    }
  });

  test('with none held: empty for a library Kefli’s server doesn’t keep, offline, failed or checking', () => {
    expect(spaceOf(null, false, 'unregistered', true)).toEqual({ kind: 'figures', used: 0, quota: DEFAULT_QUOTA, level: 'room' });
    expect(spaceOf(null, false, 'unregistered', false)).toMatchObject({ kind: 'figures', used: 0 });
    expect(spaceOf(null, false, 'checking', false)).toEqual({ kind: 'offline' });
    expect(spaceOf(null, false, 'failed', false)).toEqual({ kind: 'offline' });
    expect(spaceOf(null, false, 'failed', true)).toEqual({ kind: 'failed' });
    expect(spaceOf(null, false, 'checking', true)).toEqual({ kind: 'checking' });
    expect(spaceOf(null, true, 'ok', true)).toEqual({ kind: 'checking' });
  });
});

describe('the Saved sheet’s line (share-full, share-daily)', () => {
  test('full while Backup space would read Full, daily while a text waits on the day’s uploads from the last 24 hours', () => {
    const F = { quota: 50 * MB, used: 12 * MB };
    expect(shareRoom(F, NOTHING_WAITS)).toBeNull();
    expect(shareRoom(null, NOTHING_WAITS)).toBeNull();
    expect(shareRoom({ ...F, used: 50 * MB }, NOTHING_WAITS)).toBe('full');
    expect(shareRoom(null, W({ quota: 1, full: true }))).toBe('full');
    expect(shareRoom(F, W({ full: true, daily: 1, dailyRecent: 1 }))).toBe('full');
    expect(shareRoom(F, W({ daily: 1, dailyRecent: 1 }))).toBe('daily');
    expect(shareRoom(F, W({ daily: 1 }))).toBeNull();
  });

  test('from the library as it stands', () => {
    const db = world();
    expect(shareLine(db, ME, NOW, null)).toBeNull();
    save(db, { last_error: 'daily' });
    expect(shareLine(db, ME, NOW, null)).toBe('daily');
    recordFigures(db, ME, { ...FIGURES, used: 50 * MB }, NOW);
    expect(shareLine(db, ME, NOW, null)).toBe('full');
  });

  test('a save brought back from Archive takes the line only while its own text waits for room', () => {
    const db = world();
    const waiting = save(db, { last_error: 'quota' });
    const held = save(db, { operator_at: NOW, mirror_at: NOW });
    expect(shareLine(db, ME, NOW, held.hash)).toBeNull();
    expect(shareLine(db, ME, NOW, waiting.hash)).toBe('full');
  });
});
