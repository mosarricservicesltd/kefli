package store

import (
	"context"
	"database/sql"
	"errors"
)

// Figures are a library's standing under contract 5's fair use, in bytes, as GET /account answers them and the 413s
// quota and daily carry them (contract 5, 6): its quota and what its blobs take of it, the most its uploads may add to
// the disk in any 24 hours and what they added in the last 24.
type Figures struct {
	Quota int64 `json:"quota"`
	Used  int64 `json:"used"`
	Daily int64 `json:"daily"`
	Today int64 `json:"today"`
}

// Figures reads a library's figures, its account enabled or not; ok is false when the key has no account.
func (s *Store) Figures(ctx context.Context, account string) (Figures, bool, error) {
	f := Figures{Daily: DailyLimit}
	err := s.db.QueryRowContext(ctx, `SELECT quota_bytes FROM accounts WHERE pubkey = ?`, account).Scan(&f.Quota)
	if errors.Is(err, sql.ErrNoRows) {
		return Figures{}, false, nil
	}
	if err == nil {
		f.Used, err = s.Used(ctx, account)
	}
	if err == nil {
		f.Today, err = s.Today(ctx, account)
	}
	return f, err == nil, err
}

// live keeps the owner rows the library still holds: a device's inbox row past its 14 days no longer counts (contract
// 4.4, 5), from the moment it expires, though the hourly sweep may not have removed it yet.
const live = `(expires_at IS NULL OR expires_at > ?)`

// Used is the bytes counted against the user's quota: each blob once, whether the user or one of their devices holds it.
func (s *Store) Used(ctx context.Context, account string) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(size), 0) FROM (SELECT sha256, MAX(size) AS size FROM owners WHERE account = ? AND `+live+` GROUP BY sha256)`, account, s.unix()).Scan(&n)
	return n, err
}

// Today is what the library's uploads added to the disk in the last 24 hours, from the uploads log (contract 5).
func (s *Store) Today(ctx context.Context, account string) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(size), 0) FROM uploads WHERE account = ? AND at > ?`, account, s.Now().Add(-Day).Unix()).Scan(&n)
	return n, err
}

// Holds is whether the user, or one of their devices, already owns the blob, so a repeat upload costs no quota. An
// expired inbox row holds nothing, as Used doesn't count it.
func (s *Store) Holds(ctx context.Context, account, sha string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM owners WHERE account = ? AND sha256 = ? AND `+live+` LIMIT 1`, account, sha, s.unix()).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// querier is the database or a transaction.
type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Stored is whether any owner holds the blob, an expired inbox row the sweep hasn't reached yet included: its file is
// on the disk, so an upload of it adds nothing to a library's day (contract 5).
func (s *Store) Stored(ctx context.Context, sha string) (bool, error) {
	return stored(ctx, s.db, sha)
}

func stored(ctx context.Context, q querier, sha string) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM owners WHERE sha256 = ? LIMIT 1`, sha).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// hasAccount is nil while the key has an account, ErrNoAccount once it hasn't.
func hasAccount(ctx context.Context, q querier, pubkey string) error {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM accounts WHERE pubkey = ?`, pubkey).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNoAccount
	}
	return err
}

// AddOwner records an owner of a blob without logging it against a day. inbox marks a device's blob, which expires
// after InboxLife (contract 5); uploading the same blob again keeps the row and, for an inbox blob, its first expiry.
func (s *Store) AddOwner(ctx context.Context, sha, owner, account string, size int64, inbox bool) error {
	return s.addOwner(ctx, s.db, sha, owner, account, size, inbox)
}

func (s *Store) addOwner(ctx context.Context, db querier, sha, owner, account string, size int64, inbox bool) error {
	var expires any
	if inbox {
		expires = s.Now().Add(InboxLife).Unix()
	}
	_, err := db.ExecContext(ctx, `INSERT INTO owners(sha256, owner, account, size, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?)
		ON CONFLICT(sha256, owner) DO NOTHING`, sha, owner, account, size, s.unix(), expires)
	return err
}

// Upload records an upload as AddOwner does and, when no owner held the blob before, logs its size against the
// library's day (contract 5): a blob the server already stores, for this library or any other, adds nothing, so a
// repeat upload and a move's re-uploads cost no part of the day. One transaction, so the owner row and the log can't
// part, which records nothing and gives ErrNoAccount once the library's account has gone: checked last, in the same
// transaction, so a DELETE /account, one transaction itself, falls wholly before the record, which it then finds, or
// after it, which it then refuses, and never leaves a row for a key that has gone.
func (s *Store) Upload(ctx context.Context, sha, owner, account string, size int64, inbox bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO uploads(account, size, at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM owners WHERE sha256 = ?)`,
		account, size, s.unix(), sha); err != nil {
		return err
	}
	if err := s.addOwner(ctx, tx, sha, owner, account, size, inbox); err != nil {
		return err
	}
	if err := hasAccount(ctx, tx, account); err != nil {
		return err
	}
	return tx.Commit()
}

// Exists is whether any pubkey owns the blob, so it is served.
func (s *Store) Exists(ctx context.Context, sha string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM owners WHERE sha256 = ? AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`, sha, s.unix()).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// RemoveOwner is Blossom's DELETE signed by signer (contract 5). A user's removes the blob from their library, every
// row of it counted against them, their devices' inbox uploads included, so the phone can delete a capture once it
// has taken the save (contract 4.4); a device key's removes its own upload. found is false when nothing went;
// orphaned lists the blob once no owner holds it.
func (s *Store) RemoveOwner(ctx context.Context, sha, signer string) (found bool, orphaned []string, err error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM owners WHERE sha256 = ? AND (owner = ? OR account = ?)`, sha, signer, signer)
	if err != nil {
		return false, nil, err
	}
	n, _ := res.RowsAffected()
	orphaned, err = orphans(ctx, s.db, []string{sha})
	return n > 0, orphaned, err
}

// orphans keeps those of the hashes no owner holds any longer.
func orphans(ctx context.Context, q querier, shas []string) ([]string, error) {
	var out []string
	for _, sha := range shas {
		held, err := stored(ctx, q, sha)
		if err != nil {
			return nil, err
		}
		if !held {
			out = append(out, sha)
		}
	}
	return out, nil
}

// deleteOwned removes the rows a query selects and returns the blobs left with no owner.
func deleteOwned(ctx context.Context, q querier, where string, args ...any) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT DISTINCT sha256 FROM owners WHERE `+where, args...)
	if err != nil {
		return nil, err
	}
	var shas []string
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			rows.Close()
			return nil, err
		}
		shas = append(shas, sha)
	}
	rows.Close()
	if _, err := q.ExecContext(ctx, `DELETE FROM owners WHERE `+where, args...); err != nil {
		return nil, err
	}
	return orphans(ctx, q, shas)
}

// RemoveDevice revokes a device the user authorised and deletes its unexpired inbox blobs that count against the user
// (contract 6). found is false when the device isn't the user's. A blob the device sent while another library held it
// stays that library's, to expire or go with its account (F44).
func (s *Store) RemoveDevice(ctx context.Context, user, device string) (found bool, orphaned []string, err error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM devices WHERE device_pubkey = ? AND user_pubkey = ?`, device, user)
	if err != nil {
		return false, nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return false, nil, nil
	}
	if orphaned, err = deleteOwned(ctx, s.db, `owner = ? AND account = ?`, device, user); err != nil {
		return true, nil, err
	}
	return true, orphaned, s.markGone(ctx, s.db, []string{device})
}

// DeleteAccount removes the user's and their devices' ownership of blobs, their devices, their uploads log and their
// allowlist entry (contract 6), and lists the user and the devices as gone for the relay's sweep, in one transaction:
// a deletion that fails part way changes nothing, and an upload's record, which checks for the account in its own
// transaction, falls wholly before or after it (Upload). Running it again does nothing more, and a key that never had
// an account, which the relay holds nothing for, isn't listed: any fresh key may call it, and each row would cost every
// nightly sweep (F45).
func (s *Store) DeleteAccount(ctx context.Context, user string) ([]string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	orphaned, err := s.deleteAccount(ctx, tx, user)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		return nil, err
	}
	return orphaned, nil
}

func (s *Store) deleteAccount(ctx context.Context, q querier, user string) ([]string, error) {
	if err := hasAccount(ctx, q, user); err != nil {
		if errors.Is(err, ErrNoAccount) {
			err = nil
		}
		return nil, err
	}
	devices, err := userDevices(ctx, q, user)
	if err != nil {
		return nil, err
	}
	orphaned, err := deleteOwned(ctx, q, `account = ?`, user)
	if err != nil {
		return nil, err
	}
	if err := s.markGone(ctx, q, append(devices, user)); err != nil {
		return nil, err
	}
	for _, del := range []string{`DELETE FROM uploads WHERE account = ?`, `DELETE FROM devices WHERE user_pubkey = ?`, `DELETE FROM accounts WHERE pubkey = ?`} {
		if _, err := q.ExecContext(ctx, del, user); err != nil {
			return nil, err
		}
	}
	return orphaned, nil
}

// markGone lists keys as gone for the relay's sweep (contract 3.2), as of now.
func (s *Store) markGone(ctx context.Context, q querier, keys []string) error {
	for _, k := range keys {
		if _, err := q.ExecContext(ctx, `INSERT INTO gone(pubkey, at) VALUES(?, ?) ON CONFLICT(pubkey) DO UPDATE SET at = excluded.at`, k, s.unix()); err != nil {
			return err
		}
	}
	return nil
}

func userDevices(ctx context.Context, q querier, user string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `SELECT device_pubkey FROM devices WHERE user_pubkey = ?`, user)
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

// ExpireInbox drops device inbox blobs past their 14 days (contract 5) and returns those left with no owner.
func (s *Store) ExpireInbox(ctx context.Context) ([]string, error) {
	return deleteOwned(ctx, s.db, `expires_at IS NOT NULL AND expires_at <= ?`, s.unix())
}
