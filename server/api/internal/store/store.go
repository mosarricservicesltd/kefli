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

// DefaultQuota is contract 5's 200 MB per user, counting uploads by the user's devices.
const DefaultQuota int64 = 200 * 1024 * 1024

// InboxLife is how long a device's inbox blob is kept (contract 5: 14 days).
const InboxLife = 14 * 24 * time.Hour

// OfferLife is how long a pairing offer is held (contract 6: five minutes).
const OfferLife = 5 * time.Minute

// GoneLife is how long a removed key stays on the gone list. The relay's nightly sweep drops wraps addressed to it at
// once and its own events after 30 days (contract 3.2); the month past that leaves room for nights the sweep missed,
// after which the row would only make every sweep longer (F45).
const GoneLife = 60 * 24 * time.Hour

var ErrTaken = errors.New("lookup taken")

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
-- Browser labels are no longer kept (F30): any stored before go. The column stays, empty, so no migration is needed.
UPDATE devices SET label = '' WHERE label != '';
`

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
	return &Store{db: db, Now: time.Now}, nil
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

// Account is a registered, enabled user.
func (s *Store) Account(ctx context.Context, pubkey string) (quota int64, ok bool, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT quota_bytes FROM accounts WHERE pubkey = ? AND disabled = 0`, pubkey).Scan(&quota)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return quota, err == nil, err
}

// AddDevice authorises a device key for the user; a key already authorised for another user moves (a move, contract 4.8).
// The browser's label isn't kept (F30).
func (s *Store) AddDevice(ctx context.Context, user, device string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO devices(device_pubkey, user_pubkey, label, created_at) VALUES(?, ?, '', ?)
		ON CONFLICT(device_pubkey) DO UPDATE SET user_pubkey = excluded.user_pubkey`, device, user, s.unix())
	if err == nil {
		_, err = s.db.ExecContext(ctx, `DELETE FROM gone WHERE pubkey = ?`, device)
	}
	return err
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

// Sweep removes expired offers, used authorisation ids and keys gone longer than GoneLife. Expired inbox blobs are
// ExpireInbox's.
func (s *Store) Sweep(ctx context.Context) error {
	now := s.unix()
	for _, q := range []struct {
		query string
		arg   int64
	}{
		{`DELETE FROM offers WHERE expires_at <= ?`, now},
		{`DELETE FROM used_auth WHERE until <= ?`, now},
		{`DELETE FROM gone WHERE at <= ?`, s.Now().Add(-GoneLife).Unix()},
	} {
		if _, err := s.db.ExecContext(ctx, q.query, q.arg); err != nil {
			return err
		}
	}
	return nil
}
