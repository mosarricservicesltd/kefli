package main

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

func TestRun(t *testing.T) {
	db := filepath.Join(t.TempDir(), "k.db")
	pk := "1111111111111111111111111111111111111111111111111111111111111111"
	for _, args := range [][]string{{"register", pk}, {"disable", pk}} {
		if err := run(db, args); err != nil {
			t.Fatal(err)
		}
	}
	st, _ := store.Open(db)
	if _, ok, _ := st.Account(context.Background(), pk); ok {
		t.Fatal("a disabled key is still on the allowlist")
	}
	st.Close()
	if err := run(db, []string{"enable", pk}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]string{{"register"}, {"register", "nothex"}, {"frobnicate", pk}} {
		if err := run(db, bad); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
}
