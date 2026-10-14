// Package auth checks the two signed authorisations keflid takes: NIP-98 on the API (contract 6) and Blossom's kind
// 24242 on the blob store (BUD-01, BUD-02). Both are a nostr event, base64 in "Authorization: Nostr <…>".
package auth

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strconv"
	"strings"
	"time"

	"github.com/nbd-wtf/go-nostr"
)

// Window is how far created_at may be from the server's clock (contract 6: 60 seconds).
const Window = 60 * time.Second

// Failure is why an authorisation was refused, one word for the 401 body (backend spec 3.3).
type Failure string

func (f Failure) Error() string { return string(f) }

const (
	Missing  Failure = "missing"
	Unread   Failure = "unreadable"
	Kind     Failure = "kind"
	Sig      Failure = "signature"
	Stale    Failure = "stale"
	URL      Failure = "url"
	Method   Failure = "method"
	Payload  Failure = "payload"
	Verb     Failure = "verb"
	Hash     Failure = "hash"
	Expired  Failure = "expired"
	Replayed Failure = "replayed"
)

// Event reads and verifies the event in an Authorization header: it parses, its id is its hash and its signature holds.
func Event(header string) (*nostr.Event, error) {
	b64, ok := strings.CutPrefix(header, "Nostr ")
	if !ok || b64 == "" {
		return nil, Missing
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(b64))
	if err != nil {
		return nil, Unread
	}
	var ev nostr.Event
	if err := json.Unmarshal(raw, &ev); err != nil {
		return nil, Unread
	}
	if ev.GetID() != ev.ID {
		return nil, Sig
	}
	if ok, err := ev.CheckSignature(); err != nil || !ok {
		return nil, Sig
	}
	return &ev, nil
}

func tag(ev *nostr.Event, name string) string {
	if t := ev.Tags.GetFirst([]string{name}); t != nil && len(*t) > 1 {
		return (*t)[1]
	}
	return ""
}

func fresh(ev *nostr.Event, now time.Time) bool {
	d := now.Sub(ev.CreatedAt.Time())
	return d <= Window && d >= -Window
}

// HTTP checks NIP-98 for one request (contract 6): kind 27235, u is the exact URL, method matches, created_at within 60
// seconds, and for POST, PUT and DELETE a payload tag with the body's sha256 (the empty body's too).
func HTTP(header, url, method string, body []byte, now time.Time) (*nostr.Event, error) {
	ev, err := Event(header)
	if err != nil {
		return nil, err
	}
	switch {
	case ev.Kind != 27235:
		return nil, Kind
	case !fresh(ev, now):
		return nil, Stale
	case tag(ev, "u") != url:
		return nil, URL
	case !strings.EqualFold(tag(ev, "method"), method):
		return nil, Method
	}
	if method != "GET" && method != "HEAD" {
		sum := sha256.Sum256(body)
		if tag(ev, "payload") != hex.EncodeToString(sum[:]) {
			return nil, Payload
		}
	}
	return ev, nil
}

// Blossom checks a kind 24242 authorisation for a verb (BUD-01): t is the verb, created_at isn't in the future, the
// expiration is, and for an upload or delete an x tag names the blob.
func Blossom(header, verb, sha string, now time.Time) (*nostr.Event, error) {
	ev, err := Event(header)
	if err != nil {
		return nil, err
	}
	exp, _ := strconv.ParseInt(tag(ev, "expiration"), 10, 64)
	switch {
	case ev.Kind != 24242:
		return nil, Kind
	case tag(ev, "t") != verb:
		return nil, Verb
	case ev.CreatedAt.Time().After(now.Add(Window)):
		return nil, Stale
	case exp <= now.Unix():
		return nil, Expired
	case sha != "" && !hasX(ev, sha):
		return nil, Hash
	}
	return ev, nil
}

func hasX(ev *nostr.Event, sha string) bool {
	for _, t := range ev.Tags {
		if len(t) > 1 && t[0] == "x" && t[1] == sha {
			return true
		}
	}
	return false
}

// IsHex64 is a 32-byte key or hash in lower-case hex.
func IsHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil && strings.ToLower(s) == s
}

// DevicesPath is the API path a device proof and a release are made for (contract 4.4, 4.8, 6).
const DevicesPath = "/devices"

// Statement checks a signed statement as POST /devices carries it, its time and signature only (contract 6): sig must
// be pubkey's BIP-340 signature over the kind 27235 event with empty content, that created_at and these tags, the
// same event the phone and the extension rebuild. It returns the event's id, for the replay check.
func Statement(pubkey string, createdAt int64, tags nostr.Tags, sig string) (string, error) {
	if !IsHex64(pubkey) || len(sig) != 128 || strings.ToLower(sig) != sig {
		return "", Sig
	}
	if _, err := hex.DecodeString(sig); err != nil {
		return "", Sig
	}
	ev := nostr.Event{PubKey: pubkey, CreatedAt: nostr.Timestamp(createdAt), Kind: 27235, Tags: tags, Content: "", Sig: sig}
	ev.ID = ev.GetID()
	if ok, err := ev.CheckSignature(); err != nil || !ok {
		return "", Sig
	}
	return ev.ID, nil
}

// DeviceProof checks a device's proof from its pairing offer (contract 4.4): the device key signed POST base/devices
// with the offer's nonce at createdAt.
func DeviceProof(base, device, nonce string, createdAt int64, sig string) (string, error) {
	if nonce == "" {
		return "", Sig
	}
	return Statement(device, createdAt, nostr.Tags{{"u", base + DevicesPath}, {"method", "POST"}, {"nonce", nonce}}, sig)
}

// Release checks a library's consent to hand a device it holds to another (contract 4.8 step 4): holder signed POST
// base/devices naming the device and to at createdAt.
func Release(base, holder, device, to string, createdAt int64, sig string) (string, error) {
	return Statement(holder, createdAt, nostr.Tags{{"u", base + DevicesPath}, {"method", "POST"}, {"device", device}, {"to", to}}, sig)
}
