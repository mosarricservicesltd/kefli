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
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/limit"
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

// Anyone may fetch any blob by its hash, and the request limits count requests, not bytes: one client asking for an
// 8 MB blob of its own again and again was sent 8 MB a request, 6,000 requests a minute from one address, of the
// link every user's uploads and every mirror's copies share. Now one IPv4 address is sent MaxAddressDownload an hour
// and one IPv6 /48 MaxBlockDownload, counted whole, since a count kept an hour for each /64 a /48 sends from would
// let it fill keflid's memory; past them a GET gets 429 rate with Retry-After, and a HEAD, which sends no blob, still
// answers.
func TestDownloadsPerAddress(t *testing.T) {
	s, st, clock, mux := testServer(t)
	ctx := context.Background()
	blob := make([]byte, MaxBlob)
	sum := sha256.Sum256(blob)
	sha := hex.EncodeToString(sum[:])
	if err := st.Register(ctx, "user"); err != nil {
		t.Fatal(err)
	}
	if err := st.Upload(ctx, sha, "user", "user", MaxBlob, false); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(s.path(sha)), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(s.path(sha), blob, 0o600); err != nil {
		t.Fatal(err)
	}
	get := func(method, from string) *discard {
		req := httptest.NewRequest(method, "/"+sha, nil)
		req.Header.Set("X-Forwarded-For", from)
		d := &discard{header: http.Header{}}
		mux.ServeHTTP(d, req)
		return d
	}
	for i := 0; i < MaxAddressDownload/MaxBlob; i++ {
		if d := get("GET", "198.51.100.9"); d.code != http.StatusOK || d.sent != MaxBlob {
			t.Fatalf("download %d: %d, %d bytes", i, d.code, d.sent)
		}
	}
	d := get("GET", "198.51.100.9")
	if wait, _ := strconv.Atoi(d.header.Get("Retry-After")); d.code != http.StatusTooManyRequests || d.header.Get("X-Reason") != "rate" || wait < 1 || wait > 3600 || d.sent > 100 {
		t.Fatalf("past the address's downloads: %d %q, Retry-After %q, %d bytes", d.code, d.header.Get("X-Reason"), d.header.Get("Retry-After"), d.sent)
	}
	if d := get("HEAD", "198.51.100.9"); d.code != http.StatusOK {
		t.Fatalf("a HEAD past the downloads: %d", d.code)
	}
	if d := get("GET", "198.51.100.10"); d.code != http.StatusOK {
		t.Fatalf("another address: %d", d.code)
	}
	*clock = clock.Add(time.Hour)
	if d := get("GET", "198.51.100.9"); d.code != http.StatusOK {
		t.Fatalf("an hour later: %d", d.code)
	}
	// an IPv6 /48 is counted whole: one of its /64s is sent more than an IPv4 address may be, within the /48's
	for i := 0; i <= MaxAddressDownload/MaxBlob; i++ {
		if d := get("GET", "2001:db8:4:1::1"); d.code != http.StatusOK {
			t.Fatalf("an IPv6 /64's download %d: %d", i, d.code)
		}
	}
	// and a /48's /64s share MaxBlockDownload, here three blobs' worth
	s.blockDownloads = limit.New(3*MaxBlob, time.Hour, st.Now)
	for _, from := range []string{"2001:db8:5:1::1", "2001:db8:5:2::1", "2001:db8:5:3::1"} {
		if d := get("GET", from); d.code != http.StatusOK {
			t.Fatalf("%s: %d", from, d.code)
		}
	}
	if d := get("GET", "2001:db8:5:ff::1"); d.code != http.StatusTooManyRequests {
		t.Fatalf("past the block's downloads: %d", d.code)
	}
	if d := get("GET", "2001:db8:6::1"); d.code != http.StatusOK {
		t.Fatalf("the next /48: %d", d.code)
	}
}
