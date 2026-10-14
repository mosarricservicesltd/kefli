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

// Figures reads a library's figures, its account enabled or not; ok is false when the key has no account. What the
// library uses and its day are the running totals the database keeps on its accounts row (schema step 3), once the
// library's browsers' captures past their 14 days and its uploads a day old have been let go: so the figures are
// exactly those of the blobs it holds now and the uploads of the last 24 hours, and reading them takes the same few
// index lookups however many blobs the library holds, where summing its rows on every upload, refused or not, let one
// full library's requests hold the database connection every other request waits for.
func (s *Store) Figures(ctx context.Context, account string) (Figures, bool, error) {
	if err := s.letGo(ctx, account); err != nil {
		return Figures{}, false, err
	}
	f := Figures{Daily: DailyLimit}
	err := s.db.QueryRowContext(ctx, `SELECT quota_bytes, used_bytes, day_bytes FROM accounts WHERE pubkey = ?`, account).Scan(&f.Quota, &f.Used, &f.Today)
	if errors.Is(err, sql.ErrNoRows) {
		return Figures{}, false, nil
	}
	return f, err == nil, err
}

// letGo drops what no longer counts for the library, as the hourly sweep does for every library (ExpireInbox, Sweep):
// its uploads a day old, which leave its day, and its browsers' captures past their 14 days (contract 4.4, 5), from
// the moment they expire. A capture let go here keeps its file until the hourly sweep of files, which no longer finds
// it held; nothing serves it meanwhile.
func (s *Store) letGo(ctx context.Context, account string) error {
	now := s.Now()
	if _, err := s.db.ExecContext(ctx, `DELETE FROM uploads WHERE account = ? AND at <= ?`, account, now.Add(-Day).Unix()); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM owners WHERE account = ? AND expires_at IS NOT NULL AND expires_at <= ?`, account, now.Unix())
	return err
}

// live keeps the owner rows the library still holds: a device's inbox row past its 14 days no longer counts (contract
// 4.4, 5), from the moment it expires, though neither the library's figures nor the hourly sweep may have let it go yet.
const live = `(expires_at IS NULL OR expires_at > ?)`

// Used is the bytes counted against the user's quota: each blob once, whether the user or one of their devices holds it,
// at its Cost (Figures).
func (s *Store) Used(ctx context.Context, account string) (int64, error) {
	f, _, err := s.Figures(ctx, account)
	return f.Used, err
}

// Today is what the library's uploads added to the disk in the last 24 hours, from the uploads log (contract 5), each
// at its Cost (Figures).
func (s *Store) Today(ctx context.Context, account string) (int64, error) {
	f, _, err := s.Figures(ctx, account)
	return f.Today, err
}

// Holds is whether the user, or one of their devices, already owns the blob, so a repeat upload costs no quota. An
// expired inbox row holds nothing, as Used doesn't count it.
func (s *Store) Holds(ctx context.Context, account, sha string) (bool, error) {
	return holds(ctx, s.db, account, sha, s.unix())
}

func holds(ctx context.Context, q querier, account, sha string, now int64) (bool, error) {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM owners WHERE account = ? AND sha256 = ? AND `+live+` LIMIT 1`, account, sha, now).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
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

// Stored is whether any owner holds the blob, an expired inbox row not yet let go of included: its file is on the
// disk, so an upload of it adds nothing to a library's day (contract 5).
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

// AddOwner records an owner of a blob without logging it against a day, the blob counting for its Cost. inbox marks a
// device's blob, which expires after InboxLife (contract 5); uploading the same blob again keeps the row and, for an
// inbox blob, its first expiry. A browser's copy of a blob its library holds already, through any of its keys, adds no
// row: what counts is the library's holding, and a row for each key would let a library's 64 browsers multiply its rows
// sixty-fold at no cost against its fair use (rows that every figure, deletion and sweep then reads). A user's own
// upload is always recorded, so a blob the library holds only as a capture stays once the capture expires.
// Nothing is recorded, and ErrNoAccount given, once the account is deleted or disabled, or, for an inbox blob, once the
// browser Blossom found to be the account's has since been disconnected or connected to another library: an upload
// still arriving then leaves no owner that nothing would ever delete.
func (s *Store) AddOwner(ctx context.Context, sha, owner, account string, size int64, inbox bool) error {
	return s.inTx(ctx, func(tx querier) error { return s.addOwner(ctx, tx, sha, owner, account, size, inbox) })
}

// addOwner is AddOwner in a transaction the caller commits, which it must roll back on an error: the uploader's
// standing is checked last, after the row is written, so a deletion that lands as it is written leaves nothing.
func (s *Store) addOwner(ctx context.Context, q querier, sha, owner, account string, size int64, inbox bool) error {
	if err := s.insertOwner(ctx, q, sha, owner, account, size, inbox); err != nil {
		return err
	}
	return entitled(ctx, q, owner, account, inbox)
}

func (s *Store) insertOwner(ctx context.Context, q querier, sha, owner, account string, size int64, inbox bool) error {
	var expires any
	if inbox {
		if held, err := holds(ctx, q, account, sha, s.unix()); err != nil || held {
			return err
		}
		expires = s.Now().Add(InboxLife).Unix()
	}
	// a blob's rows in one library share one size, the first's, which the library's running total counted (schema step 3)
	_, err := q.ExecContext(ctx, `INSERT INTO owners(sha256, owner, account, size, created_at, expires_at)
		VALUES(?, ?, ?, COALESCE((SELECT size FROM owners WHERE sha256 = ? AND account = ? LIMIT 1), ?), ?, ?)
		ON CONFLICT(sha256, owner) DO NOTHING`, sha, owner, account, sha, account, Cost(size), s.unix(), expires)
	return err
}

// inTx runs fn in a transaction, committed when fn returns nil and rolled back otherwise.
func (s *Store) inTx(ctx context.Context, fn func(querier) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// entitled is nil while owner may still record an upload for account, ErrNoAccount once it may not: the account stands
// and is enabled and, for a browser's upload, the browser is still the library's. A browser the account holds is
// entitled even while the gone list still names it, as AddDevice's second write can leave it; a key with no browser
// row, which only a test uploads with, is entitled unless the gone list names it, as Disconnect does.
func entitled(ctx context.Context, q querier, owner, account string, inbox bool) error {
	var one int
	err := q.QueryRowContext(ctx, `SELECT 1 FROM accounts WHERE pubkey = ? AND disabled = 0
		AND (? = 0 OR EXISTS (SELECT 1 FROM devices WHERE device_pubkey = ? AND user_pubkey = ?)
			OR (NOT EXISTS (SELECT 1 FROM devices WHERE device_pubkey = ?) AND NOT EXISTS (SELECT 1 FROM gone WHERE pubkey = ?)))`,
		account, inbox, owner, account, owner, owner).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNoAccount
	}
	return err
}

// Upload records an upload as AddOwner does and, when no owner held the blob before, logs its Cost against the
// library's day (contract 5): a blob the server already stores, for this library or any other, adds nothing, so a
// repeat upload and a move's re-uploads cost no part of the day. One transaction, so the owner row and the log can't
// part, which records nothing and gives ErrNoAccount once the library's account has gone or been disabled, or the
// browser uploading is no longer the library's: checked in the same transaction, so a DELETE /account or a
// Disconnect, each one transaction itself, runs wholly before the record, which then records nothing, or wholly after
// it, taking the record with the rest, and never leaves a row for a key that has gone.
func (s *Store) Upload(ctx context.Context, sha, owner, account string, size int64, inbox bool) error {
	return s.inTx(ctx, func(tx querier) error {
		if _, err := tx.ExecContext(ctx, `INSERT INTO uploads(account, size, at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM owners WHERE sha256 = ?)`,
			account, Cost(size), s.unix(), sha); err != nil {
			return err
		}
		return s.addOwner(ctx, tx, sha, owner, account, size, inbox)
	})
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
// stays that library's, to expire or go with its account (F44). In one transaction, as DeleteAccount is: a revocation
// that fails part way changes nothing, and an upload's record falls wholly before it, and goes with the device's
// other blobs, or after it, when the device is listed as gone and the record is refused (Upload).
func (s *Store) RemoveDevice(ctx context.Context, user, device string) (found bool, orphaned []string, err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, nil, err
	}
	defer tx.Rollback()
	found, orphaned, err = s.removeDevice(ctx, tx, user, device)
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		return false, nil, err
	}
	return found, orphaned, nil
}

func (s *Store) removeDevice(ctx context.Context, q querier, user, device string) (bool, []string, error) {
	res, err := q.ExecContext(ctx, `DELETE FROM devices WHERE device_pubkey = ? AND user_pubkey = ?`, device, user)
	if err != nil {
		return false, nil, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return false, nil, nil
	}
	orphaned, err := deleteOwned(ctx, q, `owner = ? AND account = ?`, device, user)
	if err != nil {
		return false, nil, err
	}
	return true, orphaned, s.markGone(ctx, q, []string{device})
}

// DeleteAccount removes the user's and their devices' ownership of blobs, their devices, their uploads log and their
// allowlist entry (contract 6), and lists the user and the devices as gone for the relay's sweep, in one transaction:
// a deletion that fails part way changes nothing, and an upload's record, which checks for the account in its own
// transaction, falls wholly before it, and goes with the rest, or after it, and is refused (Upload), so no upload
// landing as it runs leaves an owner behind. Running it again does nothing more, and a key that never had an account,
// which the relay holds nothing for, isn't listed: any fresh key may call it, and each row would cost every nightly
// sweep (F45).
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
