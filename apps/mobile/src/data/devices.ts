// Connected browsers (mobile spec 5.5, contract 4.4 and 4.9): the devices table holds the connected-browsers
// record, one row per token. A copy from a relay merges in by token, keeping every entry and the earlier
// revoked_at; when this phone holds anything the copy lacks, the record is republished. Connect queues
// post_device then pair_ack; the pair-ack's success writes the row. Disconnect revokes at once.
import { DEVICES_D, KIND, mergeDevices, type DevicesRecord } from '@kefli/protocol';
import type { SqlDb } from './db';
import { indexerRelays, writeRelays } from './lists';
import { enqueue } from './outbox';

type DeviceRow = { token: string; device_pubkey: string; label: string; connected_at: number; revoked_at: number | null };

export type Browser = { device_pubkey: string; label: string; connected_at: number };

export function localRecord(db: SqlDb, owner: string): DevicesRecord {
  const rows = db.all<DeviceRow>('SELECT token, device_pubkey, label, connected_at, revoked_at FROM devices WHERE owner = ?', owner);
  return mergeDevices({ v: 1, devices: rows.map((r) => ({ ...r })) }, { v: 1, devices: [] });
}

export function hasDevices(db: SqlDb, owner: string): boolean {
  return !!db.get('SELECT 1 FROM devices WHERE owner = ?', owner);
}

/** The created_at of the newest copy sent or seen, so a republish always replaces it. */
export function recordCreatedAt(db: SqlDb, owner: string): number {
  return db.get<{ created_at: number }>('SELECT created_at FROM lists WHERE owner = ? AND kind = ? AND d = ?', owner, KIND.appData, DEVICES_D)?.created_at ?? 0;
}

export function noteRecord(db: SqlDb, owner: string, eventId: string, createdAt: number): void {
  if (recordCreatedAt(db, owner) > createdAt) return;
  db.run('INSERT OR REPLACE INTO lists (owner, kind, d, event_id, created_at, raw) VALUES (?, ?, ?, ?, ?, NULL)', owner, KIND.appData, DEVICES_D, eventId, createdAt);
}

function writeEntries(db: SqlDb, owner: string, record: DevicesRecord): void {
  for (const e of record.devices) {
    db.run(
      `INSERT INTO devices (token, owner, device_pubkey, label, connected_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (token, owner) DO UPDATE SET revoked_at = excluded.revoked_at`,
      e.token, owner, e.device_pubkey, e.label, e.connected_at, e.revoked_at,
    );
  }
}

/** A copy from a relay, merged in by token. Returns whether this phone holds more than the copy, so must republish. */
export function absorbRecord(db: SqlDb, owner: string, remote: DevicesRecord, eventId: string, createdAt: number): boolean {
  return db.tx(() => {
    const merged = mergeDevices(localRecord(db, owner), remote);
    writeEntries(db, owner, merged);
    noteRecord(db, owner, eventId, createdAt);
    const held = new Set(remote.devices.map((e) => `${e.token}:${e.revoked_at}`));
    return merged.devices.some((e) => !held.has(`${e.token}:${e.revoked_at}`));
  });
}

/** A browser counts as connected while it has an entry with no revoked_at; one row per browser, newest first. */
export function connectedBrowsers(db: SqlDb, owner: string): Browser[] {
  return db.all<Browser>(
    `SELECT device_pubkey, label, MAX(connected_at) AS connected_at FROM devices WHERE owner = ? AND revoked_at IS NULL
     GROUP BY device_pubkey ORDER BY connected_at DESC`,
    owner,
  );
}

export function browserCount(db: SqlDb, owner: string): number {
  return db.get<{ n: number }>('SELECT COUNT(DISTINCT device_pubkey) AS n FROM devices WHERE owner = ? AND revoked_at IS NULL', owner)?.n ?? 0;
}

/** The record goes out with the lists (4.3): the write relays and the indexer, after register. */
export function queueRecord(db: SqlDb, now: number, owner: string): number {
  const register = db.get<{ id: number }>("SELECT id FROM outbox WHERE op = 'register' AND signer = ? AND state IN ('held','queued','sending')", owner)?.id ?? null;
  const targets = [...new Set([...writeRelays(db, owner), ...indexerRelays(db, owner)])];
  return enqueue(db, now, { op: 'publish_lists', signer: owner, subject: owner, targets, dependsOn: register });
}

export type PairPayload = { device_pubkey: string; label: string; nonce: string; token: string; relay: string };
export type ConnectRows = { register: number | null; post: number; ack: number };

/** Connect (5.5): post_device to the API, then the pair-ack to the device on the offer's relay. */
export function queueConnect(db: SqlDb, now: number, owner: string, api: string, pair: PairPayload, register: number | null): ConnectRows {
  return db.tx(() => {
    const post = enqueue(db, now, {
      op: 'post_device', signer: owner, subject: pair.token, payload: { device_pubkey: pair.device_pubkey, label: pair.label },
      targets: [`${api}/devices`], dependsOn: register,
    });
    const ack = enqueue(db, now, { op: 'pair_ack', signer: owner, subject: pair.token, payload: pair, targets: [pair.relay], dependsOn: post });
    return { register, post, ack };
  });
}

/** The pair-ack was taken: the browser joins the record, which is republished. */
export function pairAcked(db: SqlDb, now: number, owner: string, pair: PairPayload): void {
  db.tx(() => {
    db.run(
      'INSERT OR IGNORE INTO devices (token, owner, device_pubkey, label, relay, connected_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL)',
      pair.token, owner, pair.device_pubkey, pair.label, pair.relay, now,
    );
    queueRecord(db, now, owner);
  });
}

export type ConnectState = 'connected' | 'failed' | 'waiting';

/**
 * How a Connect stands after a run of the outbox. Any failed attempt along the way is Can't connect (5.5), since
 * the person is waiting on the busy button; the queued rows are then withdrawn by cancelConnect.
 */
export function connectState(db: SqlDb, owner: string, token: string, rows: ConnectRows): ConnectState {
  if (db.get('SELECT 1 FROM devices WHERE owner = ? AND token = ?', owner, token)) return 'connected';
  const ids = [rows.register, rows.post, rows.ack].filter((x): x is number => x !== null);
  const marks = ids.map(() => '?').join(', ');
  const dead = db.get(`SELECT 1 FROM outbox WHERE id IN (${marks}) AND state = 'dead'`, ...ids);
  const tried = db.get(`SELECT 1 FROM outbox_targets WHERE outbox_id IN (${marks}) AND state = 'pending' AND attempts > 0`, ...ids);
  return dead || tried ? 'failed' : 'waiting';
}

/**
 * Can't connect: the pair rows go, and a device the API already took is let go again with delete_device.
 * register is left to retry on its own.
 */
export function cancelConnect(db: SqlDb, now: number, owner: string, api: string, rows: ConnectRows, devicePubkey: string): void {
  db.tx(() => {
    const posted = !db.get('SELECT 1 FROM outbox WHERE id = ?', rows.post);
    db.run('DELETE FROM outbox WHERE id IN (?, ?)', rows.post, rows.ack);
    if (posted) queueRelease(db, now, owner, api, devicePubkey);
  });
}

function queueRelease(db: SqlDb, now: number, owner: string, api: string, devicePubkey: string): void {
  enqueue(db, now, { op: 'delete_device', signer: owner, subject: devicePubkey, targets: [`${api}/devices/${devicePubkey}`] });
}

/** Disconnect (5.5): every live entry for the browser is revoked at once, the record republished, the key let go. */
export function disconnect(db: SqlDb, now: number, owner: string, api: string, devicePubkey: string): void {
  db.tx(() => {
    db.run('UPDATE devices SET revoked_at = ? WHERE owner = ? AND device_pubkey = ? AND revoked_at IS NULL', now, owner, devicePubkey);
    queueRecord(db, now, owner);
    queueRelease(db, now, owner, api, devicePubkey);
  });
}
