package httpapi_test

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/richardminton-glitch/Kefli/server/api/internal/guard"
	"github.com/richardminton-glitch/Kefli/server/api/internal/httpapi"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// failing is a request body whose every read fails with err.
type failing struct{ err error }

func (b failing) Read([]byte) (int, error) { return 0, b.err }

// A body that fell behind the guard's pace (internal/guard) would have been answered 413 too_large, which the phone
// takes for a refusal and never sends again, a registration included. It is answered 503 timeout with Retry-After,
// which the phone sends again later as it does any 5xx; a body that broke off is still 413.
func TestABodyBehindThePaceIsAskedForAgain(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "k.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	mux := http.NewServeMux()
	httpapi.New(httpapi.Config{Base: "http://api", Defaults: []byte(`{"v":1}`)}, st, slog.New(slog.NewTextHandler(io.Discard, nil))).Routes(mux)
	for _, c := range []struct {
		err    error
		status int
		reason string
	}{
		{guard.ErrSlow, http.StatusServiceUnavailable, "timeout"},
		{io.ErrUnexpectedEOF, http.StatusRequestEntityTooLarge, "too_large"},
	} {
		req := httptest.NewRequest("POST", "/register", failing{c.err})
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		var body map[string]any
		_ = json.NewDecoder(rec.Body).Decode(&body)
		if rec.Code != c.status || body["error"] != c.reason || body["v"] != float64(1) {
			t.Fatalf("a body that failed with %v: %d %v", c.err, rec.Code, body)
		}
		if retry := rec.Header().Get("Retry-After"); (c.status == http.StatusServiceUnavailable) != (retry == "10") {
			t.Fatalf("a body that failed with %v: Retry-After %q", c.err, retry)
		}
	}
}
