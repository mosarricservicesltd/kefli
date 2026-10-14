package auth_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
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

// The pair-offer fixture's POST /devices bodies (contract 4.4, 4.8, 6, shared/fixtures/protocol/pair-offer.json): the
// device proof the extension signs and the release a move's source signs pass the API's checks, for exactly what they
// name.
func TestPairOfferFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "shared", "fixtures", "protocol", "pair-offer.json"))
	if err != nil {
		t.Fatal(err)
	}
	type stmt struct {
		Pubkey    string `json:"pubkey"`
		Nonce     string `json:"nonce"`
		CreatedAt int64  `json:"created_at"`
		Sig       string `json:"sig"`
	}
	var f struct {
		API  string `json:"api"`
		Post struct {
			Device string `json:"device_pubkey"`
			Proof  stmt   `json:"proof"`
		} `json:"post"`
		Move struct {
			Source string `json:"source_pubkey"`
			Target string `json:"target_pubkey"`
			Body   struct {
				Device  string `json:"device_pubkey"`
				Release stmt   `json:"release"`
			} `json:"body"`
		} `json:"move_post"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	p, r, m := f.Post.Proof, f.Move.Body.Release, f.Move
	if _, err := auth.DeviceProof(f.API, f.Post.Device, p.Nonce, p.CreatedAt, p.Sig); err != nil {
		t.Fatalf("the fixture's proof is refused: %v", err)
	}
	if r.Pubkey != m.Source {
		t.Fatalf("the release is %s's, want the source's", r.Pubkey)
	}
	if _, err := auth.Release(f.API, r.Pubkey, m.Body.Device, m.Target, r.CreatedAt, r.Sig); err != nil {
		t.Fatalf("the fixture's release is refused: %v", err)
	}
	proof := func(api, nonce string, at int64, sig string) error {
		_, err := auth.DeviceProof(api, f.Post.Device, nonce, at, sig)
		return err
	}
	release := func(holder, to, sig string) error {
		_, err := auth.Release(f.API, holder, m.Body.Device, to, r.CreatedAt, sig)
		return err
	}
	for name, err := range map[string]error{
		"proof, another nonce":    proof(f.API, p.Nonce+"0", p.CreatedAt, p.Sig),
		"proof, another time":     proof(f.API, p.Nonce, p.CreatedAt+1, p.Sig),
		"proof, another API":      proof(f.API+"x", p.Nonce, p.CreatedAt, p.Sig),
		"proof, upper-case sig":   proof(f.API, p.Nonce, p.CreatedAt, strings.ToUpper(p.Sig)),
		"release, another target": release(r.Pubkey, m.Source, r.Sig),
		"release, another holder": release(m.Target, m.Target, r.Sig),
		"proof as a release":      release(f.Post.Device, m.Target, p.Sig),
	} {
		if !errors.Is(err, auth.Sig) {
			t.Errorf("%s: got %v, want %v", name, err, auth.Sig)
		}
	}
}
