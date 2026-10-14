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

// Flow decision 117: keflictl quota sets one library's quota, the key given in hex or as an npub, in whole megabytes
// of 1,048,576 bytes, and the library keeps it.
func TestQuota(t *testing.T) {
	db := filepath.Join(t.TempDir(), "k.db")
	hexKey := "7e7e9c42a91bfef19fa929e5fda1b72e0ebc1a4c1141673e2794234d86addf4e"
	if err := run(db, []string{"register", hexKey}, io.Discard); err != nil {
		t.Fatal(err)
	}
	quotaOf := func() int64 {
		t.Helper()
		st, err := store.Open(db)
		if err != nil {
			t.Fatal(err)
		}
		defer st.Close()
		f, ok, err := st.Figures(context.Background(), hexKey)
		if err != nil || !ok {
			t.Fatalf("figures %v %v", ok, err)
		}
		return f.Quota
	}
	if q := quotaOf(); q != store.DefaultQuota {
		t.Fatalf("a new library's quota %d", q)
	}
	for _, c := range []struct {
		who, mb, said string
		want          int64
	}{
		{hexKey, "200", "quota 7e7e9c42a91b 200 MB\n", 200 << 20},
		{"npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjptg", "75", "quota 7e7e9c42a91b 75 MB\n", 75 << 20},
		{"NPUB10ELFCS4FR0L0R8AF98JLMGDH9C8TCXJVZ9QKW038JS35MP4DMA8QZVJPTG", "0", "quota 7e7e9c42a91b 0 MB\n", 0},
	} {
		var out bytes.Buffer
		if err := run(db, []string{"quota", c.who, c.mb}, &out); err != nil || out.String() != c.said {
			t.Fatalf("quota %s %s: %q %v", c.who, c.mb, out.String(), err)
		}
		if q := quotaOf(); q != c.want {
			t.Fatalf("quota %s %s set %d, want %d", c.who, c.mb, q, c.want)
		}
	}
	for _, bad := range [][]string{
		{"quota", hexKey},
		{"quota", hexKey, "-1"},
		{"quota", hexKey, "1.5"},
		{"quota", hexKey, "lots"},
		{"quota", hexKey, "8796093022208"},
		{"quota", "nsec1zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygs4rm7hz", "100"},
		{"quota", "npub10elfcs4fr0l0r8af98jlmgdh9c8tcxjvz9qkw038js35mp4dma8qzvjpth", "100"},
		{"quota", "2222222222222222222222222222222222222222222222222222222222222222", "100"},
	} {
		if err := run(db, bad, io.Discard); err == nil {
			t.Fatalf("accepted %v", bad)
		}
	}
	if q := quotaOf(); q != 0 {
		t.Fatalf("a refused command changed the quota to %d", q)
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
