package main

import (
	"bytes"
	"context"
	"io"
	"path/filepath"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

func TestRun(t *testing.T) {
	db := filepath.Join(t.TempDir(), "k.db")
	pk := "1111111111111111111111111111111111111111111111111111111111111111"
	for _, args := range [][]string{{"register", pk}, {"disable", pk}} {
		if err := run(db, args, io.Discard); err != nil {
			t.Fatal(err)
		}
	}
	st, _ := store.Open(db)
	if _, ok, _ := st.Account(context.Background(), pk); ok {
		t.Fatal("a disabled key is still on the allowlist")
	}
	st.Close()
	if err := run(db, []string{"enable", pk}, io.Discard); err != nil {
		t.Fatal(err)
	}
	for _, bad := range [][]string{{"register"}, {"register", "nothex"}, {"frobnicate", pk}, {"gone", "-1"}, {"gone", "a"}} {
		if err := run(db, bad, io.Discard); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
}

func TestGone(t *testing.T) {
	db := filepath.Join(t.TempDir(), "k.db")
	pk := "2222222222222222222222222222222222222222222222222222222222222222"
	st, _ := store.Open(db)
	ctx := context.Background()
	st.Register(ctx, pk)
	st.Now = func() time.Time { return time.Now().Add(-31 * 24 * time.Hour) }
	if _, err := st.DeleteAccount(ctx, pk); err != nil {
		t.Fatal(err)
	}
	st.Close()
	for days, want := range map[string]string{"0": pk + "\n", "30": pk + "\n", "40": ""} {
		var out bytes.Buffer
		if err := run(db, []string{"gone", days}, &out); err != nil || out.String() != want {
			t.Fatalf("gone %s: %q, %v", days, out.String(), err)
		}
	}
}
