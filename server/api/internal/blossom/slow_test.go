package blossom

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/richardminton-glitch/Kefli/server/api/internal/guard"
)

// slowBody is an upload's body that has fallen behind the guard's pace: every read fails with guard.ErrSlow.
type slowBody struct{}

func (slowBody) Read([]byte) (int, error) { return 0, guard.ErrSlow }

// An upload whose body fell behind the guard's pace (internal/guard) would have been answered 500 server and logged as
// a fault of the server's, a log a client sending slow bodies could fill. It is answered 503 timeout with Retry-After,
// which the phone and the extension send again later as they do any 5xx, logs nothing, and leaves no file behind.
func TestAnUploadBehindThePaceIsAskedForAgain(t *testing.T) {
	s, st, clock, mux := testServer(t)
	var logged bytes.Buffer
	s.log = slog.New(slog.NewTextHandler(&logged, nil))
	k := newSigner()
	if err := st.Register(context.Background(), k.pk); err != nil {
		t.Fatal(err)
	}
	sha := hashOf([]byte("a text whose body never arrives"))
	req := httptest.NewRequest("PUT", "/upload", slowBody{})
	req.ContentLength = 100
	req.Header.Set("Authorization", k.auth(t, "upload", sha, *clock))
	req.Header.Set("X-SHA-256", sha)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusServiceUnavailable || rec.Header().Get("X-Reason") != "timeout" || rec.Header().Get("Retry-After") != "10" {
		t.Fatalf("%d %q, Retry-After %q", rec.Code, rec.Header().Get("X-Reason"), rec.Header().Get("Retry-After"))
	}
	if strings.Contains(logged.String(), "level=ERROR") {
		t.Fatalf("logged as the server's fault: %s", logged.String())
	}
	entries, _ := os.ReadDir(filepath.Join(s.Dir, sha[:2]))
	for _, e := range entries {
		t.Fatalf("left behind: %s", e.Name())
	}
}
