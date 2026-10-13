package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/blossom"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

func write(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadDefaults(t *testing.T) {
	good := `{"v":1,"operator":{"relay":"wss://r","blossom":"https://b","api":"https://a"},"relays":[],"mirrors":[]}`
	if _, err := readDefaults(write(t, "d.json", good)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`{"v":2,"operator":{"relay":"r","blossom":"b","api":"a"}}`, `{"v":1,"operator":{"relay":"r"}}`, `nonsense`} {
		if _, err := readDefaults(write(t, "d.json", bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	if _, err := readDefaults(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("accepted a missing file")
	}
}

func TestReadNames(t *testing.T) {
	n, err := readNames(write(t, "n.json", `{"names":{"_":"ab"},"relays":["wss://r"]}`))
	if err != nil || n.Names["_"] != "ab" || n.Relays[0] != "wss://r" {
		t.Fatalf("%+v %v", n, err)
	}
	if n, err := readNames(""); err != nil || n.Names != nil {
		t.Fatal("no file should mean no names")
	}
	if _, err := readNames(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("accepted a missing file")
	}
}

func TestSweepOnce(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "k.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	clock := time.Unix(1_791_600_000, 0)
	st.Now = func() time.Time { return clock }
	ctx := context.Background()
	sha := "aa" + "00000000000000000000000000000000000000000000000000000000000000"[:62]
	blobs := blossom.New(filepath.Join(dir, "blobs"), "http://b", st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	_ = os.MkdirAll(filepath.Join(dir, "blobs", "aa"), 0o750)
	_ = os.WriteFile(filepath.Join(dir, "blobs", "aa", sha), []byte("x"), 0o600)
	if err := st.AddOwner(ctx, sha, "device", "user", 1, true); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(store.InboxLife)
	if err := sweepOnce(ctx, st, blobs); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "blobs", "aa", sha)); !os.IsNotExist(err) {
		t.Fatal("an expired inbox blob's file is still there")
	}
}

// run starts both servers from the environment, answers, and shuts down when its context ends.
func TestRunServesAndStops(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("KEFLID_DEFAULTS", write(t, "d.json", `{"v":1,"operator":{"relay":"wss://r","blossom":"https://b","api":"https://a"}}`))
	t.Setenv("KEFLID_DB", filepath.Join(dir, "k.db"))
	t.Setenv("KEFLID_BLOBS", filepath.Join(dir, "blobs"))
	t.Setenv("KEFLID_API_ADDR", "127.0.0.1:18447")
	t.Setenv("KEFLID_BLOSSOM_ADDR", "127.0.0.1:13447")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, slog.New(slog.NewTextHandler(io.Discard, nil))) }()
	var res *http.Response
	var err error
	for i := 0; i < 50; i++ {
		if res, err = http.Get("http://127.0.0.1:18447/health"); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("health: %v", err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run didn't stop")
	}
	t.Setenv("KEFLID_MIN_FREE_MB", "lots")
	if err := run(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		t.Fatal("ran with a free-space floor that isn't a number")
	}
	t.Setenv("KEFLID_DEFAULTS", filepath.Join(dir, "missing.json"))
	if err := run(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		t.Fatal("ran without defaults.json")
	}
}

// serve reports an address it can't listen on.
func TestServeFailsOnABusyAddress(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	if err := serve(context.Background(), []*http.Server{server(busy.Addr().String(), http.NewServeMux())}, slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		t.Fatal("served on a busy address")
	}
}
