package blossom

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// signer is a key that signs kind 24242 authorisations at the test's time.
type signer struct{ sk, pk string }

func newSigner() signer {
	sk := nostr.GeneratePrivateKey()
	pk, _ := nostr.GetPublicKey(sk)
	return signer{sk, pk}
}

func (k signer) auth(t *testing.T, verb, sha string, now time.Time) string {
	t.Helper()
	ev := nostr.Event{Kind: 24242, CreatedAt: nostr.Timestamp(now.Unix()), Tags: nostr.Tags{{"t", verb}, {"x", sha}, {"expiration", strconv.FormatInt(now.Add(time.Hour).Unix(), 10)}}}
	if err := ev.Sign(k.sk); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(ev)
	return "Nostr " + base64.StdEncoding.EncodeToString(raw)
}

func inode(t *testing.T, path string) uint64 {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Sys().(*syscall.Stat_t).Ino
}

// A blob the server stores costs nothing against fair use when it is sent again, as after a lost answer, by a move
// or as a browser's copy of a blob its library holds, yet each copy was written whole and renamed over identical
// bytes, so one address could keep the disk writing at the link's rate, 8 MB a request. Now a copy's body is checked
// against its hash and not written: the file stays the one first written. A copy whose file goes while its body
// arrives, its last owner having deleted it, gets 500, and sent again it is written.
func TestACopyOfAStoredBlobIsNotWrittenAgain(t *testing.T) {
	s, st, clock, mux := testServer(t)
	ctx := context.Background()
	user, other, third := newSigner(), newSigner(), newSigner()
	for _, k := range []signer{user, other, third} {
		if err := st.Register(ctx, k.pk); err != nil {
			t.Fatal(err)
		}
	}
	blob := []byte("a text sent again after a lost answer, and by a move")
	sum := sha256.Sum256(blob)
	sha := hex.EncodeToString(sum[:])
	put := func(k signer, body io.Reader) *httptest.ResponseRecorder {
		req := httptest.NewRequest("PUT", "/upload", body)
		req.ContentLength = int64(len(blob))
		req.Header.Set("Authorization", k.auth(t, "upload", sha, *clock))
		req.Header.Set("X-SHA-256", sha)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec
	}
	if rec := put(user, bytes.NewReader(blob)); rec.Code != http.StatusOK {
		t.Fatalf("upload %d %s", rec.Code, rec.Body)
	}
	first := inode(t, s.path(sha))
	written := time.Now().Add(-2 * time.Hour).Truncate(time.Second)
	if err := os.Chtimes(s.path(sha), written, written); err != nil {
		t.Fatal(err)
	}
	for _, k := range []signer{user, other} {
		if rec := put(k, bytes.NewReader(blob)); rec.Code != http.StatusOK {
			t.Fatalf("a copy: %d %s", rec.Code, rec.Body)
		}
		info, err := os.Stat(s.path(sha))
		if err != nil || inode(t, s.path(sha)) != first || !info.ModTime().Equal(written) {
			t.Fatalf("a copy of a stored blob was written to the disk again: %v", err)
		}
	}
	if f, _, _ := st.Figures(ctx, other.pk); f.Used != store.Cost(int64(len(blob))) || f.Today != 0 {
		t.Fatalf("the other library's figures %+v", f)
	}
	// every owner lets go of the blob, and its file goes, while a third library's copy arrives
	pr, pw := io.Pipe()
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() { done <- put(third, pr) }()
	if _, err := pw.Write(blob[:10]); err != nil { // read by the upload once it has looked at the disk
		t.Fatal(err)
	}
	for _, k := range []signer{user, other} {
		if _, _, err := st.RemoveOwner(ctx, sha, k.pk); err != nil {
			t.Fatal(err)
		}
	}
	s.Unlink(sha)
	_, _ = pw.Write(blob[10:])
	_ = pw.Close()
	if rec := <-done; rec.Code != http.StatusInternalServerError || rec.Header().Get("X-Reason") != "server" {
		t.Fatalf("a copy whose file went: %d %q", rec.Code, rec.Header().Get("X-Reason"))
	}
	if held, _ := st.Holds(ctx, third.pk, sha); held {
		t.Fatal("a copy whose file went was recorded")
	}
	if rec := put(third, bytes.NewReader(blob)); rec.Code != http.StatusOK {
		t.Fatalf("sent again: %d %s", rec.Code, rec.Body)
	}
	if got, err := os.ReadFile(s.path(sha)); err != nil || !bytes.Equal(got, blob) {
		t.Fatalf("the blob sent again isn't on the disk: %v", err)
	}
}

// Nothing syncs a blob's file before its rename, so a power cut can leave it short on the disk, or empty, under its
// own name; the next copy of it sent whole wrote it again, until copies were checked and not written, after which
// the file stayed short for good and was served short (probe truncated). A copy whose file on the disk isn't the size
// of its body, checked against its hash as any upload's is, is written again, and the blob is served whole; one whose
// file is whole is still not written.
func TestACopyMendsAFileCutShort(t *testing.T) {
	s, st, clock, mux := testServer(t)
	user := newSigner()
	if err := st.Register(context.Background(), user.pk); err != nil {
		t.Fatal(err)
	}
	blob := bytes.Repeat([]byte("a text whose file a power cut left short "), 2000)
	sum := sha256.Sum256(blob)
	sha := hex.EncodeToString(sum[:])
	put := func() int {
		req := httptest.NewRequest("PUT", "/upload", bytes.NewReader(blob))
		req.Header.Set("Authorization", user.auth(t, "upload", sha, *clock))
		req.Header.Set("X-SHA-256", sha)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		return rec.Code
	}
	if c := put(); c != http.StatusOK {
		t.Fatalf("upload %d", c)
	}
	get := fetcher(mux)
	for _, cut := range []int{0, len(blob) / 2} {
		if err := os.WriteFile(s.path(sha), blob[:cut], 0o600); err != nil {
			t.Fatal(err)
		}
		if c := put(); c != http.StatusOK {
			t.Fatalf("a copy over a file of %d bytes: %d", cut, c)
		}
		if got, err := os.ReadFile(s.path(sha)); err != nil || !bytes.Equal(got, blob) {
			t.Fatalf("a file of %d bytes, after a whole copy: %d bytes (%v)", cut, len(got), err)
		}
		if d := get("GET", sha, mirror); d.code != http.StatusOK || d.sent != int64(len(blob)) {
			t.Fatalf("served %d, %d bytes", d.code, d.sent)
		}
	}
	whole := inode(t, s.path(sha))
	if c := put(); c != http.StatusOK || inode(t, s.path(sha)) != whole {
		t.Fatalf("a copy of a whole file: %d, written again %v", c, inode(t, s.path(sha)) != whole)
	}
	if f, _, _ := st.Figures(context.Background(), user.pk); f.Used != int64(len(blob)) || f.Today != int64(len(blob)) {
		t.Fatalf("figures %+v: a mended file counts once", f)
	}
}
