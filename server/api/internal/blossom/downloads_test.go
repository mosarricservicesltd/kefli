package blossom

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// testServer is a blob store on a fresh database behind Caddy, whose clock the test moves, with its routes.
func testServer(t *testing.T) (*Server, *store.Store, *time.Time, *http.ServeMux) {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "k.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	clock := time.Unix(1_791_600_000, 0)
	st.Now = func() time.Time { return clock }
	s := New(filepath.Join(t.TempDir(), "blobs"), "http://b", st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	s.TrustProxy = true
	mux := http.NewServeMux()
	s.Routes(mux)
	return s, st, &clock, mux
}

// discard is an answer whose body is counted and dropped.
type discard struct {
	header http.Header
	code   int
	sent   int64
}

func (d *discard) Header() http.Header { return d.header }

func (d *discard) WriteHeader(code int) {
	if d.code == 0 {
		d.code = code
	}
}

func (d *discard) Write(b []byte) (int, error) {
	d.WriteHeader(http.StatusOK)
	d.sent += int64(len(b))
	return len(b), nil
}

// stored puts blob on the disk as owner's upload, owner registered, and returns its hash.
func stored(t *testing.T, s *Server, owner string, blob []byte) string {
	t.Helper()
	sum := sha256.Sum256(blob)
	sha := hex.EncodeToString(sum[:])
	ctx := context.Background()
	if err := s.st.Register(ctx, owner); err != nil {
		t.Fatal(err)
	}
	if err := s.st.Upload(ctx, sha, owner, owner, int64(len(blob)), false); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(s.path(sha)), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.path(sha), blob, 0o600); err != nil {
		t.Fatal(err)
	}
	return sha
}

// fetcher asks mux for a blob from an address as Caddy passes it, and keeps what is sent.
func fetcher(mux *http.ServeMux) func(method, sha, from string) *discard {
	return func(method, sha, from string) *discard {
		req := httptest.NewRequest(method, "/"+sha, nil)
		req.Header.Set("X-Forwarded-For", from)
		d := &discard{header: http.Header{}}
		mux.ServeHTTP(d, req)
		return d
	}
}

// mirror is the one address a public mirror fetches every user's texts from (contract 4.2, BUD-04).
const mirror = "203.0.113.50"

// Anyone may fetch any blob by its hash, and one client asking for an 8 MB blob of its own again and again took 8 MB a
// request of the link every user's uploads and every mirror's copies share. Counted by the address that asks, 1 GB an
// hour each, the count fell on the one address a mirror fetches every user's texts from: an attacker who had the
// mirror copy an 8 MB blob of their own 128 times (BUD-04, as often as the mirror takes the request) left every other
// user's next text refused to it for the rest of the hour, and everyone behind one carrier address shared one
// allowance. Now each blob is sent at most MaxBlobSends times an hour, a GET or a HEAD each, whoever asks: past it
// that blob alone gets 429 rate with Retry-After, from every address, and every other blob is sent as before.
func TestABlobIsSentAtMostMaxBlobSendsAnHour(t *testing.T) {
	s, _, clock, mux := testServer(t)
	get := fetcher(mux)
	big := stored(t, s, "attacker", make([]byte, MaxBlob))
	text := stored(t, s, "user", []byte("a user's new text, which the mirror copies"))
	for i := 0; i < MaxBlobSends; i++ {
		if d := get("GET", big, mirror); d.code != http.StatusOK || d.sent != MaxBlob {
			t.Fatalf("send %d: %d, %d bytes", i, d.code, d.sent)
		}
	}
	d := get("GET", big, mirror)
	if wait, _ := strconv.Atoi(d.header.Get("Retry-After")); d.code != http.StatusTooManyRequests || d.header.Get("X-Reason") != "rate" || wait < 1 || wait > 3600 || d.sent > 100 {
		t.Fatalf("past the blob's sends: %d %q, Retry-After %q, %d bytes", d.code, d.header.Get("X-Reason"), d.header.Get("Retry-After"), d.sent)
	}
	// no number of addresses has it sent more
	for _, from := range []string{"198.51.100.10", "2001:db8:1::1", "2001:db8:2::1"} {
		if d := get("GET", big, from); d.code != http.StatusTooManyRequests {
			t.Fatalf("from %s: %d", from, d.code)
		}
	}
	// and the mirror is sent every other user's text as before
	if d := get("GET", text, mirror); d.code != http.StatusOK || d.sent != int64(len("a user's new text, which the mirror copies")) {
		t.Fatalf("the mirror's copy of another user's text: %d, %d bytes", d.code, d.sent)
	}
	// a HEAD counts as one of a blob's sends, since each asks the database whether the blob is held
	for i := 1; i < MaxBlobSends; i++ {
		if d := get("HEAD", text, "198.51.100.11"); d.code != http.StatusOK {
			t.Fatalf("HEAD %d: %d", i, d.code)
		}
	}
	if d := get("GET", text, mirror); d.code != http.StatusTooManyRequests {
		t.Fatalf("past the text's sends, HEADs among them: %d", d.code)
	}
	*clock = clock.Add(time.Hour)
	if d := get("GET", big, mirror); d.code != http.StatusOK {
		t.Fatalf("an hour later: %d", d.code)
	}
}

// A GET or HEAD for a blob whose file isn't on the disk is answered 404 from the disk, without the database or any
// count: those cost nothing that a flood of them could use up, and a request for a blob that is there is never
// refused for them.
func TestABlobNotOnTheDiskAsksNothingOfTheDatabase(t *testing.T) {
	s, st, _, mux := testServer(t)
	get := fetcher(mux)
	text := stored(t, s, "user", []byte("a text on the disk"))
	if d := get("GET", text, mirror); d.code != http.StatusOK {
		t.Fatalf("GET %d", d.code)
	}
	st.Close() // the database can no longer be asked anything
	for _, sha := range []string{strings.Repeat("0", 64), strings.Repeat("f", 64)} {
		for _, method := range []string{"GET", "HEAD"} {
			if d := get(method, sha, mirror); d.code != http.StatusNotFound || d.header.Get("X-Reason") != "not_found" {
				t.Fatalf("%s of a blob not on the disk: %d %q", method, d.code, d.header.Get("X-Reason"))
			}
		}
	}
	// a blob on the disk is a 500 when the database can't say whether it is held, never a 404 (contract 4.4)
	if d := get("GET", text, mirror); d.code != http.StatusInternalServerError {
		t.Fatalf("a blob on the disk, with the database gone: %d, want 500", d.code)
	}
}
