package blossom

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// putBlob uploads blob as k at now, its length declared, and returns the answer.
func putBlob(t *testing.T, mux *http.ServeMux, k signer, blob []byte, now time.Time) *httptest.ResponseRecorder {
	t.Helper()
	sum := sha256.Sum256(blob)
	sha := hex.EncodeToString(sum[:])
	req := httptest.NewRequest("PUT", "/upload", bytes.NewReader(blob))
	req.Header.Set("Authorization", k.auth(t, "upload", sha, now))
	req.Header.Set("X-SHA-256", sha)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	return rec
}

// samePrefix is n blobs whose hashes share their first two hex digits, so they share a folder.
func samePrefix(n int) [][]byte {
	byPrefix := map[string][][]byte{}
	for i := 0; ; i++ {
		blob := []byte(fmt.Sprintf("a text a save names, number %d", i))
		sum := sha256.Sum256(blob)
		p := hex.EncodeToString(sum[:1])
		if byPrefix[p] = append(byPrefix[p], blob); len(byPrefix[p]) == n {
			return byPrefix[p]
		}
	}
}

func hashOf(blob []byte) string {
	sum := sha256.Sum256(blob)
	return hex.EncodeToString(sum[:])
}

// syncSeen is a sync the test saw: what was synced, and how the blob being uploaded stood at that moment.
type syncSeen struct {
	name     string
	bytes    []byte // a file's bytes as it was synced; a folder's are nil
	placed   bool   // the blob's file was under its own name
	recorded bool   // an owner row held the blob
}

// syncWatch records every sync the server makes for the upload of *sha, and fails those fail names.
type syncWatch struct {
	seen []syncSeen
	sha  string
	fail func(name string) bool
}

func (w *syncWatch) install(s *Server, st *store.Store) {
	s.syncFile = func(f *os.File) error {
		got, _ := os.ReadFile(f.Name())
		_, err := os.Stat(s.path(w.sha))
		held, _ := st.Stored(context.Background(), w.sha)
		w.seen = append(w.seen, syncSeen{f.Name(), got, err == nil, held})
		if w.fail != nil && w.fail(f.Name()) {
			return &os.PathError{Op: "sync", Path: f.Name(), Err: syscall.EIO}
		}
		return f.Sync()
	}
}

// names is what the syncs since the last call synced, each relative to the blob store's parent folder.
func (w *syncWatch) names(s *Server) []string {
	var out []string
	for _, x := range w.seen {
		rel, _ := filepath.Rel(filepath.Dir(s.Dir), x.name)
		if strings.Contains(filepath.Base(rel), ".upload-") {
			rel = filepath.Join(filepath.Dir(rel), ".upload-*")
		}
		out = append(out, rel)
	}
	w.seen = nil
	return out
}

// Nothing synced a blob's file before its rename, or its folder after it, so a power cut could leave a blob that a
// save names short, empty or missing under its own name, its owner row recorded all the same, and every backup made
// from then on copying it so. Now the whole file is synced before its rename, and its folder after the rename, both
// before the owner row is written and the upload answered: one sync of each for a new blob, and none for a copy of a
// blob already on the disk. A folder new to the disk is synced into the folder above it.
func TestABlobIsOnTheDiskBeforeItIsRecorded(t *testing.T) {
	s, st, clock, mux := testServer(t)
	user := newSigner()
	if err := st.Register(context.Background(), user.pk); err != nil {
		t.Fatal(err)
	}
	w := &syncWatch{}
	w.install(s, st)
	blobs := samePrefix(2)
	first, second := blobs[0], blobs[1]
	folder := filepath.Join("blobs", hashOf(first)[:2])

	w.sha = hashOf(first)
	if rec := putBlob(t, mux, user, first, *clock); rec.Code != http.StatusOK {
		t.Fatalf("upload %d %s", rec.Code, rec.Body)
	}
	seen := w.seen
	want := []string{".", "blobs", filepath.Join(folder, ".upload-*"), folder}
	if got := w.names(s); strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("synced %v, want %v: the new folders into theirs, the file, then its folder", got, want)
	}
	if file := seen[2]; !bytes.Equal(file.bytes, first) || file.placed || file.recorded {
		t.Fatalf("the file was synced with %d of its %d bytes, renamed %v, recorded %v: it must be whole, before its rename",
			len(file.bytes), len(first), file.placed, file.recorded)
	}
	if dir := seen[3]; !dir.placed || dir.recorded {
		t.Fatalf("the folder was synced with the blob renamed %v, recorded %v: after the rename, before the record", dir.placed, dir.recorded)
	}
	if got, err := os.ReadFile(s.path(w.sha)); err != nil || !bytes.Equal(got, first) {
		t.Fatalf("the blob on the disk: %d bytes, %v", len(got), err)
	}

	// a second blob in the same folder: its file and its folder, one sync each
	w.sha = hashOf(second)
	if rec := putBlob(t, mux, user, second, *clock); rec.Code != http.StatusOK {
		t.Fatalf("upload %d %s", rec.Code, rec.Body)
	}
	if got, want := w.names(s), []string{filepath.Join(folder, ".upload-*"), folder}; strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("a new blob in a folder that stands synced %v, want %v", got, want)
	}

	// a copy of a blob on the disk is never written, so it syncs nothing
	w.sha = hashOf(first)
	if rec := putBlob(t, mux, user, first, *clock); rec.Code != http.StatusOK {
		t.Fatalf("a copy: %d %s", rec.Code, rec.Body)
	}
	if got := w.names(s); len(got) != 0 {
		t.Fatalf("a copy synced %v", got)
	}

	// a file left short from before blobs were synced is written again by the next copy, and synced as a new one is
	if err := os.WriteFile(s.path(w.sha), first[:3], 0o600); err != nil {
		t.Fatal(err)
	}
	if rec := putBlob(t, mux, user, first, *clock); rec.Code != http.StatusOK {
		t.Fatalf("a copy over a short file: %d %s", rec.Code, rec.Body)
	}
	if got, want := w.names(s), []string{filepath.Join(folder, ".upload-*"), folder}; strings.Join(got, " ") != strings.Join(want, " ") {
		t.Fatalf("a short file written again synced %v, want %v", got, want)
	}
	if got, err := os.ReadFile(s.path(w.sha)); err != nil || !bytes.Equal(got, first) {
		t.Fatalf("the short file written again: %d bytes, %v", len(got), err)
	}
}

// A sync that fails, the file's or its folder's, answers 500 server, which the client sends again, and leaves
// nothing: no owner row, no blob under its name, no temporary, and nothing against the library's day. Sent again once
// the disk syncs, the blob is stored.
func TestASyncThatFailsLeavesNothing(t *testing.T) {
	s, st, clock, mux := testServer(t)
	ctx := context.Background()
	user := newSigner()
	if err := st.Register(ctx, user.pk); err != nil {
		t.Fatal(err)
	}
	w := &syncWatch{}
	w.install(s, st)
	blob := []byte("a text whose disk fails as it is synced")
	w.sha = hashOf(blob)
	folder := filepath.Dir(s.path(w.sha))
	for _, failing := range []string{"the file", "its folder"} {
		w.fail = func(name string) bool {
			if failing == "the file" {
				return filepath.Dir(name) == folder && strings.HasPrefix(filepath.Base(name), ".upload-")
			}
			return name == folder
		}
		rec := putBlob(t, mux, user, blob, *clock)
		if rec.Code != http.StatusInternalServerError || rec.Header().Get("X-Reason") != "server" {
			t.Fatalf("a failed sync of %s: %d %q", failing, rec.Code, rec.Header().Get("X-Reason"))
		}
		if held, err := st.Holds(ctx, user.pk, w.sha); held || err != nil {
			t.Fatalf("a failed sync of %s was recorded (%v)", failing, err)
		}
		if _, err := os.Stat(s.path(w.sha)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("a failed sync of %s left the blob under its name: %v", failing, err)
		}
		if left, _ := filepath.Glob(filepath.Join(folder, ".upload-*")); len(left) != 0 {
			t.Fatalf("a failed sync of %s left %v", failing, left)
		}
		if f, _, _ := st.Figures(ctx, user.pk); f.Used != 0 || f.Today != 0 {
			t.Fatalf("a failed sync of %s counted: %+v", failing, f)
		}
	}
	w.fail = nil
	if rec := putBlob(t, mux, user, blob, *clock); rec.Code != http.StatusOK {
		t.Fatalf("sent again: %d %s", rec.Code, rec.Body)
	}
	if got, err := os.ReadFile(s.path(w.sha)); err != nil || !bytes.Equal(got, blob) {
		t.Fatalf("the blob sent again: %d bytes, %v", len(got), err)
	}
}

// A filesystem that can't sync a folder at all answers the folder's sync EINVAL or ENOTSUP, as some network and FUSE
// ones do: refusing every upload there would keep every text on the phones, so the upload goes ahead, its file synced
// all the same. Any other failure of a folder's sync is still a 500 (TestASyncThatFailsLeavesNothing).
func TestAFolderThatCantBeSyncedStillTakesUploads(t *testing.T) {
	s, st, clock, mux := testServer(t)
	user := newSigner()
	if err := st.Register(context.Background(), user.pk); err != nil {
		t.Fatal(err)
	}
	for i, answer := range []error{syscall.EINVAL, syscall.ENOTSUP} {
		files := 0
		s.syncFile = func(f *os.File) error {
			if info, err := f.Stat(); err == nil && info.IsDir() {
				return &os.PathError{Op: "sync", Path: f.Name(), Err: answer}
			}
			files++
			return f.Sync()
		}
		blob := []byte(fmt.Sprintf("a text on a filesystem whose folders can't be synced, %d", i))
		if rec := putBlob(t, mux, user, blob, *clock); rec.Code != http.StatusOK {
			t.Fatalf("a folder answering %v: %d %s", answer, rec.Code, rec.Body)
		}
		if got, err := os.ReadFile(s.path(hashOf(blob))); err != nil || !bytes.Equal(got, blob) || files != 1 {
			t.Fatalf("a folder answering %v: %d bytes on the disk, %d files synced, %v", answer, len(got), files, err)
		}
	}
}
