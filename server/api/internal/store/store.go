// Package store is keflid's one SQLite database (backend spec 2): accounts and their quota, authorised device keys,
// blob ownership, the pairing offers, NIP-98 ids already used, and the keys whose wraps the relay must drop. The
// relay's write policy opens the same file read-only for the allowlist. Nothing here is ever a URL, a title or text.
package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// DefaultQuota is a new library's quota under contract 5's fair use, 50 MB (flow decision 117; 200 MB until contract
// 1.12), counting the user's uploads and their devices' together, each blob once.
const DefaultQuota int64 = 50 << 20

// DailyLimit is the most a library's uploads may add to the disk in any 24 hours (contract 5: 20 MB).
const DailyLimit int64 = 20 << 20

// Day is the window DailyLimit counts over, and how long the uploads log keeps a row.
const Day = 24 * time.Hour

// InboxLife is how long a device's inbox blob is kept (contract 5: 14 days).
const InboxLife = 14 * 24 * time.Hour

// OfferLife is how long a pairing offer is held (contract 6: five minutes).
const OfferLife = 5 * time.Minute

// GoneLife is how long a removed key stays on the gone list. The relay's nightly sweep drops wraps addressed to it at
// once and its own events after 30 days (contract 3.2); the month past that leaves room for nights the sweep missed,
// after which the row would only make every sweep longer (F45).
const GoneLife = 60 * 24 * time.Hour

var ErrTaken = errors.New("lookup taken")

// ErrNoAccount is an upload's record refused because its library's account has gone (Upload).
var ErrNoAccount = errors.New("no account")

const schema = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS accounts (
  pubkey      TEXT PRIMARY KEY,
  quota_bytes INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  disabled    INTEGER NOT NULL DEFAULT 0,
  nip05_name  TEXT
);
CREATE INDEX IF NOT EXISTS accounts_created ON accounts(created_at);
CREATE TABLE IF NOT EXISTS devices (
  device_pubkey TEXT PRIMARY KEY,
  user_pubkey   TEXT NOT NULL REFERENCES accounts(pubkey) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS devices_user ON devices(user_pubkey);
-- One row per blob and uploader. account is whose quota it counts against: the uploader, or a device's user.
-- expires_at is set for a device's inbox blob; a user's own blob lives until its owner deletes it.
CREATE TABLE IF NOT EXISTS owners (
  sha256     TEXT NOT NULL,
  owner      TEXT NOT NULL,
  account    TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (sha256, owner)
);
CREATE INDEX IF NOT EXISTS owners_account ON owners(account);
CREATE INDEX IF NOT EXISTS owners_expiry ON owners(expires_at) WHERE expires_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS offers (
  kind       TEXT NOT NULL,
  lookup     TEXT NOT NULL,
  offer      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (kind, lookup)
);
CREATE TABLE IF NOT EXISTS used_auth (
  id    TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);
-- Keys no longer registered or authorised: the relay's sweep drops wraps addressed to them (contract 3.2).
CREATE TABLE IF NOT EXISTS gone (
  pubkey TEXT PRIMARY KEY,
  at     INTEGER NOT NULL
);
-- One row per upload that added a blob to the disk, against the library it counts for: what DailyLimit counts (contract
-- 5). A blob the server already stores, for anyone, adds no row, and rows go only once a day old, so deleting a blob
-- gives none of the day back. No hash is kept.
CREATE TABLE IF NOT EXISTS uploads (
  account TEXT NOT NULL,
  size    INTEGER NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS uploads_account ON uploads(account, at);
-- Browser labels are no longer kept (F30): any stored before go. The column stays, empty, so no migration is needed.
UPDATE devices SET label = '' WHERE label != '';
`

// steps are the schema's versioned changes (PRAGMA user_version): step i takes the database from version i to i+1, in
// the transaction that records it, so each runs once. The schema above is applied at every open and changes nothing a
// second time; a change that must not run twice goes here.
var steps = []string{
	// 1, contract 1.12 (flow decision 117): libraries still at the old default of 200 MB (209,715,200 bytes) fall to the
	// new 50 MB (52,428,800). A quota set to any other figure is kept, and so is one set to 200 MB after this has run.
	`UPDATE accounts SET quota_bytes = 52428800 WHERE quota_bytes = 209715200`,
}

type Store struct {
	db  *sql.DB
	Now func() time.Time
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)", path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("schema: %w", err)
	}
	if err := migrate(db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db, Now: time.Now}, nil
}

// migrate runs the steps the database hasn't had. A database from a newer keflid, at a version past the last step
// here, isn't opened, since this code can't know what its steps changed.
func migrate(db *sql.DB) error {
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil {
		return fmt.Errorf("schema version: %w", err)
	}
	if version > len(steps) {
		return fmt.Errorf("schema version %d is newer than this keflid's %d", version, len(steps))
	}
	for v := version; v < len(steps); v++ {
		if err := runStep(db, v); err != nil {
			return fmt.Errorf("schema version %d: %w", v+1, err)
		}
	}
	return nil
}

// runStep runs steps[v] and records version v+1 in one transaction: a step that fails leaves the version as it was.
func runStep(db *sql.DB, v int) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(steps[v]); err != nil {
		return err
	}
	if _, err := tx.Exec(fmt.Sprintf("PRAGMA user_version = %d", v+1)); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) unix() int64 { return s.Now().Unix() }

// Register adds the pubkey with the default quota; registering again changes nothing (contract 6: idempotent). A key
// registered again after deleting its account is taken off the gone list.
func (s *Store) Register(ctx context.Context, pubkey string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO accounts(pubkey, quota_bytes, created_at) VALUES(?, ?, ?) ON CONFLICT(pubkey) DO NOTHING`, pubkey, DefaultQuota, s.unix())
	if err == nil {
		_, err = s.db.ExecContext(ctx, `DELETE FROM gone WHERE pubkey = ?`, pubkey)
	}
	return err
}

// Registrations counts the accounts made since a time: the API's limit on new accounts from everyone (F8), which a
// restart doesn't reset.
func (s *Store) Registrations(ctx context.Context, since time.Time) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM accounts WHERE created_at > ?`, since.Unix()).Scan(&n)
	return n, err
}

// SetDisabled takes a key off the allowlist, or puts it back, keeping its blobs (backend spec 5: keflictl).
func (s *Store) SetDisabled(ctx context.Context, pubkey string, disabled bool) error {
	_, err := s.db.ExecContext(ctx, `UPDATE accounts SET disabled = ? WHERE pubkey = ?`, disabled, pubkey)
	return err
}

// SetQuota sets one library's quota in bytes (flow decision 117: keflictl quota), which it keeps from then on; found
// is false when the key has no account. A library left above its new quota keeps its blobs (contract 5).
func (s *Store) SetQuota(ctx context.Context, pubkey string, quota int64) (found bool, err error) {
	res, err := s.db.ExecContext(ctx, `UPDATE accounts SET quota_bytes = ? WHERE pubkey = ?`, quota, pubkey)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}

// Account is a registered, enabled user.
func (s *Store) Account(ctx context.Context, pubkey string) (quota int64, ok bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT quota_bytes FROM accounts WHERE pubkey = ? AND disabled = 0`, pubkey).Scan(&quota)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return quota, err == nil, err
}

// AddDevice authorises a device key for the user; a key already authorised for another user moves to this one. The API
// calls it only with the device's own proof or its holder's release (contract 4.4, 4.8, F44). The browser's label
// isn't kept (F30).
func (s *Store) AddDevice(ctx context.Context, user, device string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO devices(device_pubkey, user_pubkey, label, created_at) VALUES(?, ?, '', ?)
		ON CONFLICT(device_pubkey) DO UPDATE SET user_pubkey = excluded.user_pubkey`, device, user, s.unix())
	if err == nil {
		_, err = s.db.ExecContext(ctx, `DELETE FROM gone WHERE pubkey = ?`, device)
	}
	return err
}

// DeviceHolder is the user a device key is authorised for, whether or not that account is enabled: the library whose
// release a move needs (contract 4.8 step 4).
func (s *Store) DeviceHolder(ctx context.Context, device string) (string, bool, error) {
	var user string
	err := s.db.QueryRowContext(ctx, `SELECT user_pubkey FROM devices WHERE device_pubkey = ?`, device).Scan(&user)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return user, err == nil, err
}

// DeviceUser is the user a device key uploads for, if it is authorised.
func (s *Store) DeviceUser(ctx context.Context, device string) (string, bool, error) {
	var user string
	err := s.db.QueryRowContext(ctx, `SELECT d.user_pubkey FROM devices d JOIN accounts a ON a.pubkey = d.user_pubkey WHERE d.device_pubkey = ? AND a.disabled = 0`, device).Scan(&user)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	return user, err == nil, err
}

// Gone lists the keys removed since a time, for the relay's sweep.
func (s *Store) Gone(ctx context.Context, since int64) ([]string, error) {
	return s.gone(ctx, `SELECT pubkey FROM gone WHERE at >= ?`, since)
}

// GoneFor lists the keys removed at least a while ago: the relay's sweep drops their own events after 30 days (contract
// 3.2) and the wraps addressed to them at once.
func (s *Store) GoneFor(ctx context.Context, age time.Duration) ([]string, error) {
	return s.gone(ctx, `SELECT pubkey FROM gone WHERE at <= ? ORDER BY pubkey`, s.Now().Add(-age).Unix())
}

func (s *Store) gone(ctx context.Context, query string, arg int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, query, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// Offer holds a pairing offer for five minutes; ErrTaken when an unexpired one already has the lookup (contract 6).
func (s *Store) PutOffer(ctx context.Context, kind, lookup, offer string) error {
	now := s.unix()
	res, err := s.db.ExecContext(ctx, `INSERT INTO offers(kind, lookup, offer, expires_at) VALUES(?, ?, ?, ?)
		ON CONFLICT(kind, lookup) DO UPDATE SET offer = excluded.offer, expires_at = excluded.expires_at WHERE offers.expires_at <= ?`,
		kind, lookup, offer, now+int64(OfferLife.Seconds()), now)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return ErrTaken
	}
	return nil
}

// TakeOffer returns an unexpired offer; with remove, it is deleted as it is read (a phone offer is fetched once).
func (s *Store) TakeOffer(ctx context.Context, kind, lookup string, remove bool) (string, bool, error) {
	var offer string
	err := s.db.QueryRowContext(ctx, `SELECT offer FROM offers WHERE kind = ? AND lookup = ? AND expires_at > ?`, kind, lookup, s.unix()).Scan(&offer)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if remove {
		_, err = s.db.ExecContext(ctx, `DELETE FROM offers WHERE kind = ? AND lookup = ?`, kind, lookup)
	}
	return offer, err == nil, err
}

// UseAuth records an authorisation event's id; false if it was used already in its window (replay).
func (s *Store) UseAuth(ctx context.Context, id string, until int64) (bool, error) {
	res, err := s.db.ExecContext(ctx, `INSERT INTO used_auth(id, until) VALUES(?, ?) ON CONFLICT(id) DO NOTHING`, id, until)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n == 1, nil
}

// Sweep removes expired offers, used authorisation ids, keys gone longer than GoneLife and uploads a day old, which
// no longer count against a library's day. Expired inbox blobs are ExpireInbox's.
func (s *Store) Sweep(ctx context.Context) error {
	now := s.unix()
	for _, q := range []struct {
		query string
		arg   int64
	}{
		{`DELETE FROM offers WHERE expires_at <= ?`, now},
		{`DELETE FROM used_auth WHERE until <= ?`, now},
		{`DELETE FROM gone WHERE at <= ?`, s.Now().Add(-GoneLife).Unix()},
		{`DELETE FROM uploads WHERE at <= ?`, s.Now().Add(-Day).Unix()},
	} {
		if _, err := s.db.ExecContext(ctx, q.query, q.arg); err != nil {
			return err
		}
	}
	return nil
}
