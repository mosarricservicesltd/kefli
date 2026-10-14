package store

import (
	"context"
	"database/sql"
	"errors"
)

// Used is the bytes counted against the user's quota: each blob once, whether the user or one of their devices holds it.
func (s *Store) Used(ctx context.Context, account string) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx, `SELECT COALESCE(SUM(size), 0) FROM (SELECT sha256, MAX(size) AS size FROM owners WHERE account = ? GROUP BY sha256)`, account).Scan(&n)
	return n, err
}

// Holds is whether the user, or one of their devices, already owns the blob, so a repeat upload costs no quota.
func (s *Store) Holds(ctx context.Context, account, sha string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx, `SELECT 1 FROM owners WHERE account = ? AND sha256 = ? LIMIT 1`, account, sha).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// AddOwner records an upload. inbox marks a device's blob, which expires after InboxLife (contract 5); uploading the
// same blob again keeps the row and, for an inbox blob, its first expiry. Nothing is recorded once the account is
// deleted or disabled, or, for an inbox blob, once the device isn't the account's: an upload still arriving then
// leaves no owner that nothing would ever delete.
func (s *Store) AddOwner(ctx context.Context, sha, owner, account string, size int64, inbox bool) error {
	var expires any
	if inbox {
		expires = s.Now().Add(InboxLife).Unix()
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO owners(sha256, owner, account, size, created_at, expires_at) SELECT ?, ?, ?, ?, ?, ?
		WHERE EXISTS (SELECT 1 FROM accounts WHERE pubkey = ? AND disabled = 0)
		AND (? = 0 OR EXISTS (SELECT 1 FROM devices WHERE device_pubkey = ? AND user_pubkey = ?))
		ON CONFLICT(sha256, owner) DO NOTHING`, sha, owner, account, size, s.unix(), expires, account, inbox, owner, account)
	return err
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

// RemoveOwner drops the caller's ownership (Blossom DELETE); orphaned lists the blob when no owner remains.
func (s *Store) RemoveOwner(ctx context.Context, sha, owner string) (found bool, orphaned []string, err error) {
	res, err := s.db.ExecContext(ctx, `DELETE FROM owners WHERE sha256 = ? AND owner = ?`, sha, owner)
	if err != nil {
		return false, nil, err
	}
	n, _ := res.RowsAffected()
	orphaned, err = s.orphans(ctx, []string{sha})
	return n > 0, orphaned, err
}

// orphans keeps those of the hashes no owner holds any longer.
func (s *Store) orphans(ctx context.Context, shas []string) ([]string, error) {
	var out []string
	for _, sha := range shas {
		var one int
		err := s.db.QueryRowContext(ctx, `SELECT 1 FROM owners WHERE sha256 = ? LIMIT 1`, sha).Scan(&one)
		if err == sql.ErrNoRows {
			out = append(out, sha)
		} else if err != nil {
			return nil, err
		}
	}
	return out, nil
}

// deleteOwned removes the rows a query selects and returns the blobs left with no owner.
func (s *Store) deleteOwned(ctx context.Context, where string, args ...any) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT DISTINCT sha256 FROM owners WHERE `+where, args...)
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
	if _, err := s.db.ExecContext(ctx, `DELETE FROM owners WHERE `+where, args...); err != nil {
		return nil, err
	}
	return s.orphans(ctx, shas)
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
	if orphaned, err = s.deleteOwned(ctx, `owner = ? AND account = ?`, device, user); err != nil {
		return true, nil, err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO gone(pubkey, at) VALUES(?, ?) ON CONFLICT(pubkey) DO UPDATE SET at = excluded.at`, device, s.unix())
	return true, orphaned, err
}

// DeleteAccount removes the user's and their devices' ownership of blobs, their devices and their allowlist entry
// (contract 6), and lists the user and the devices as gone for the relay's sweep. Running it again does nothing more,
// and a key that never had an account, which the relay holds nothing for, isn't listed: any fresh key may call it, and
// each row would cost every nightly sweep (F45).
func (s *Store) DeleteAccount(ctx context.Context, user string) (orphaned []string, err error) {
	var one int
	switch err := s.db.QueryRowContext(ctx, `SELECT 1 FROM accounts WHERE pubkey = ?`, user).Scan(&one); {
	case errors.Is(err, sql.ErrNoRows):
		return nil, nil
	case err != nil:
		return nil, err
	}
	devices, err := s.userDevices(ctx, user)
	if err != nil {
		return nil, err
	}
	if orphaned, err = s.deleteOwned(ctx, `account = ?`, user); err != nil {
		return nil, err
	}
	for _, k := range append(devices, user) {
		if _, err := s.db.ExecContext(ctx, `INSERT INTO gone(pubkey, at) VALUES(?, ?) ON CONFLICT(pubkey) DO UPDATE SET at = excluded.at`, k, s.unix()); err != nil {
			return nil, err
		}
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM devices WHERE user_pubkey = ?`, user); err != nil {
		return nil, err
	}
	if _, err = s.db.ExecContext(ctx, `DELETE FROM accounts WHERE pubkey = ?`, user); err != nil {
		return nil, err
	}
	// an upload that finished while this ran recorded its owner before the account went: it goes too, and none can
	// be recorded after (AddOwner)
	late, err := s.deleteOwned(ctx, `account = ?`, user)
	return append(orphaned, late...), err
}

func (s *Store) userDevices(ctx context.Context, user string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT device_pubkey FROM devices WHERE user_pubkey = ?`, user)
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
	return s.deleteOwned(ctx, `expires_at IS NOT NULL AND expires_at <= ?`, s.unix())
}
