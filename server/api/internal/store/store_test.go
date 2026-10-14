package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// open is a store on a fresh database whose clock the test moves.
func open(t *testing.T) (*Store, *time.Time) {
	t.Helper()
	st, err := Open(filepath.Join(t.TempDir(), "k.db"))
	if err != nil {
		t.Fatal(err)
	}
	clock := time.Unix(1_791_600_000, 0)
	st.Now = func() time.Time { return clock }
	t.Cleanup(func() { st.Close() })
	return st, &clock
}

func version(t *testing.T, path string) int {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

func rawExec(t *testing.T, path string, queries ...string) {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, q := range queries {
		if _, err := db.Exec(q); err != nil {
			t.Fatalf("%s: %v", q, err)
		}
	}
}

func quotaOf(t *testing.T, st *Store, pubkey string) int64 {
	t.Helper()
	f, ok, err := st.Figures(context.Background(), pubkey)
	if err != nil || !ok {
		t.Fatalf("figures for %s: %v %v", pubkey, ok, err)
	}
	return f.Quota
}

// Flow decision 117: a database as keflid left it before contract 1.12, every library at the old 200 MB, falls to the
// new 50 MB once; a quota set to another figure is kept, then and later.
func TestOpenLowersTheOldDefaultOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "k.db")
	rawExec(t, path,
		`CREATE TABLE accounts (pubkey TEXT PRIMARY KEY, quota_bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, nip05_name TEXT)`,
		`INSERT INTO accounts(pubkey, quota_bytes, created_at, disabled) VALUES ('old', 209715200, 1, 0), ('paid', 104857600, 1, 0), ('off', 209715200, 1, 1)`)
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	for who, want := range map[string]int64{"old": DefaultQuota, "paid": 100 << 20, "off": DefaultQuota} {
		if got := quotaOf(t, st, who); got != want {
			t.Fatalf("%s: quota %d, want %d", who, got, want)
		}
	}
	if found, err := st.SetQuota(context.Background(), "old", 200<<20); err != nil || !found {
		t.Fatalf("set quota: %v %v", found, err)
	}
	st.Close()
	if v := version(t, path); v != len(steps) {
		t.Fatalf("schema version %d, want %d", v, len(steps))
	}
	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	if got := quotaOf(t, again, "old"); got != 200<<20 {
		t.Fatalf("the lowering ran again: quota %d", got)
	}
	if err := again.Upload(context.Background(), strings.Repeat("a", 64), "old", "old", 10, false); err != nil {
		t.Fatalf("an older database gains the uploads log: %v", err)
	}
}

// A database from a newer keflid isn't opened: this one can't know what its steps changed.
func TestOpenRefusesANewerDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "k.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	rawExec(t, path, `PRAGMA user_version = 99`)
	if _, err := Open(path); err == nil || !strings.Contains(err.Error(), "newer") {
		t.Fatalf("opened a newer database: %v", err)
	}
}

// A step that fails leaves the version where it was, so the next open runs it again; the steps before it stay done.
func TestAFailedStepRunsAgain(t *testing.T) {
	saved := steps
	t.Cleanup(func() { steps = saved })
	steps = []string{`UPDATE accounts SET quota_bytes = 1`, `not a statement`}
	path := filepath.Join(t.TempDir(), "k.db")
	if _, err := Open(path); err == nil || !strings.Contains(err.Error(), "schema version 2") {
		t.Fatalf("opened with a failing step: %v", err)
	}
	if v := version(t, path); v != 1 {
		t.Fatalf("schema version %d after the second step failed, want 1", v)
	}
	steps = saved[:1]
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
}

func registered(t *testing.T, st *Store, keys ...string) {
	t.Helper()
	for _, k := range keys {
		if err := st.Register(context.Background(), k); err != nil {
			t.Fatal(err)
		}
	}
}

func today(t *testing.T, st *Store, account string) int64 {
	t.Helper()
	n, err := st.Today(context.Background(), account)
	if err != nil {
		t.Fatal(err)
	}
	return n
}

func uploadRows(t *testing.T, st *Store) int {
	t.Helper()
	var n int
	if err := st.db.QueryRow(`SELECT COUNT(*) FROM uploads`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Contract 5: a library's day counts the bytes its uploads, its browsers' included, add to the disk in the last 24
// hours. A blob the server already stores, for this library or any other, adds nothing; deleting gives none back; the
// hourly sweep forgets what is a day old.
func TestTheDayCountsBytesNewToTheDisk(t *testing.T) {
	st, clock := open(t)
	ctx := context.Background()
	registered(t, st, "user", "other")
	x, y := strings.Repeat("1", 64), strings.Repeat("2", 64)
	start := *clock
	if err := st.Upload(ctx, x, "user", "user", 100, false); err != nil {
		t.Fatal(err)
	}
	*clock = start.Add(time.Hour)
	for _, up := range []struct {
		owner, account string
		inbox          bool
	}{{"device", "user", true}, {"other", "other", false}} {
		if err := st.Upload(ctx, x, up.owner, up.account, 100, up.inbox); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.Upload(ctx, y, "device", "user", 50, true); err != nil {
		t.Fatal(err)
	}
	if got := today(t, st, "user"); got != 150 {
		t.Fatalf("the user's day %d, want 150: x once, and the browser's y", got)
	}
	if got := today(t, st, "other"); got != 0 {
		t.Fatalf("another library's day %d for a blob already stored, want 0", got)
	}
	if found, _, err := st.RemoveOwner(ctx, x, "user"); err != nil || !found {
		t.Fatalf("delete: %v %v", found, err)
	}
	if got := today(t, st, "user"); got != 150 {
		t.Fatalf("deleting gave the day back: %d", got)
	}
	*clock = start.Add(Day)
	if got := today(t, st, "user"); got != 50 {
		t.Fatalf("a day on, the day %d, want 50", got)
	}
	if err := st.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if n := uploadRows(t, st); n != 1 {
		t.Fatalf("%d upload rows after the sweep, want 1", n)
	}
	*clock = start.Add(Day + time.Hour)
	if err := st.Sweep(ctx); err != nil {
		t.Fatal(err)
	}
	if n := uploadRows(t, st); n != 0 || today(t, st, "user") != 0 {
		t.Fatalf("%d upload rows a day after the last upload", n)
	}
}

// GET /account's figures, for an account enabled or not, and none for a key without one.
func TestFigures(t *testing.T) {
	st, _ := open(t)
	ctx := context.Background()
	if _, ok, err := st.Figures(ctx, "nobody"); ok || err != nil {
		t.Fatalf("figures for no account: %v %v", ok, err)
	}
	registered(t, st, "user")
	f, ok, err := st.Figures(ctx, "user")
	if err != nil || !ok || f != (Figures{Quota: DefaultQuota, Daily: DailyLimit}) {
		t.Fatalf("a new library: %+v %v %v", f, ok, err)
	}
	if err := st.Upload(ctx, strings.Repeat("3", 64), "user", "user", 70, false); err != nil {
		t.Fatal(err)
	}
	if err := st.SetDisabled(ctx, "user", true); err != nil {
		t.Fatal(err)
	}
	f, ok, err = st.Figures(ctx, "user")
	if err != nil || !ok || f != (Figures{Quota: DefaultQuota, Used: 70, Daily: DailyLimit, Today: 70}) {
		t.Fatalf("a disabled library: %+v %v %v", f, ok, err)
	}
	if found, err := st.SetQuota(ctx, "nobody", 1); err != nil || found {
		t.Fatalf("set a quota without an account: %v %v", found, err)
	}
}

// Contract 5: a user's delete removes the blob from their library, their browsers' uploads of it included; a device
// key's removes only its own; a blob goes once no owner is left.
func TestRemoveOwner(t *testing.T) {
	st, _ := open(t)
	ctx := context.Background()
	registered(t, st, "user", "other", "next")
	x, y := strings.Repeat("4", 64), strings.Repeat("5", 64)
	add := func(sha, owner, account string, inbox bool) {
		t.Helper()
		if err := st.Upload(ctx, sha, owner, account, 10, inbox); err != nil {
			t.Fatal(err)
		}
	}
	add(x, "user", "user", false)
	add(x, "device", "user", true)
	add(x, "other", "other", false)
	remove := func(signer string, wantFound bool, wantOrphaned int) {
		t.Helper()
		found, orphaned, err := st.RemoveOwner(ctx, x, signer)
		if err != nil || found != wantFound || len(orphaned) != wantOrphaned {
			t.Fatalf("%s's delete: found %v, orphaned %v, %v", signer, found, orphaned, err)
		}
	}
	remove("device", true, 0)
	if held, _ := st.Holds(ctx, "user", x); !held {
		t.Fatal("a device's delete took the user's own copy")
	}
	add(x, "device", "user", true)
	remove("user", true, 0)
	if held, _ := st.Holds(ctx, "user", x); held {
		t.Fatal("the user's delete left its browser's upload counted against it")
	}
	remove("stranger", false, 0)
	remove("other", true, 1)
	// a browser's upload made while another library held it counts against that library, which alone may delete it
	add(y, "device", "user", true)
	if found, _, err := st.RemoveOwner(ctx, y, "next"); err != nil || found {
		t.Fatalf("a library the blob doesn't count against deleted it: %v %v", found, err)
	}
}

// failing makes the database refuse one kind of write to a table from now on, as a full or broken disk would.
func failing(t *testing.T, st *Store, op, table string) {
	t.Helper()
	name := "fail_" + strings.ToLower(op) + "_" + table
	if _, err := st.db.Exec(`CREATE TRIGGER ` + name + ` BEFORE ` + op + ` ON ` + table + ` BEGIN SELECT RAISE(ABORT, 'refused'); END`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = st.db.Exec(`DROP TRIGGER IF EXISTS ` + name) })
}

// A write the database refuses part way is reported, never taken for done: the API answers 500 and the client tries
// again. An upload's owner row and its day's log go together or not at all.
func TestRefusedWritesAreReported(t *testing.T) {
	ctx := context.Background()
	sha := strings.Repeat("8", 64)
	for _, c := range []struct {
		name, op, table string
		run             func(*Store) error
	}{
		{"the upload's log", "INSERT", "uploads", func(st *Store) error { return st.Upload(ctx, sha, "user", "user", 1, false) }},
		{"the upload's owner row", "INSERT", "owners", func(st *Store) error { return st.Upload(ctx, sha, "user", "user", 1, false) }},
		{"the account's blobs", "DELETE", "owners", func(st *Store) error { _, err := st.DeleteAccount(ctx, "user"); return err }},
		{"the account's gone row", "INSERT", "gone", func(st *Store) error { _, err := st.DeleteAccount(ctx, "user"); return err }},
		{"the account's uploads log", "DELETE", "uploads", func(st *Store) error { _, err := st.DeleteAccount(ctx, "user"); return err }},
		{"a device's blobs", "DELETE", "owners", func(st *Store) error { _, _, err := st.RemoveDevice(ctx, "user", "device"); return err }},
		{"a device's gone row", "INSERT", "gone", func(st *Store) error { _, _, err := st.RemoveDevice(ctx, "user", "device"); return err }},
	} {
		t.Run(c.name, func(t *testing.T) {
			st, _ := open(t)
			registered(t, st, "user")
			if err := st.AddDevice(ctx, "user", "device"); err != nil {
				t.Fatal(err)
			}
			// a blob of the user's and one its browser sent, so each delete has rows to refuse
			for _, owner := range []string{"user", "device"} {
				if err := st.Upload(ctx, strings.Repeat(owner[:1], 64), owner, "user", 10, owner == "device"); err != nil {
					t.Fatal(err)
				}
			}
			before := today(t, st, "user")
			failing(t, st, c.op, c.table)
			if err := c.run(st); err == nil {
				t.Fatal("a refused write was taken for done")
			}
			if today(t, st, "user") != before {
				t.Fatal("the day's log kept an upload whose owner row failed")
			}
		})
	}
	t.Run("a devices table that can't be read", func(t *testing.T) {
		st, _ := open(t)
		registered(t, st, "user")
		if _, err := st.db.Exec(`ALTER TABLE devices RENAME TO devices_away`); err != nil {
			t.Fatal(err)
		}
		if _, err := st.DeleteAccount(ctx, "user"); err == nil {
			t.Fatal("deleted an account without reading its devices")
		}
	})
	t.Run("a closed database", func(t *testing.T) {
		st, _ := open(t)
		st.Close()
		if _, err := st.DeleteAccount(ctx, "user"); err == nil {
			t.Fatal("no error from a closed database")
		}
		if err := st.Upload(ctx, sha, "user", "user", 1, false); err == nil {
			t.Fatal("no error from a closed database")
		}
	})
	if _, err := Open(filepath.Join(t.TempDir(), "missing", "k.db")); err == nil {
		t.Fatal("opened a database in a folder that isn't there")
	}
}

// DELETE /account leaves no row for the key (backend spec 11): its uploads log goes too, so a key registered again
// starts a fresh day.
func TestDeleteAccountTakesItsUploadsLog(t *testing.T) {
	st, _ := open(t)
	ctx := context.Background()
	registered(t, st, "user", "other")
	if err := st.Upload(ctx, strings.Repeat("6", 64), "user", "user", 10, false); err != nil {
		t.Fatal(err)
	}
	if err := st.Upload(ctx, strings.Repeat("7", 64), "other", "other", 20, false); err != nil {
		t.Fatal(err)
	}
	orphaned, err := st.DeleteAccount(ctx, "user")
	if err != nil || len(orphaned) != 1 {
		t.Fatalf("delete account: %v %v", orphaned, err)
	}
	registered(t, st, "user")
	if got := today(t, st, "user"); got != 0 {
		t.Fatalf("a deleted account's day came back: %d", got)
	}
	if got := today(t, st, "other"); got != 20 {
		t.Fatalf("another library's day %d, want 20", got)
	}
}
