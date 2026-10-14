package auth

import (
	"encoding/base64"
	"testing"
	"time"
)

// Any Authorization header, however malformed, is refused or read; nothing panics (go test -fuzz=FuzzAuthorization).
func FuzzAuthorization(f *testing.F) {
	for _, seed := range []string{
		"", "Nostr ", "Nostr !!!", "Bearer x", "Nostr " + base64.StdEncoding.EncodeToString([]byte(`{}`)),
		"Nostr " + base64.StdEncoding.EncodeToString([]byte(`{"id":"","pubkey":"","created_at":1e300,"kind":-1,"tags":[[]],"content":"","sig":""}`)),
		"Nostr " + base64.StdEncoding.EncodeToString([]byte(`{"kind":27235,"tags":[["u"],["method"],["payload"],[]]}`)),
		"Nostr " + base64.StdEncoding.EncodeToString([]byte(`{"kind":24242,"tags":[["t","upload"],["expiration","99999999999999999999"],["x"]]}`)),
	} {
		f.Add(seed)
	}
	now := time.Unix(1_791_600_000, 0)
	f.Fuzz(func(t *testing.T, header string) {
		if ev, err := HTTP(header, "https://api.example/register", "POST", []byte(`{"v":1}`), now); err == nil && ev == nil {
			t.Fatal("no error and no event")
		}
		_, _ = Blossom(header, "upload", "", now)
		_, _ = Blossom(header, "delete", "aa", now)
	})
}

// Any statement in a POST /devices body is refused or checked; nothing panics.
func FuzzStatement(f *testing.F) {
	f.Add("aa", int64(0), "", "")
	f.Add(string(make([]byte, 64)), int64(-1<<63), "n", string(make([]byte, 128)))
	f.Fuzz(func(t *testing.T, pubkey string, createdAt int64, nonce, sig string) {
		_, _ = DeviceProof("https://api.example", pubkey, nonce, createdAt, sig)
		_, _ = Release("https://api.example", pubkey, pubkey, nonce, createdAt, sig)
	})
}
