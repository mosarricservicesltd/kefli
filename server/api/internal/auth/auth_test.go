package auth_test

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strconv"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/richardminton-glitch/Kefli/server/api/internal/auth"
)

var now = time.Unix(1_791_600_000, 0)

func signed(t *testing.T, kind int, tags nostr.Tags, at time.Time, tamper bool) string {
	t.Helper()
	sk := nostr.GeneratePrivateKey()
	ev := nostr.Event{Kind: kind, CreatedAt: nostr.Timestamp(at.Unix()), Tags: tags}
	if err := ev.Sign(sk); err != nil {
		t.Fatal(err)
	}
	if tamper {
		ev.Content = "changed after signing"
	}
	raw, _ := json.Marshal(ev)
	return "Nostr " + base64.StdEncoding.EncodeToString(raw)
}

func sum(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

func TestHTTP(t *testing.T) {
	body := []byte(`{"v":1}`)
	good := nostr.Tags{{"u", "https://api.example/register"}, {"method", "POST"}, {"payload", sum(body)}}
	cases := map[string]struct {
		header string
		want   error
	}{
		"good":        {signed(t, 27235, good, now, false), nil},
		"missing":     {"", auth.Missing},
		"not base64":  {"Nostr ***", auth.Unread},
		"not json":    {"Nostr " + base64.StdEncoding.EncodeToString([]byte("x")), auth.Unread},
		"tampered":    {signed(t, 27235, good, now, true), auth.Sig},
		"wrong kind":  {signed(t, 1, good, now, false), auth.Kind},
		"stale":       {signed(t, 27235, good, now.Add(-2*time.Minute), false), auth.Stale},
		"future":      {signed(t, 27235, good, now.Add(2*time.Minute), false), auth.Stale},
		"wrong url":   {signed(t, 27235, nostr.Tags{{"u", "https://api.example/other"}, {"method", "POST"}, {"payload", sum(body)}}, now, false), auth.URL},
		"wrong verb":  {signed(t, 27235, nostr.Tags{{"u", "https://api.example/register"}, {"method", "GET"}, {"payload", sum(body)}}, now, false), auth.Method},
		"no payload":  {signed(t, 27235, nostr.Tags{{"u", "https://api.example/register"}, {"method", "POST"}}, now, false), auth.Payload},
	}
	for name, c := range cases {
		_, err := auth.HTTP(c.header, "https://api.example/register", "POST", body, now)
		if !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", name, err, c.want)
		}
	}
	// a GET carries no payload tag
	get := signed(t, 27235, nostr.Tags{{"u", "https://api.example/x"}, {"method", "GET"}}, now, false)
	if _, err := auth.HTTP(get, "https://api.example/x", "GET", nil, now); err != nil {
		t.Errorf("GET: %v", err)
	}
}

func TestBlossom(t *testing.T) {
	sha := sum([]byte("blob"))
	exp := strconv.FormatInt(now.Add(time.Hour).Unix(), 10)
	cases := map[string]struct {
		header string
		want   error
	}{
		"good":       {signed(t, 24242, nostr.Tags{{"t", "upload"}, {"x", sha}, {"expiration", exp}}, now, false), nil},
		"wrong kind": {signed(t, 27235, nostr.Tags{{"t", "upload"}, {"x", sha}, {"expiration", exp}}, now, false), auth.Kind},
		"wrong verb": {signed(t, 24242, nostr.Tags{{"t", "delete"}, {"x", sha}, {"expiration", exp}}, now, false), auth.Verb},
		"future":     {signed(t, 24242, nostr.Tags{{"t", "upload"}, {"x", sha}, {"expiration", exp}}, now.Add(time.Hour), false), auth.Stale},
		"expired":    {signed(t, 24242, nostr.Tags{{"t", "upload"}, {"x", sha}, {"expiration", strconv.FormatInt(now.Unix(), 10)}}, now, false), auth.Expired},
		"no expiry":  {signed(t, 24242, nostr.Tags{{"t", "upload"}, {"x", sha}}, now, false), auth.Expired},
		"other blob": {signed(t, 24242, nostr.Tags{{"t", "upload"}, {"x", sum([]byte("other"))}, {"expiration", exp}}, now, false), auth.Hash},
		"missing":    {"Nostr ", auth.Missing},
	}
	for name, c := range cases {
		_, err := auth.Blossom(c.header, "upload", sha, now)
		if !errors.Is(err, c.want) {
			t.Errorf("%s: %v, want %v", name, err, c.want)
		}
	}
}

func TestIsHex64(t *testing.T) {
	for s, want := range map[string]bool{sum(nil): true, "AB" + sum(nil)[2:]: false, "zz" + sum(nil)[2:]: false, "ab": false} {
		if auth.IsHex64(s) != want {
			t.Errorf("%q", s)
		}
	}
}
