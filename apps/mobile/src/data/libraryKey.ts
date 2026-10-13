// The library key (C§4.3, F5): every save's address is keyed by it, so nobody can test whether this library saved a
// page by hashing the page's URL. One per identity, kept on the relays in the self-encrypted kefli/library-key
// record. An identity made on this phone makes its key at its first publish; any other learns it at sync, and makes
// one only once its relays confirm there is none (services/sync.ts). The record on the relays wins over a key not yet
// published, and the newest record over an older: a phone holding another key takes it and moves its saves to their
// new addresses, each old address retired with a kind 5 as its save is published again (services/send.ts).
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { savedD } from '@kefli/protocol';
import type { SqlDb } from './db';
import { writeRelays } from './lists';
import { enqueue } from './outbox';

type KeyRow = { library_key: string | null; library_key_at: number | null; origin: string };

const row = (db: SqlDb, owner: string) =>
  db.get<KeyRow>('SELECT library_key, library_key_at, origin FROM identities WHERE pubkey = ?', owner);

export function libraryKey(db: SqlDb, owner: string): Uint8Array | null {
  const k = row(db, owner)?.library_key;
  return k ? hexToBytes(k) : null;
}

/** Whether this identity was made on this phone, so no other device can have published a key for it yet. */
export function madeHere(db: SqlDb, owner: string): boolean {
  const o = row(db, owner)?.origin;
  return o === 'new' || o === 'early_share';
}

/** A new key, kept, and its record queued to every write relay ahead of the saves it addresses. */
export function makeLibraryKey(db: SqlDb, now: number, owner: string, random: (n: number) => Uint8Array): Uint8Array {
  return db.tx(() => {
    const held = libraryKey(db, owner);
    if (held) return held;
    const key = random(32);
    db.run('UPDATE identities SET library_key = ?, library_key_at = NULL WHERE pubkey = ?', bytesToHex(key), owner);
    enqueue(db, now, { op: 'publish_library_key', signer: owner, subject: owner, targets: writeRelays(db, owner) });
    return key;
  });
}

/** Whether the key's record has reached a relay (or the key came from one). */
export function keyPublished(db: SqlDb, owner: string): boolean {
  return row(db, owner)?.library_key_at != null;
}

/** The record went out: its created_at, so a newer one on the relays is told apart from this one. */
export function libraryKeyPublished(db: SqlDb, owner: string, createdAt: number): void {
  db.run('UPDATE identities SET library_key_at = ? WHERE pubkey = ?', createdAt, owner);
}

/**
 * The newest record seen on the relays. Kept when this phone has no key; when it holds one not yet published, or an
 * older record's, the record seen wins: a key waiting to go out is dropped, and every save already published here
 * under another address is queued to be published at its new one. A record older than the one this phone holds
 * is ignored. Returns what happened.
 */
export function adoptLibraryKey(db: SqlDb, now: number, owner: string, key: Uint8Array, at: number): 'same' | 'kept' | 'moved' | 'older' {
  return db.tx(() => {
    const r = row(db, owner);
    const hex = bytesToHex(key);
    if (r?.library_key === hex) {
      db.run('UPDATE identities SET library_key_at = MAX(COALESCE(library_key_at, 0), ?) WHERE pubkey = ?', at, owner);
      return 'same';
    }
    if (r?.library_key && r.library_key_at !== null && r.library_key_at > at) return 'older';
    db.run('UPDATE identities SET library_key = ?, library_key_at = ? WHERE pubkey = ?', hex, at, owner);
    db.run("DELETE FROM outbox WHERE op = 'publish_library_key' AND signer = ? AND state IN ('held', 'queued')", owner);
    if (!r?.library_key) return 'kept';
    for (const it of db.all<{ hash: string; remote_d: string }>('SELECT hash, remote_d FROM items WHERE owner = ? AND remote_d IS NOT NULL AND pending_delete_at IS NULL', owner)) {
      if (it.remote_d !== savedD(key, it.hash)) enqueue(db, now, { op: 'publish_item', signer: owner, subject: it.hash, targets: writeRelays(db, owner), lane: 'bulk' });
    }
    return 'moved';
  });
}

/**
 * Where a deletion naming these addresses finds saves (F5): the address each save was last published or seen at,
 * and its address under the current key. An older address of a save since moved never matches, so retiring it can't
 * take the save with it. Returns address → hash.
 */
export function savesAt(db: SqlDb, owner: string, ds: string[]): Map<string, string> {
  const want = new Set(ds);
  const out = new Map<string, string>();
  if (!want.size) return out;
  const key = libraryKey(db, owner);
  for (const it of db.all<{ hash: string; remote_d: string | null }>('SELECT hash, remote_d FROM items WHERE owner = ?', owner)) {
    if (it.remote_d && want.has(it.remote_d)) out.set(it.remote_d, it.hash);
    if (key) {
      const d = savedD(key, it.hash);
      if (want.has(d)) out.set(d, it.hash);
    }
  }
  return out;
}

/** Every address a save of this identity may be at: for Delete my data and a move's retirement of the old identity. */
export function itemAddresses(db: SqlDb, owner: string): string[] {
  const key = libraryKey(db, owner);
  const out = new Set<string>();
  for (const it of db.all<{ hash: string; remote_d: string | null }>('SELECT hash, remote_d FROM items WHERE owner = ?', owner)) {
    if (it.remote_d) out.add(it.remote_d);
    if (key) out.add(savedD(key, it.hash));
  }
  return [...out];
}
