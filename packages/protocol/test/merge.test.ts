import { deletedHashes, deletionRemoves, mergeItem, replaces } from '../src';
import type { LocalVersion, NostrEvent, RemoteVersion } from '../src';

const PK = 'ab'.repeat(32);
const H1 = '11'.repeat(32);
const H2 = '22'.repeat(32);

// A seeded generator, so a failing property names its seed.
function rng(seed: number) {
  let s = seed >>> 0;
  return (n: number) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s % n;
  };
}

/** A phone applying remote events to one address, as sync does, with an optional local change of its own. */
function apply(events: RemoteVersion[], dirtyAt?: number): { local: LocalVersion; republish: boolean } {
  let local: LocalVersion | null = dirtyAt === undefined ? null : { eventId: null, createdAt: null, dirty: true, modifiedAt: dirtyAt };
  let republish = false;
  for (const e of events) {
    const o = mergeItem(local, e);
    if (o === 'insert' || o === 'take') local = { eventId: e.id, createdAt: e.created_at, dirty: false, modifiedAt: null };
    if (o === 'republish') republish = true;
  }
  return { local: local!, republish };
}

const hex = (n: number) => n.toString(16).padStart(64, '0');

describe('merging an inbound save (mobile spec 4.5)', () => {
  test('a newer event replaces, a tie goes to the lower id', () => {
    expect(replaces({ id: hex(9), created_at: 2 }, { id: hex(1), created_at: 1 })).toBe(true);
    expect(replaces({ id: hex(1), created_at: 2 }, { id: hex(2), created_at: 2 })).toBe(true);
    expect(replaces({ id: hex(2), created_at: 2 }, { id: hex(1), created_at: 2 })).toBe(false);
  });

  test('each outcome', () => {
    const clean = { eventId: hex(5), createdAt: 100, dirty: false, modifiedAt: 90 };
    expect(mergeItem(null, { id: hex(1), created_at: 1 })).toBe('insert');
    expect(mergeItem(clean, { id: hex(5), created_at: 100 })).toBe('keep');
    expect(mergeItem(clean, { id: hex(6), created_at: 101 })).toBe('take');
    expect(mergeItem(clean, { id: hex(6), created_at: 99 })).toBe('keep');
    const dirty = { ...clean, dirty: true, modifiedAt: 150 };
    expect(mergeItem(dirty, { id: hex(6), created_at: 151 })).toBe('take');
    expect(mergeItem(dirty, { id: hex(6), created_at: 150 })).toBe('republish');
    expect(mergeItem({ eventId: null, createdAt: null, dirty: false, modifiedAt: null }, { id: hex(1), created_at: 1 })).toBe('take');
  });

  test('property: any order of the same events ends on the same newest event', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const events = Array.from({ length: 1 + r(8) }, (_, i) => ({ id: hex(r(50) * 10 + i), created_at: 100 + r(5) }));
      const best = events.reduce((a, b) => (replaces(b, a) ? b : a));
      for (let k = 0; k < 5; k++) {
        const shuffled = [...events].sort(() => r(3) - 1);
        expect([seed, apply(shuffled).local.eventId]).toEqual([seed, best.id]);
      }
    }
  });

  test('property: a local change survives every older event and yields to a newer one', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const at = 100 + r(10);
      const events = Array.from({ length: 1 + r(6) }, (_, i) => ({ id: hex(i + 1), created_at: 95 + r(20) }));
      const { local, republish } = apply(events, at);
      const newer = events.filter((e) => e.created_at > at);
      if (newer.length === 0) {
        expect([seed, local.dirty, republish]).toEqual([seed, true, true]);
      } else {
        // Once a newer event is taken, the row is clean and later events merge by the clean rule.
        expect([seed, local.dirty]).toEqual([seed, false]);
      }
    }
  });

  test('a deletion removes the row it postdates unless the row changed after it', () => {
    const row = { eventId: hex(1), createdAt: 100, dirty: false, modifiedAt: 90 };
    expect(deletionRemoves(row, 100)).toBe(true);
    expect(deletionRemoves(row, 99)).toBe(false);
    expect(deletionRemoves({ ...row, dirty: true, modifiedAt: 120 }, 110)).toBe(false);
    expect(deletionRemoves({ ...row, dirty: true, modifiedAt: 105 }, 110)).toBe(true);
    expect(deletionRemoves({ eventId: null, createdAt: null, dirty: true, modifiedAt: 50 }, 60)).toBe(true);
  });

  test("a kind 5's save hashes: only the owner's, only shelf/item addresses", () => {
    const e = {
      kind: 5, pubkey: PK, created_at: 1, id: '', sig: '', content: '',
      tags: [['a', `30078:${PK}:shelf/item/${H1}`], ['a', `30078:${PK}:shelf/item/${H1}`], ['a', `30078:${PK}:shelf/devices`],
        ['a', `30078:${'cd'.repeat(32)}:shelf/item/${H2}`], ['a', `30023:${PK}:shelf/item/${H2}`], ['e', H2], ['k', '30078']],
    } as NostrEvent;
    expect(deletedHashes(e, PK)).toEqual([H1]);
    expect(deletedHashes({ ...e, pubkey: 'cd'.repeat(32) }, PK)).toEqual([]);
    expect(deletedHashes({ ...e, kind: 1 }, PK)).toEqual([]);
  });
});
