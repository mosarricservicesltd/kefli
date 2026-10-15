package policy

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// DB answers Lookups from keflid's database, opened read-only, and the plugin's own record of the gift wraps the relay
// holds. The allowlist and the devices are a snapshot refreshed every five seconds (backend spec 3.1); a key the
// snapshot doesn't hold is asked of the database before it is refused, so a user's first event straight after POST
// /register is taken. A key removed is refused within the five seconds.
type DB struct {
	keflid, wraps *sql.DB
	every         time.Duration
	mu            sync.RWMutex
	users         map[string]bool
	devices       map[string]bool
	refreshed     time.Time
}

func NewDB(keflid, wraps *sql.DB) *DB {
	return &DB{keflid: keflid, wraps: wraps, every: 5 * time.Second}
}

const (
	usersQuery   = `SELECT pubkey FROM accounts WHERE disabled = 0`
	devicesQuery = `SELECT d.device_pubkey FROM devices d JOIN accounts a ON a.pubkey = d.user_pubkey WHERE a.disabled = 0`
)

func (d *DB) refresh() {
	d.mu.RLock()
	stale := time.Since(d.refreshed) >= d.every
	d.mu.RUnlock()
	if !stale {
		return
	}
	users, err := keys(d.keflid, usersQuery)
	if err == nil {
		var devices map[string]bool
		if devices, err = keys(d.keflid, devicesQuery); err == nil {
			d.mu.Lock()
			d.users, d.devices, d.refreshed = users, devices, time.Now()
			d.mu.Unlock()
		}
	}
	if err != nil {
		log.Printf("allowlist: %v", err)
	}
}

func keys(db *sql.DB, q string, args ...any) (map[string]bool, error) {
	rows, err := db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]bool{}
	for rows.Next() {
		var k string
		if err := rows.Scan(&k); err != nil {
			return nil, err
		}
		out[k] = true
	}
	return out, rows.Err()
}

func (d *DB) Registered(pk string) bool {
	return d.known(pk, func() map[string]bool { return d.users }) || d.ask(usersQuery+` AND pubkey = ?`, pk)
}

func (d *DB) Authorised(pk string) bool {
	return d.known(pk, func() map[string]bool { return d.devices }) || d.ask(devicesQuery+` AND d.device_pubkey = ?`, pk)
}

// DeviceUser is asked of the database each time: only a wrap sent on an AUTHed connection needs it.
func (d *DB) DeviceUser(pk string) (string, bool) {
	var user string
	err := d.keflid.QueryRow(`SELECT d.user_pubkey FROM devices d JOIN accounts a ON a.pubkey = d.user_pubkey
		WHERE a.disabled = 0 AND d.device_pubkey = ?`, pk).Scan(&user)
	return user, err == nil
}

func (d *DB) known(pk string, set func() map[string]bool) bool {
	d.refresh()
	d.mu.RLock()
	defer d.mu.RUnlock()
	return set()[pk]
}

func (d *DB) ask(q, pk string) bool {
	var k string
	return d.keflid.QueryRow(q, pk).Scan(&k) == nil
}

func (d *DB) Wrap(id string) (author, p string, ok bool) {
	err := d.wraps.QueryRow(`SELECT author, p FROM wraps WHERE id = ?`, id).Scan(&author, &p)
	return author, p, err == nil
}

// OpenWraps opens, and makes if need be, the plugin's record of the wraps the relay holds, with when its last prune
// began (PruneWraps).
func OpenWraps(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", "file:"+path+"?_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, err
	}
	_, err = db.Exec(`PRAGMA journal_mode = WAL;
		CREATE TABLE IF NOT EXISTS wraps (id TEXT PRIMARY KEY, author TEXT NOT NULL, p TEXT NOT NULL, at INTEGER NOT NULL);
		CREATE INDEX IF NOT EXISTS wraps_p ON wraps(p);
		CREATE TABLE IF NOT EXISTS pruned (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL);`)
	return db, err
}

// WrapLife is how long a wrap stays recorded: a day past the 30 days the relay's sweep keeps it (contract 3.2), so the
// record never forgets a wrap the relay still holds.
const WrapLife = 31 * 24 * time.Hour

// PruneEvery is how often the write policy prunes its record (PruneWraps), besides once as it starts.
const PruneEvery = time.Hour

// PruneOverlap is how far before the last prune's start the next looks for keys removed: the policy's allowlist is up
// to five seconds old (DB), so a wrap to a key removed just before a prune can be recorded just after it, and the
// next prune still forgets it. It is as long as the time between prunes, so a clock put back, which leaves the start
// kept ahead of the keys removed after it, only puts off their prune: the next prune keeps its own start, and the one
// after it, looking back from there, finds them.
const PruneOverlap = PruneEvery

// PruneWraps forgets the wraps the relay's sweep has dropped, which no kind 5 ever named: those past WrapLife, and
// those addressed to a key keflid's gone list has taken since the last prune began, less PruneOverlap, so the record
// keeps no recipient a deleted account had (F45). The list holds 60 days of removed keys, and reading every one of
// them each hour, a delete apiece, did again what the prunes before had done; a record with no prune yet, as a new
// one, looks at every key on the list. The prune's start is kept once it has run to the end.
func PruneWraps(wraps, keflid *sql.DB, now time.Time) error {
	if _, err := wraps.Exec(`DELETE FROM wraps WHERE at < ?`, now.Add(-WrapLife).Unix()); err != nil {
		return err
	}
	since, err := lastPrune(wraps)
	if err != nil {
		return err
	}
	gone, err := keys(keflid, `SELECT pubkey FROM gone WHERE at >= ?`, since)
	if err != nil {
		return err
	}
	for k := range gone {
		if _, err := wraps.Exec(`DELETE FROM wraps WHERE p = ?`, k); err != nil {
			return err
		}
	}
	_, err = wraps.Exec(`INSERT INTO pruned(id, at) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET at = excluded.at`, now.Unix())
	return err
}

// lastPrune is when the last prune began, less PruneOverlap, and 0 when the record has had none.
func lastPrune(wraps *sql.DB) (int64, error) {
	var at int64
	err := wraps.QueryRow(`SELECT at FROM pruned WHERE id = 1`).Scan(&at)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return at - int64(PruneOverlap/time.Second), err
}

// Serve answers strfry line by line until in closes: each event's verdict, with the wrap record kept in step and the
// wraps a recipient deletes passed to remove, after the answer.
func Serve(in io.Reader, out io.Writer, p *Policy, wraps *sql.DB, remove func([]string)) error {
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	enc := json.NewEncoder(out)
	for sc.Scan() {
		var line Input
		if err := json.Unmarshal(sc.Bytes(), &line); err != nil {
			log.Printf("unreadable line")
			continue
		}
		v := p.Decide(line)
		if err := Apply(wraps, v, line); err != nil {
			log.Printf("record: %v", err)
		}
		if err := enc.Encode(v.Out); err != nil {
			return err
		}
		if len(v.Deletes) > 0 && remove != nil {
			go remove(v.Deletes)
		}
	}
	return sc.Err()
}

// Apply keeps the wrap record in step with what the relay accepted: a new wrap is recorded, and the wraps a deletion
// names are forgotten, since the relay no longer holds them.
func Apply(wraps *sql.DB, v Verdict, line Input) error {
	if v.Out.Action != "accept" {
		return nil
	}
	if v.Record != nil {
		_, err := wraps.Exec(`INSERT INTO wraps(id, author, p, at) VALUES(?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`, v.Record.ID, v.Record.Author, v.Record.P, time.Now().Unix())
		return err
	}
	return forget(wraps, line)
}

// forget drops only the wraps a deletion actually removes: those by its author (strfry's own NIP-09) and those
// addressed to its author (the recipient's deletion, contract 3.2). Any other id it names stays on the relay, so it
// stays recorded.
func forget(wraps *sql.DB, line Input) error {
	var ev Event
	if json.Unmarshal(line.Event, &ev) != nil || ev.Kind != KindDeletion {
		return nil
	}
	for _, id := range tags(ev, "e") {
		if _, err := wraps.Exec(`DELETE FROM wraps WHERE id = ? AND (author = ? OR p = ?)`, id, ev.Pubkey, ev.Pubkey); err != nil {
			return err
		}
	}
	return nil
}
