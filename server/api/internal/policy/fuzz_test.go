package policy

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/limit"
)

// Whatever strfry sends, a line is answered once, or skipped when it isn't JSON, and nothing panics
// (go test -fuzz=FuzzServe). An answer names the event it is for, unless the event couldn't be read.
func FuzzServe(f *testing.F) {
	for _, seed := range []string{
		`{"type":"new","event":{"id":"e","pubkey":"aa","kind":30078,"tags":[]},"sourceType":"IP4","sourceInfo":"1.2.3.4"}`,
		`{"type":"new","event":{"id":"w","pubkey":"ee","kind":1059,"tags":[["p","aa"],["p"]]},"sourceType":"IP6","sourceInfo":"2001:db8::1","authed":"dd"}`,
		`{"type":"new","event":{"id":"d","pubkey":"ee","kind":5,"tags":[["e"],["e","w1"],[]]},"sourceType":"IP4","sourceInfo":""}`,
		`{"type":"new","event":{"id":"x","kind":99999999999999999999}}`,
		`{"type":"new","event":"nonsense"}`, `{"event":null}`, `[]`, `{`,
	} {
		f.Add(seed)
	}
	wraps, err := OpenWraps(filepath.Join(f.TempDir(), "wraps.db"))
	if err != nil {
		f.Fatal(err)
	}
	now := time.Unix(1_791_600_000, 0)
	f.Fuzz(func(t *testing.T, line string) {
		if strings.ContainsAny(line, "\n\r") {
			return
		}
		fk := &fake{users: map[string]bool{"aa": true}, devices: map[string]string{"dd": "aa"}, wraps: map[string]Wrap{"w1": {ID: "w1", Author: "ee", P: "aa"}}}
		p := New(fk, func() time.Time { return now })
		var out bytes.Buffer
		if err := Serve(strings.NewReader(line+"\n"), &out, p, wraps, func([]string) {}); err != nil && !strings.Contains(err.Error(), "token too long") {
			t.Fatal(err)
		}
		if out.Len() == 0 {
			return
		}
		var o Output
		if err := json.Unmarshal(out.Bytes(), &o); err != nil || (o.Action != "accept" && o.Action != "reject") {
			t.Fatalf("answer %q to %q", out.String(), line)
		}
	})
}

// Any address string is counted as something; nothing panics.
func FuzzAddress(f *testing.F) {
	for _, seed := range []string{"", "1.2.3.4", "::ffff:1.2.3.4", "fe80::1%eth0", "2001:db8::1", "[::1]:80", "not an address", "1.2.3.4:5"} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, addr string) {
		_ = limit.Addr(addr, 64)
		_ = limit.Addr(addr, 56)
		_ = limit.Block(addr)
	})
}
