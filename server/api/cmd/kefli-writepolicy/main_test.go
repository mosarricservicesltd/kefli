package main

import (
	"bytes"
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

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
	in := `{"type":"new","event":{"id":"e1","pubkey":"` + user + `","kind":30078,"tags":[]},"sourceType":"IP4","sourceInfo":"x"}` + "\n"
	var out bytes.Buffer
	if err := run([]string{"-db", filepath.Join(dir, "k.db"), "-wraps", filepath.Join(dir, "w.db")}, strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	var o map[string]string
	if err := json.Unmarshal(out.Bytes(), &o); err != nil || o["action"] != "accept" || o["id"] != "e1" {
		t.Fatalf("%s %v", out.String(), err)
	}
	if err := run([]string{"-nonsense"}, strings.NewReader(""), &out); err == nil {
		t.Fatal("accepted an unknown flag")
	}
}
