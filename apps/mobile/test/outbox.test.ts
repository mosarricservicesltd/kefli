import { migrate } from '../src/data/schema';
import { backoff, enqueue, finish, nextDue, nextWakeAt, release, releaseOrphans, undo, begin } from '../src/data/outbox';
import { memoryDb } from './sqlite';

const ME = 'a'.repeat(64);
const setup = () => {
  const db = memoryDb();
  migrate(db);
  return db;
};
const row = (db: ReturnType<typeof setup>, id: number) => db.get<{ state: string; was_queued: number; payload: string }>('SELECT * FROM outbox WHERE id = ?', id);

describe('outbox (mobile spec 4.3)', () => {
  test('backoff: 30 s doubling to an hour', () => {
    expect([1, 2, 3, 4, 8, 20].map(backoff)).toEqual([30, 60, 120, 240, 3600, 3600]);
  });

  test('one pending row per op, signer and subject: a change merges and resets its targets', () => {
    const db = setup();
    const a = enqueue(db, 0, { op: 'publish_item', signer: ME, subject: 'h', payload: { n: 1 }, targets: ['r1', 'r2'] });
    begin(db, a);
    finish(db, 10, a, [{ target: 'r1', kind: 'ok' }, { target: 'r2', kind: 'retry', error: 'x' }]);
    const b = enqueue(db, 20, { op: 'publish_item', signer: ME, subject: 'h', payload: { n: 2 }, targets: ['r1', 'r2'] });
    expect(b).toBe(a);
    expect(JSON.parse(row(db, a)!.payload)).toEqual({ n: 2 });
    expect(db.all("SELECT * FROM outbox_targets WHERE outbox_id = ? AND state = 'pending'", a)).toHaveLength(2);
  });

  test('a held change merged into a queued row turns it held with was_queued; Undo returns it to the queue', () => {
    const db = setup();
    const id = enqueue(db, 0, { op: 'publish_item', signer: ME, subject: 'h', targets: ['r1'] });
    enqueue(db, 1, { op: 'publish_item', signer: ME, subject: 'h', targets: ['r1'], held: true });
    expect(row(db, id)).toMatchObject({ state: 'held', was_queued: 1 });
    undo(db, [id]);
    expect(row(db, id)).toMatchObject({ state: 'queued', was_queued: 0 });
  });

  test('a change merged into a held row sets was_queued, so Undo keeps it', () => {
    const db = setup();
    const id = enqueue(db, 0, { op: 'publish_item', signer: ME, subject: 'h', targets: ['r1'], held: true });
    enqueue(db, 1, { op: 'publish_item', signer: ME, subject: 'h', targets: ['r1'] });
    expect(row(db, id)).toMatchObject({ state: 'held', was_queued: 1 });
    undo(db, [id]);
    expect(row(db, id)?.state).toBe('queued');
  });

  test('Undo of a fresh held row deletes it; release queues it', () => {
    const db = setup();
    const a = enqueue(db, 0, { op: 'upload_blob', signer: ME, subject: 's1', targets: ['b'], held: true });
    const b = enqueue(db, 0, { op: 'upload_blob', signer: ME, subject: 's2', targets: ['b'], held: true });
    expect(nextDue(db, 0)).toBeNull();
    undo(db, [a]);
    release(db, [b]);
    expect(row(db, a)).toBeUndefined();
    expect(nextDue(db, 0)?.row.id).toBe(b);
  });

  test('held rows left by a process death are queued at the next start', () => {
    const db = setup();
    const a = enqueue(db, 0, { op: 'upload_blob', signer: ME, subject: 's', targets: ['b'], held: true });
    releaseOrphans(db);
    expect(row(db, a)?.state).toBe('queued');
  });

  test('a retried target waits by backoff; the row is due again then', () => {
    const db = setup();
    const id = enqueue(db, 0, { op: 'register', signer: ME, subject: ME, targets: ['api'] });
    begin(db, id);
    expect(finish(db, 100, id, [{ target: 'api', kind: 'retry', error: 'down' }])).toBe('queued');
    expect(nextDue(db, 129)).toBeNull();
    expect(nextWakeAt(db)).toBe(130);
    expect(nextDue(db, 130)?.row.id).toBe(id);
  });

  test('dependents are released as soon as one relay accepts, while another never answers', () => {
    const db = setup();
    const pub = enqueue(db, 0, { op: 'publish_item', signer: ME, subject: 'h', targets: ['r1', 'r2'] });
    const dep = enqueue(db, 0, { op: 'publish_lists', signer: ME, subject: ME, targets: ['r1'], dependsOn: pub });
    expect(nextDue(db, 0)?.row.id).toBe(pub);
    begin(db, pub);
    finish(db, 0, pub, [{ target: 'r1', kind: 'ok' }, { target: 'r2', kind: 'retry', error: 'timeout' }]);
    expect(row(db, pub)?.state).toBe('queued');
    expect(nextDue(db, 0)?.row.id).toBe(dep);
  });

  test('a refused prerequisite kills its dependents', () => {
    const db = setup();
    const up = enqueue(db, 0, { op: 'upload_blob', signer: ME, subject: 's', targets: ['b'] });
    const mi = enqueue(db, 0, { op: 'mirror_blob', signer: ME, subject: 's', targets: ['m'], dependsOn: up });
    const pub = enqueue(db, 0, { op: 'publish_item', signer: ME, subject: 'h', targets: ['r1'], dependsOn: mi });
    begin(db, up);
    expect(finish(db, 0, up, [{ target: 'b', kind: 'rejected', error: 'invalid' }])).toBe('dead');
    expect([row(db, mi)?.state, row(db, pub)?.state]).toEqual(['dead', 'dead']);
    expect(nextDue(db, 0)).toBeNull();
  });

  test('a row is deleted once every target has finished with one ok', () => {
    const db = setup();
    const id = enqueue(db, 0, { op: 'publish_item', signer: ME, subject: 'h', targets: ['r1', 'r2'] });
    begin(db, id);
    expect(finish(db, 0, id, [{ target: 'r1', kind: 'ok' }, { target: 'r2', kind: 'rejected', error: 'blocked: no' }])).toBe('done');
    expect(row(db, id)).toBeUndefined();
  });

  test('a change made during an attempt replaces the row when the attempt ends', () => {
    const db = setup();
    const a = enqueue(db, 0, { op: 'publish_item', signer: ME, subject: 'h', payload: { n: 1 }, targets: ['r1'] });
    begin(db, a);
    const b = enqueue(db, 1, { op: 'publish_item', signer: ME, subject: 'h', payload: { n: 2 }, targets: ['r1'] });
    expect(b).not.toBe(a);
    expect(finish(db, 2, a, [{ target: 'r1', kind: 'ok' }])).toBe('superseded');
    expect(nextDue(db, 2)?.row.id).toBe(b);
  });

  test('a retarget swaps the target and can wait', () => {
    const db = setup();
    const id = enqueue(db, 0, { op: 'mirror_blob', signer: ME, subject: 's', targets: ['m1'] });
    begin(db, id);
    finish(db, 0, id, [{ target: 'm1', kind: 'retarget', next: 'm2', error: '400' }]);
    expect(nextDue(db, 0)?.targets.map((t) => t.target)).toEqual(['m2']);
    begin(db, id);
    finish(db, 0, id, [{ target: 'm2', kind: 'retarget', next: 'm1', error: '400', delaySec: 86400 }]);
    expect(nextDue(db, 86399)).toBeNull();
    expect(nextDue(db, 86400)?.targets.map((t) => t.target)).toEqual(['m1']);
  });

  test('interactive rows go before bulk ones', () => {
    const db = setup();
    enqueue(db, 0, { op: 'publish_item', signer: ME, subject: 'bulk', targets: ['r'], lane: 'bulk' });
    const i = enqueue(db, 5, { op: 'publish_item', signer: ME, subject: 'now', targets: ['r'] });
    expect(nextDue(db, 5)?.row.id).toBe(i);
  });
});
