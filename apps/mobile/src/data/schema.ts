// Schema v1 (mobile spec 4.1): WAL, foreign keys on, hand-written migrations on PRAGMA user_version, each
// tested from every earlier version (test/schema.test.ts).
import type { SqlDb } from './db';

const V1 = `
CREATE TABLE identities (pubkey TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('local','nip55','nip46')),
  role TEXT NOT NULL CHECK (role IN ('active','move_source','move_target')),
  origin TEXT NOT NULL,
  has_recovery INTEGER NOT NULL, signer_package TEXT, registered_at INTEGER, created_at INTEGER NOT NULL);

CREATE TABLE items (id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL REFERENCES identities(pubkey),
  hash TEXT NOT NULL,
  v INTEGER NOT NULL DEFAULT 1, url TEXT NOT NULL, canonical TEXT, title TEXT, site TEXT, byline TEXT,
  saved_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('unread','archived')),
  progress REAL NOT NULL DEFAULT 0, words INTEGER, lang TEXT,
  text_sha256 TEXT, text_key TEXT, text_nonce TEXT, text_servers TEXT, text_hash TEXT, hero TEXT,
  source_kind TEXT NOT NULL DEFAULT 'web', source_ref TEXT, audio_pref TEXT,
  extra TEXT,
  event_id TEXT, event_created_at INTEGER, modified_at INTEGER,
  dirty INTEGER NOT NULL DEFAULT 0, published INTEGER NOT NULL DEFAULT 0,
  position_word INTEGER NOT NULL DEFAULT 0,
  text_state TEXT NOT NULL CHECK (text_state IN ('queued','fetching','cached','failed','remote','downloading')),
  fail_reason TEXT,
  shared_url TEXT, x_state TEXT, origin TEXT NOT NULL, origin_device TEXT,
  blocks_ver INTEGER, last_opened_at INTEGER, pending_delete_at INTEGER, UNIQUE (owner, hash));
CREATE INDEX items_list ON items(owner, state, saved_at DESC) WHERE pending_delete_at IS NULL;
CREATE TABLE items_future (owner TEXT, d TEXT, event_json TEXT, created_at INTEGER, PRIMARY KEY (owner, d));
CREATE VIRTUAL TABLE items_fts USING fts5(title, site, url, body, content='', contentless_delete=1,
  tokenize='unicode61 remove_diacritics 2', prefix='2 3');

CREATE TABLE listen_history (item INTEGER PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  last_played_at INTEGER NOT NULL);
CREATE TABLE cover_drawn (hash TEXT, surface TEXT CHECK (surface IN ('list','sheet','welcome')),
  drawn_at INTEGER, PRIMARY KEY (hash, surface));
CREATE TABLE images (url TEXT PRIMARY KEY, hash TEXT,
  path TEXT, bytes INTEGER, w INTEGER, h INTEGER, fetched_at INTEGER, last_used_at INTEGER);
CREATE TABLE blobs (sha256 TEXT PRIMARY KEY, hash TEXT, kind TEXT CHECK (kind IN ('text','inbox')),
  staged_path TEXT, size INTEGER, owner TEXT, operator_at INTEGER, mirror_at INTEGER,
  mirror_url TEXT, last_error TEXT);

CREATE TABLE outbox (id INTEGER PRIMARY KEY, op TEXT NOT NULL, signer TEXT NOT NULL,
  subject TEXT NOT NULL, payload TEXT, depends_on INTEGER REFERENCES outbox(id) ON DELETE SET NULL,
  lane TEXT CHECK (lane IN ('interactive','bulk')), not_before INTEGER, created_at INTEGER NOT NULL,
  state TEXT CHECK (state IN ('held','queued','sending','dead')), was_queued INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX outbox_pending ON outbox(op, signer, subject) WHERE state IN ('held','queued');
CREATE TABLE outbox_targets (outbox_id INTEGER REFERENCES outbox(id) ON DELETE CASCADE, target TEXT,
  state TEXT CHECK (state IN ('pending','ok','rejected','gave_up')), attempts INTEGER,
  next_at INTEGER, last_error TEXT, event_id TEXT, PRIMARY KEY (outbox_id, target));

CREATE TABLE relays (url TEXT, owner TEXT, read INTEGER, write INTEGER,
  source TEXT CHECK (source IN ('operator','default','user','indexer')), added_by_shelf INTEGER,
  status TEXT, last_ok_at INTEGER, PRIMARY KEY (url, owner));
CREATE TABLE servers (url TEXT, owner TEXT, role TEXT CHECK (role IN ('operator','mirror','user')),
  in_10063 INTEGER, added_by_shelf INTEGER, status TEXT, PRIMARY KEY (url, owner));
CREATE TABLE lists (owner TEXT, kind INTEGER, d TEXT NOT NULL DEFAULT '', event_id TEXT, created_at INTEGER,
  raw TEXT, PRIMARY KEY (owner, kind, d));
CREATE TABLE sync_cursors (relay TEXT, stream TEXT CHECK (stream IN ('items','deletions','inbox','lists')),
  owner TEXT, since INTEGER, backfilled INTEGER, last_eose_at INTEGER, PRIMARY KEY (relay, stream, owner));
CREATE TABLE inbox_seen (wrap_id TEXT PRIMARY KEY, owner TEXT, seen_at INTEGER, request_d TEXT,
  device TEXT, hash TEXT, kind5 TEXT, wrap_json TEXT,
  outcome TEXT);
CREATE TABLE devices (device_pubkey TEXT, owner TEXT, label TEXT, token TEXT, relay TEXT,
  connected_at INTEGER, revoked_at INTEGER, last_save_at INTEGER, PRIMARY KEY (device_pubkey, owner));
CREATE TABLE jobs (id TEXT PRIMARY KEY,
  kind TEXT CHECK (kind IN ('restore','move','import','delete_account')),
  state TEXT, step INTEGER, data TEXT, started_at INTEGER, updated_at INTEGER);
CREATE TABLE job_items (job_id TEXT, subject TEXT, state TEXT, PRIMARY KEY (job_id, subject));
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** MIGRATIONS[n] takes the database from version n to n + 1. */
export const MIGRATIONS: ((db: SqlDb) => void)[] = [(db) => db.exec(V1)];
export const SCHEMA_VERSION = MIGRATIONS.length;

/** Opens the schema: WAL, foreign keys, then every migration past the stored version, each in a transaction. */
export function migrate(db: SqlDb): number {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  let v = db.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
  if (v > SCHEMA_VERSION) throw new Error(`database version ${v} is newer than this app (${SCHEMA_VERSION})`);
  while (v < SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    const next = v + 1;
    db.tx(() => {
      step(db);
      db.exec(`PRAGMA user_version = ${next}`);
    });
    v = next;
  }
  return v;
}
