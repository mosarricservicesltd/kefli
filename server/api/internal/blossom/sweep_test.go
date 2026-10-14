package blossom

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// The hourly sweep of files looked for an owner of each blob file and then removed it, outside the upload lock, so an
// upload of the same blob that renamed its file into place and recorded its owner between the two lost the file:
// a blob recorded, counted against its library, and served to nobody. A capture its library's figures let go of once
// it expired is just such a file, left for this sweep. Now the sweep looks again, and removes, under the upload lock,
// as Unlink does: while an upload commits it waits, and a blob the upload recorded keeps its file.
func TestTheSweepOfFilesWaitsForAnUpload(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "k.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	clock := time.Unix(1_791_600_000, 0)
	st.Now = func() time.Time { return clock }
	ctx := context.Background()
	if err := st.Register(ctx, "user"); err != nil {
		t.Fatal(err)
	}
	s := New(filepath.Join(t.TempDir(), "blobs"), "http://b", st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	sha := fmt.Sprintf("%064x", 7)
	file := s.path(sha)
	if err := os.MkdirAll(filepath.Dir(file), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("an expired capture"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := clock.Add(-2 * time.Hour)
	if err := os.Chtimes(file, old, old); err != nil {
		t.Fatal(err)
	}
	// an upload of the same blob is committing: it holds the lock
	s.commitMu.Lock()
	done := make(chan int, 1)
	go func() {
		n, _ := s.SweepFiles(ctx, clock)
		done <- n
	}()
	select {
	case n := <-done:
		s.commitMu.Unlock()
		t.Fatalf("the sweep removed %d files while an upload was committing", n)
	case <-time.After(300 * time.Millisecond):
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("the file went while an upload was committing: %v", err)
	}
	// the upload puts the blob back in place and records its owner
	if err := os.WriteFile(file, []byte("an expired capture"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := st.Upload(ctx, sha, "user", "user", 18, false); err != nil {
		t.Fatal(err)
	}
	s.commitMu.Unlock()
	if n := <-done; n != 0 {
		t.Fatalf("the sweep removed %d files", n)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("a blob the upload recorded lost its file: %v", err)
	}
}
