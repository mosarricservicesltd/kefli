package auth_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/auth"
)

// The NIP-98 fixture every platform shares (contract section 9, shared/fixtures/protocol/nip98.json): the header the
// phone's httpAuth makes passes the API's own check, for its URL, method and body, at its own time.
func TestNIP98Fixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "shared", "fixtures", "protocol", "nip98.json"))
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Pubkey string `json:"pubkey"`
		URL    string `json:"url"`
		Method string `json:"method"`
		Body   string `json:"body"`
		Header string `json:"header"`
		Event  struct {
			ID        string `json:"id"`
			CreatedAt int64  `json:"created_at"`
		} `json:"event"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	at := time.Unix(f.Event.CreatedAt, 0)
	ev, err := auth.HTTP(f.Header, f.URL, f.Method, []byte(f.Body), at)
	if err != nil {
		t.Fatalf("the fixture's header is refused: %v", err)
	}
	if ev.PubKey != f.Pubkey || ev.ID != f.Event.ID {
		t.Fatalf("read as %s by %s, want %s by %s", ev.ID, ev.PubKey, f.Event.ID, f.Pubkey)
	}
	// and the same check still refuses what the header doesn't cover
	for name, c := range map[string]struct {
		url, method, body string
		want              auth.Failure
	}{
		"another body":   {f.URL, f.Method, f.Body + " ", auth.Payload},
		"another URL":    {f.URL + "/x", f.Method, f.Body, auth.URL},
		"another method": {f.URL, "DELETE", f.Body, auth.Method},
	} {
		if _, err := auth.HTTP(f.Header, c.url, c.method, []byte(c.body), at); !errors.Is(err, c.want) {
			t.Errorf("%s: got %v, want %v", name, err, c.want)
		}
	}
	if _, err := auth.HTTP(f.Header, f.URL, f.Method, []byte(f.Body), at.Add(2*time.Minute)); !errors.Is(err, auth.Stale) {
		t.Errorf("two minutes on: got %v, want %v", err, auth.Stale)
	}
}
