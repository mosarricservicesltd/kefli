package store

import (
	"context"
	"errors"
	"fmt"
	"math/rand/v2"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

// exact is a library's figures summed from its rows, as the store read them before it kept running totals: each blob
// it holds now once, at its largest row, and its uploads of the last 24 hours.
func exact(t *testing.T, st *Store, account string) (Figures, bool) {
	t.Helper()
	now := st.Now()
	f := Figures{Daily: DailyLimit}
	if err := st.db.QueryRow(`SELECT quota_bytes FROM accounts WHERE pubkey = ?`, account).Scan(&f.Quota); err != nil {
		return Figures{}, false
	}
	if err := st.db.QueryRow(`SELECT COALESCE(SUM(size), 0) FROM (SELECT sha256, MAX(size) AS size FROM owners
		WHERE account = ? AND (expires_at IS NULL OR expires_at > ?) GROUP BY sha256)`, account, now.Unix()).Scan(&f.Used); err != nil {
		t.Fatal(err)
	}
	if err := st.db.QueryRow(`SELECT COALESCE(SUM(size), 0) FROM uploads WHERE account = ? AND at > ?`, account, now.Add(-Day).Unix()).Scan(&f.Today); err != nil {
		t.Fatal(err)
	}
	return f, true
}

// walk is a library's life in random steps, from a seed: uploads by users and their browsers of blobs some of which
// other libraries hold, deletes by either, Connects and Disconnects that move browsers between libraries, a clock
// that passes the day's window and the captures' 14 days, the hourly sweeps, account deletions and registrations
// again, and quotas and disabling set by hand.
type walk struct {
	t      *testing.T
	st     *Store
	clock  *time.Time
	rng    *rand.Rand
	users  []string
	browse []string
}

// blob is one of a pool of blobs, each with its own size, a third of them under a disk block.
func (w *walk) blob() (string, int64) {
	i := w.rng.IntN(15)
	return strings.Repeat(fmt.Sprintf("%x", i), 64), int64([]int{1, 900, 4095, 4096, 5000, 30_000, 250_000}[i%7])
}

func (w *walk) pick(keys []string) string { return keys[w.rng.IntN(len(keys))] }

func (w *walk) upload(ctx context.Context) {
	sha, size := w.blob()
	if w.rng.IntN(2) == 0 {
		w.must(w.st.Upload(ctx, sha, w.pick(w.users), w.pick(w.users), size, false))
		return
	}
	device := w.pick(w.browse)
	if user, ok, err := w.st.DeviceUser(ctx, device); err == nil && ok {
		w.must(w.st.Upload(ctx, sha, device, user, size, true))
	}
}

func (w *walk) registered(ctx context.Context, user string) bool {
	_, ok, err := w.st.Account(ctx, user)
	w.must(err)
	return ok
}

// must fails on any error but ErrNoAccount, which an upload for a key that has gone or been disabled gets.
func (w *walk) must(err error) {
	w.t.Helper()
	if err != nil && !errors.Is(err, ErrNoAccount) {
		w.t.Fatal(err)
	}
}

func (w *walk) step(ctx context.Context) string {
	switch n := w.rng.IntN(20); {
	case n < 8:
		w.upload(ctx)
		return "upload"
	case n < 11:
		sha, _ := w.blob()
		_, _, err := w.st.RemoveOwner(ctx, sha, w.pick(append(slices.Clone(w.users), w.browse...)))
		w.must(err)
		return "delete"
	case n == 11:
		// the API connects a browser only to a registered user (POST /devices)
		if user := w.pick(w.users); w.registered(ctx, user) {
			w.must(w.st.AddDevice(ctx, user, w.pick(w.browse)))
		}
		return "connect"
	case n == 12:
		_, _, err := w.st.RemoveDevice(ctx, w.pick(w.users), w.pick(w.browse))
		w.must(err)
		return "disconnect"
	case n < 15:
		*w.clock = w.clock.Add([]time.Duration{time.Second, time.Hour, 23 * time.Hour, Day, 7 * Day, InboxLife}[w.rng.IntN(6)])
		return "time"
	case n == 15:
		_, err := w.st.ExpireInbox(ctx)
		w.must(err)
		w.must(w.st.Sweep(ctx))
		return "sweep"
	case n == 16:
		_, err := w.st.DeleteAccount(ctx, w.pick(w.users))
		w.must(err)
		return "delete account"
	case n == 17:
		w.must(w.st.Register(ctx, w.pick(w.users)))
		return "register"
	case n == 18:
		_, err := w.st.SetQuota(ctx, w.pick(w.users), int64(w.rng.IntN(400_000)))
		w.must(err)
		return "quota"
	default:
		w.must(w.st.SetDisabled(ctx, w.pick(w.users), w.rng.IntN(3) == 0))
		return "disable"
	}
}

// Schema step 3: the figures are running totals the database keeps, so reading them costs the same whatever a library
// holds. Through every way a library's rows change, in 1,500 random steps over three libraries and four browsers, they
// stay exactly the sums the store read before: each blob held now once, and the uploads of the last 24 hours.
func TestTheRunningTotalsAreTheSums(t *testing.T) {
	st, clock := open(t)
	ctx := context.Background()
	w := &walk{t: t, st: st, clock: clock, rng: rand.New(rand.NewPCG(117, 4096)), users: []string{"u0", "u1", "u2"}, browse: []string{"b0", "b1", "b2", "b3"}}
	registered(t, st, w.users...)
	steps := map[string]int{}
	for i := range 1500 {
		what := w.step(ctx)
		steps[what]++
		for _, u := range w.users {
			want, has := exact(t, st, u)
			got, ok, err := st.Figures(ctx, u)
			if err != nil || ok != has || got != want {
				t.Fatalf("step %d (%s), %s: figures %+v %v %v, the sums %+v %v", i, what, u, got, ok, err, want, has)
			}
		}
	}
	// every kind of step taken dozens of times
	for _, what := range []string{"upload", "delete", "connect", "disconnect", "time", "sweep", "delete account", "register", "quota", "disable"} {
		if steps[what] < 30 {
			t.Fatalf("%d steps of %s in %v", steps[what], what, steps)
		}
	}
}

// A database from before the running totals holds a library's blobs, one of them in two rows of different sizes, an
// expired capture and uploads in and out of the day: the first open makes the totals from them, and the figures are
// the sums from then on.
func TestOpenMakesTheRunningTotals(t *testing.T) {
	saved := steps
	t.Cleanup(func() { steps = saved })
	steps = saved[:2]
	path := filepath.Join(t.TempDir(), "k.db")
	st, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	st.Close()
	clock := time.Unix(1_791_600_000, 0)
	a, b, c := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	rawExec(t, path,
		`INSERT INTO accounts(pubkey, quota_bytes, created_at) VALUES ('user', 52428800, 1), ('other', 52428800, 1)`,
		fmt.Sprintf(`INSERT INTO owners(sha256, owner, account, size, created_at, expires_at) VALUES
			('%s', 'user', 'user', 5000, 1, NULL), ('%s', 'device', 'user', 6000, 1, %d),
			('%s', 'device', 'user', 7000, 1, %d), ('%s', 'other', 'other', 8000, 1, NULL)`,
			a, a, clock.Unix()+60, b, clock.Unix()-60, c),
		fmt.Sprintf(`INSERT INTO uploads(account, size, at) VALUES ('user', 6000, %d), ('user', 7000, %d), ('other', 8000, %d)`,
			clock.Unix()-60, clock.Add(-Day).Unix()-60, clock.Unix()-60))
	steps = saved
	again, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer again.Close()
	again.Now = func() time.Time { return clock }
	ctx := context.Background()
	for _, want := range []struct {
		account     string
		used, today int64
	}{{"user", 6000, 6000}, {"other", 8000, 8000}} {
		f, ok, err := again.Figures(ctx, want.account)
		if err != nil || !ok || f.Used != want.used || f.Today != want.today {
			t.Fatalf("%s: figures %+v %v %v, want used %d and today %d", want.account, f, ok, err, want.used, want.today)
		}
	}
	// the blob held in two rows counts once, and goes once both have
	if found, _, err := again.RemoveOwner(ctx, a, "device"); err != nil || !found {
		t.Fatalf("delete %v %v", found, err)
	}
	if f, _, _ := again.Figures(ctx, "user"); f.Used != 6000 {
		t.Fatalf("used %d with the user's row of the blob left", f.Used)
	}
	if found, _, err := again.RemoveOwner(ctx, a, "user"); err != nil || !found {
		t.Fatalf("delete %v %v", found, err)
	}
	if f, _, _ := again.Figures(ctx, "user"); f.Used != 0 {
		t.Fatalf("used %d with the library's blobs gone", f.Used)
	}
	if v := version(t, path); v != len(steps) {
		t.Fatalf("schema version %d, want %d", v, len(steps))
	}
}

// Rows can be left counted against a key that has no account: before F2's fix an upload recorded as its account was
// deleted left one, and a database from those builds keeps it. The running totals of an account start at nothing, so
// once that key registered its figures left those blobs out, and deleting one took the library below nothing, used
// -4,096, which the phone reads as no figures at all. An account is now made with its totals summed from the rows
// that count against its key already, and its figures are the sums from then on.
func TestAnAccountMadeOverRowsLeftForItsKey(t *testing.T) {
	st, clock := open(t)
	ctx := context.Background()
	left, capture := strings.Repeat("a", 64), strings.Repeat("b", 64)
	for _, q := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO owners(sha256, owner, account, size, created_at, expires_at) VALUES (?, 'user', 'user', 4096, 1, NULL),
			(?, 'device', 'user', 30000, 1, ?), (?, 'user', 'user', 30000, 1, NULL)`, []any{left, capture, clock.Add(InboxLife).Unix(), capture}},
		{`INSERT INTO uploads(account, size, at) VALUES ('user', 30000, ?), ('user', 4096, ?)`, []any{clock.Unix() - 60, clock.Add(-Day).Unix() - 60}},
	} {
		if _, err := st.db.Exec(q.query, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	registered(t, st, "user")
	same := func(when string) {
		t.Helper()
		want, _ := exact(t, st, "user")
		if got, ok, err := st.Figures(ctx, "user"); err != nil || !ok || got != want {
			t.Fatalf("%s: figures %+v %v %v, the sums %+v", when, got, ok, err, want)
		}
	}
	same("made over the rows")
	if found, _, err := st.RemoveOwner(ctx, left, "user"); err != nil || !found {
		t.Fatalf("delete %v %v", found, err)
	}
	same("a blob left deleted")
	if found, _, err := st.RemoveOwner(ctx, capture, "device"); err != nil || !found {
		t.Fatalf("delete %v %v", found, err)
	}
	same("the browser's row of a blob the user holds deleted")
	// registering again changes nothing
	registered(t, st, "user")
	same("registered again")
}

// median is the middle of a run of timings.
func median(d []time.Duration) time.Duration {
	s := slices.Clone(d)
	slices.Sort(s)
	return s[len(s)/2]
}

// A library's figures were summed from its rows on every upload and preflight, refused or not, on keflid's one
// database connection, so one library at its 12,800 blobs could hold that connection with preflights alone: other
// users' uploads took 4.6 s at the median and 7.3 s at worst (probe preflights, 14 answered a second). Read from the
// running totals, the figures of a library with 25,600 blob rows and a full day's 5,120 uploads cost what those of a
// library of one blob cost, timed in turn so the machine's load falls on both alike.
func TestFiguresCostTheSameForAFullLibrary(t *testing.T) {
	st, clock := open(t)
	ctx := context.Background()
	registered(t, st, "full", "small")
	// 12,800 blobs each held by a browser's capture and the user's own copy, and a full day's 5,120 uploads
	for _, fill := range []struct {
		query string
		args  []any
	}{
		{`INSERT INTO owners(sha256, owner, account, size, created_at, expires_at) SELECT printf('%064x', i), 'browser', 'full', 4096, ?, ? FROM n`,
			[]any{12_799, clock.Unix(), clock.Add(InboxLife).Unix()}},
		{`INSERT INTO owners(sha256, owner, account, size, created_at, expires_at) SELECT printf('%064x', i), 'full', 'full', 4096, ?, NULL FROM n`,
			[]any{12_799, clock.Unix()}},
		{`INSERT INTO uploads(account, size, at) SELECT 'full', 4096, ? FROM n`, []any{5_119, clock.Unix()}},
	} {
		if _, err := st.db.Exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?) `+fill.query, fill.args...); err != nil {
			t.Fatal(err)
		}
	}
	if err := st.Upload(ctx, strings.Repeat("f", 64), "small", "small", 30_000, false); err != nil {
		t.Fatal(err)
	}
	if f, _, _ := st.Figures(ctx, "full"); f.Used != DefaultQuota || f.Today != DailyLimit {
		t.Fatalf("the full library's figures %+v", f)
	}
	var full, small []time.Duration
	for range 101 {
		for _, c := range []struct {
			account string
			into    *[]time.Duration
		}{{"full", &full}, {"small", &small}} {
			start := time.Now()
			if _, _, err := st.Figures(ctx, c.account); err != nil {
				t.Fatal(err)
			}
			*c.into = append(*c.into, time.Since(start))
		}
	}
	if m, s := median(full), median(small); m > 5*s {
		t.Fatalf("a full library's figures take %v at the median, a library of one blob's %v", m, s)
	}
}
