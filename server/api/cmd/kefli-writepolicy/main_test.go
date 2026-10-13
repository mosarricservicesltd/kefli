package main

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/policy"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

func TestRun(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "k.db"))
	if err != nil {
		t.Fatal(err)
	}
	user := strings.Repeat("1", 64)
	_ = st.Register(context.Background(), user)
	st.Close()
	// a wrap the relay's sweep dropped long ago, still in the record: forgotten as the plugin starts (F45)
	wraps, err := policy.OpenWraps(filepath.Join(dir, "w.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := wraps.Exec(`INSERT INTO wraps(id, author, p, at) VALUES('old', 'a', ?, ?)`, user, time.Now().Add(-policy.WrapLife-time.Hour).Unix()); err != nil {
		t.Fatal(err)
	}
	in := `{"type":"new","event":{"id":"e1","pubkey":"` + user + `","kind":30078,"tags":[]},"sourceType":"IP4","sourceInfo":"x"}` + "\n"
	var out bytes.Buffer
	if err := run([]string{"-db", filepath.Join(dir, "k.db"), "-wraps", filepath.Join(dir, "w.db")}, strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	var o map[string]string
	if err := json.Unmarshal(out.Bytes(), &o); err != nil || o["action"] != "accept" || o["id"] != "e1" {
		t.Fatalf("%s %v", out.String(), err)
	}
	var n int
	if err := wraps.QueryRow(`SELECT COUNT(*) FROM wraps`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("%d old wraps kept %v", n, err)
	}
	wraps.Close()
	if err := run([]string{"-nonsense"}, strings.NewReader(""), &out); err == nil {
		t.Fatal("accepted an unknown flag")
	}
}
