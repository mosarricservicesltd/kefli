package policy_test

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/policy"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

const (
	user   = "1111111111111111111111111111111111111111111111111111111111111111"
	device = "2222222222222222222222222222222222222222222222222222222222222222"
	throw  = "3333333333333333333333333333333333333333333333333333333333333333"
)

func setup(t *testing.T) (*policy.Policy, *sql.DB, *store.Store) {
	p, wraps, st, _ := setupDB(t)
	return p, wraps, st
}

// setupDB is setup with keflid's database as the plugin opens it, read-only.
func setupDB(t *testing.T) (*policy.Policy, *sql.DB, *store.Store, *sql.DB) {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "keflid.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	ro, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "keflid.db")+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	wraps, err := policy.OpenWraps(filepath.Join(dir, "wraps.db"))
	if err != nil {
		t.Fatal(err)
	}
	return policy.New(policy.NewDB(ro, wraps), time.Now), wraps, st, ro
}

func lineFor(ev map[string]any) string {
	raw, _ := json.Marshal(ev)
	in, _ := json.Marshal(map[string]any{"type": "new", "event": json.RawMessage(raw), "sourceType": "IP4", "sourceInfo": "198.51.100.1"})
	return string(in)
}

func serve(t *testing.T, p *policy.Policy, wraps *sql.DB, lines ...string) ([]policy.Output, chan []string) {
	t.Helper()
	removed := make(chan []string, 4)
	var out bytes.Buffer
	if err := policy.Serve(strings.NewReader(strings.Join(lines, "\n")+"\nnot json\n"), &out, p, wraps, func(ids []string) { removed <- ids }); err != nil {
		t.Fatal(err)
	}
	var res []policy.Output
	for dec := json.NewDecoder(&out); dec.More(); {
		var o policy.Output
		if err := dec.Decode(&o); err != nil {
			t.Fatal(err)
		}
		res = append(res, o)
	}
	return res, removed
}

func TestServeAgainstTheDatabase(t *testing.T) {
	p, wraps, st := setup(t)
	ctx := context.Background()
	// registered after the plugin started: taken at once, without waiting for the snapshot
	if err := st.Register(ctx, user); err != nil {
		t.Fatal(err)
	}
	if err := st.AddDevice(ctx, user, device); err != nil {
		t.Fatal(err)
	}
	out, removed := serve(t, p, wraps,
		lineFor(map[string]any{"id": "item", "pubkey": user, "kind": 30078, "tags": [][]string{}}),
		lineFor(map[string]any{"id": "w1", "pubkey": throw, "kind": 1059, "tags": [][]string{{"p", user}}}),
		lineFor(map[string]any{"id": "ack", "pubkey": throw, "kind": 1059, "tags": [][]string{{"p", device}}}),
		lineFor(map[string]any{"id": "undo", "pubkey": throw, "kind": 5, "tags": [][]string{{"e", "w1"}}}),
		lineFor(map[string]any{"id": "again", "pubkey": throw, "kind": 5, "tags": [][]string{{"e", "w1"}}}),
		lineFor(map[string]any{"id": "w2", "pubkey": throw, "kind": 1059, "tags": [][]string{{"p", user}}}),
		lineFor(map[string]any{"id": "consumed", "pubkey": user, "kind": 5, "tags": [][]string{{"e", "w2"}}}),
		lineFor(map[string]any{"id": "not mine", "pubkey": user, "kind": 5, "tags": [][]string{{"e", "ack"}}}),
	)
	want := []string{"accept", "accept", "accept", "accept", "reject", "accept", "accept", "accept"}
	if len(out) != len(want) {
		t.Fatalf("answers %+v", out)
	}
	for i, o := range out {
		if o.Action != want[i] {
			t.Fatalf("answer %d: %+v", i, o)
		}
	}
	select {
	case ids := <-removed:
		if len(ids) != 1 || ids[0] != "w2" {
			t.Fatalf("removed %v", ids)
		}
	case <-time.After(time.Second):
		t.Fatal("the consumed wrap wasn't passed on for removal")
	}
	select {
	case ids := <-removed:
		t.Fatalf("a wrap addressed to someone else was removed for the user: %v", ids)
	case <-time.After(100 * time.Millisecond):
	}
	var left []string
	rows, _ := wraps.Query(`SELECT id FROM wraps`)
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		left = append(left, id)
	}
	rows.Close()
	// "not mine" names the device's pair-ack: the user's kind 5 is accepted (strfry deletes only the user's own events),
	// so the relay keeps that wrap and the record keeps it too
	if len(left) != 1 || left[0] != "ack" {
		t.Fatalf("recorded %v, want only the pair-ack the relay still holds", left)
	}
}

func TestApplyIgnoresRefusals(t *testing.T) {
	_, wraps, _ := setup(t)
	v := policy.Verdict{Out: policy.Output{ID: "w", Action: "reject"}, Record: &policy.Wrap{ID: "w", Author: throw, P: user}}
	if err := policy.Apply(wraps, v, policy.Input{}); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = wraps.QueryRow(`SELECT COUNT(*) FROM wraps`).Scan(&n)
	if n != 0 {
		t.Fatal("a refused wrap was recorded")
	}
}

// F45: the record used to keep every wrap the sweep dropped, and the recipients of deleted accounts, for good.
func TestPruneWraps(t *testing.T) {
	_, wraps, st, ro := setupDB(t)
	ctx := context.Background()
	deleted := strings.Repeat("4", 64)
	for _, k := range []string{user, deleted} {
		if err := st.Register(ctx, k); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := st.DeleteAccount(ctx, deleted); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, w := range []struct {
		id, p string
		at    time.Time
	}{
		{"kept", user, now.Add(-policy.WrapLife + time.Hour)},
		{"swept", user, now.Add(-policy.WrapLife - time.Hour)},
		{"to the deleted", deleted, now},
	} {
		if _, err := wraps.Exec(`INSERT INTO wraps(id, author, p, at) VALUES(?, ?, ?, ?)`, w.id, throw, w.p, w.at.Unix()); err != nil {
			t.Fatal(err)
		}
	}
	if err := policy.PruneWraps(wraps, ro, now); err != nil {
		t.Fatal(err)
	}
	var left []string
	rows, _ := wraps.Query(`SELECT id FROM wraps`)
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		left = append(left, id)
	}
	rows.Close()
	if len(left) != 1 || left[0] != "kept" {
		t.Fatalf("left %v, want only the wrap the relay still holds", left)
	}
}

// recorded lists the ids of the wraps the record holds.
func recorded(t *testing.T, wraps *sql.DB) []string {
	t.Helper()
	rows, err := wraps.Query(`SELECT id FROM wraps ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	return ids
}

// The hourly prune read every key on keflid's gone list, 60 days of removed keys, and deleted the wraps of each again,
// though the prunes before had done so and the policy takes no wrap to a removed key. Now a prune reads only the keys
// removed since the last prune began, less PruneOverlap: a key removed just before a prune, whose wrap the policy took
// in the seconds its allowlist was stale, is forgotten by the next one, and a key removed long before isn't read
// again, which a wrap recorded to it here shows. A record with no prune yet reads the whole list.
func TestPruneWrapsReadsOnlyKeysRemovedSince(t *testing.T) {
	_, wraps, st, ro := setupDB(t)
	ctx := context.Background()
	first := time.Unix(1_791_600_000, 0)
	removed := func(k string, at time.Time) {
		t.Helper()
		st.Now = func() time.Time { return at }
		if err := st.Register(ctx, k); err != nil {
			t.Fatal(err)
		}
		if _, err := st.DeleteAccount(ctx, k); err != nil {
			t.Fatal(err)
		}
	}
	wrap := func(id, p string, at time.Time) {
		t.Helper()
		if _, err := wraps.Exec(`INSERT INTO wraps(id, author, p, at) VALUES(?, ?, ?, ?)`, id, throw, p, at.Unix()); err != nil {
			t.Fatal(err)
		}
	}
	long, edge, later := strings.Repeat("4", 64), strings.Repeat("5", 64), strings.Repeat("6", 64)
	removed(long, first.Add(-10*24*time.Hour))
	removed(edge, first.Add(-30*time.Minute))
	wrap("to the long gone", long, first.Add(-11*24*time.Hour))
	wrap("to a user", user, first)
	// no prune yet: every key on the list is read
	if err := policy.PruneWraps(wraps, ro, first); err != nil {
		t.Fatal(err)
	}
	if got := recorded(t, wraps); strings.Join(got, ",") != "to a user" {
		t.Fatalf("after the first prune %v", got)
	}
	// the policy took a wrap to edge in the seconds after its key went; later goes after the prune
	wrap("to the edge", edge, first.Add(2*time.Second))
	removed(later, first.Add(30*time.Minute))
	wrap("to the later", later, first.Add(29*time.Minute))
	wrap("to the long gone again", long, first.Add(time.Minute))
	if err := policy.PruneWraps(wraps, ro, first.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	if got := recorded(t, wraps); strings.Join(got, ",") != "to a user,to the long gone again" {
		t.Fatalf("after the second prune %v: the keys removed since the first, less an hour, and only those", got)
	}
}

// The floor reads the disk at most once a second, and a reading that fails counts as room.
func TestFloor(t *testing.T) {
	now := time.Unix(1_791_600_000, 0)
	free, reads := int64(10<<20), 0
	var fail error
	full := policy.Floor("/x", 5<<20, func(string) (int64, error) { reads++; return free, fail }, func() time.Time { return now })
	if full() {
		t.Fatal("10 MB free, floor 5 MB")
	}
	free = 1 << 20
	if full() || reads != 1 {
		t.Fatalf("read again within the second (%d reads)", reads)
	}
	now = now.Add(time.Second)
	if !full() {
		t.Fatal("1 MB free, floor 5 MB")
	}
	now, fail = now.Add(time.Second), errors.New("statfs failed")
	if full() {
		t.Fatal("a failed reading stopped the relay")
	}
	if free, _ := policy.DiskFree(t.TempDir()); free <= 0 {
		t.Fatalf("free %d", free)
	}
}

// F9: a wrap sent on a connection AUTHed as the recipient's device is told apart through keflid's database.
func TestAuthedWrapsAgainstTheDatabase(t *testing.T) {
	p, wraps, st := setup(t)
	ctx := context.Background()
	if err := st.Register(ctx, user); err != nil {
		t.Fatal(err)
	}
	if err := st.AddDevice(ctx, user, device); err != nil {
		t.Fatal(err)
	}
	var lines []string
	for i := 0; i <= policy.ToAddrMax; i++ {
		lines = append(lines, lineFor(map[string]any{"id": "junk", "pubkey": throw, "kind": 1059, "tags": [][]string{{"p", user}}}))
	}
	raw, _ := json.Marshal(map[string]any{"id": "save", "pubkey": throw, "kind": 1059, "tags": [][]string{{"p", user}}})
	authed, _ := json.Marshal(map[string]any{"type": "new", "event": json.RawMessage(raw), "sourceType": "IP4", "sourceInfo": "198.51.100.1", "authed": device})
	out, _ := serve(t, p, wraps, append(lines, string(authed))...)
	if out[policy.ToAddrMax].Action != "reject" || out[len(out)-1].Action != "accept" {
		t.Fatalf("the junk's last %+v, the browser's save %+v", out[policy.ToAddrMax], out[len(out)-1])
	}
}
