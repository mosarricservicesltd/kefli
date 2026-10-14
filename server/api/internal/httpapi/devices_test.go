package httpapi_test

import (
	"crypto/rand"
	"encoding/hex"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/richardminton-glitch/Kefli/server/api/internal/httpapi"
)

// statement signs the kind 27235 a device proof or a release is, and returns its time and signature as POST /devices
// carries them (contract 6).
func (e *env) statement(k key, tags nostr.Tags, at time.Time) map[string]any {
	ev := nostr.Event{Kind: 27235, CreatedAt: nostr.Timestamp(at.Unix()), Tags: tags}
	if err := ev.Sign(k.sk); err != nil {
		e.t.Fatal(err)
	}
	return map[string]any{"created_at": at.Unix(), "sig": ev.Sig}
}

// proof is the device's proof from its pairing offer over nonce, made at at (contract 4.4).
func (e *env) proof(device key, nonce string, at time.Time) map[string]any {
	p := e.statement(device, nostr.Tags{{"u", e.api.URL + "/devices"}, {"method", "POST"}, {"nonce", nonce}}, at)
	p["nonce"] = nonce
	return p
}

// release is holder's consent to hand device to to, made at at (contract 4.8 step 4).
func (e *env) release(holder key, device, to string, at time.Time) map[string]any {
	r := e.statement(holder, nostr.Tags{{"u", e.api.URL + "/devices"}, {"method", "POST"}, {"device", device}, {"to", to}}, at)
	r["pubkey"] = holder.pk
	return r
}

func nonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// addDevice connects device to user as a phone does after scanning a fresh offer.
func (e *env) addDevice(user, device key) int {
	s, _ := e.call(user, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": device.pk, "proof": e.proof(device, nonce(), e.clock)})
	return s
}

func (e *env) holder(device key) string {
	u, _, err := e.st.DeviceHolder(e.t.Context(), device.pk)
	if err != nil {
		e.t.Fatal(err)
	}
	return u
}

func (e *env) registered(keys ...key) {
	for _, k := range keys {
		if s, b := e.call(k, "POST", "/register", map[string]any{"v": 1}); s != 200 {
			e.t.Fatalf("register %d %v", s, b)
		}
	}
}

func wantError(t *testing.T, s int, b map[string]any, status int, word string) {
	t.Helper()
	if s != status || b["error"] != word {
		t.Fatalf("got %d %v, want %d %q", s, b, status, word)
	}
}

// F44: POST /devices takes a device key only with the device's own proof from the offer, used once, or a release from
// the library that holds it.
func TestDeviceProof(t *testing.T) {
	e := newEnv(t)
	user, device, other := newKey(), newKey(), newKey()
	e.registered(user, other)
	n := nonce()
	body := func(p map[string]any) map[string]any {
		return map[string]any{"v": 1, "device_pubkey": device.pk, "proof": p}
	}

	// an older phone sends none: refused, and nothing is authorised
	s, b := e.call(user, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": device.pk, "label": "Chrome"})
	wantError(t, s, b, 400, "proof: missing")
	// a proof signed by any other key than the device's: the caller's own, or another's
	for name, k := range map[string]key{"the caller's": user, "another key's": other} {
		s, b = e.call(user, "POST", "/devices", body(e.proof(k, n, e.clock)))
		if s != 403 || b["error"] != "proof: signature" {
			t.Fatalf("%s: %d %v", name, s, b)
		}
	}
	// the device's proof, but over another nonce than the one sent, or for another operator
	p := e.proof(device, n, e.clock)
	p["nonce"] = nonce()
	s, b = e.call(user, "POST", "/devices", body(p))
	wantError(t, s, b, 403, "proof: signature")
	elsewhere := e.statement(device, nostr.Tags{{"u", "https://api.elsewhere.example/devices"}, {"method", "POST"}, {"nonce", n}}, e.clock)
	elsewhere["nonce"] = n
	s, b = e.call(user, "POST", "/devices", body(elsewhere))
	wantError(t, s, b, 403, "proof: signature")
	// a proof older than an offer's life and its skew, or from the future
	s, b = e.call(user, "POST", "/devices", body(e.proof(device, n, e.clock.Add(-httpapi.ProofLife-time.Second))))
	wantError(t, s, b, 403, "proof: stale")
	s, b = e.call(user, "POST", "/devices", body(e.proof(device, n, e.clock.Add(2*time.Minute))))
	wantError(t, s, b, 403, "proof: stale")
	if e.holder(device) != "" {
		t.Fatal("a refused proof authorised the device")
	}

	// the good one, made four minutes ago when the offer was
	good := body(e.proof(device, n, e.clock.Add(-4*time.Minute)))
	s, b = e.call(user, "POST", "/devices", good)
	expect(t, s, 200, b)
	if u, ok, _ := e.st.DeviceUser(t.Context(), device.pk); !ok || u != user.pk {
		t.Fatal("device not authorised")
	}
	// the same request again, as after a lost answer: nothing changes
	e.clock = e.clock.Add(time.Second)
	s, b = e.call(user, "POST", "/devices", good)
	expect(t, s, 200, b)
	// replayed by someone else who saw the offer: refused, and the device stays the user's
	s, b = e.call(other, "POST", "/devices", good)
	wantError(t, s, b, 403, "proof: replayed")
	if e.holder(device) != user.pk {
		t.Fatal("a replayed proof moved the device")
	}
	// nor can it bring the device back once the user has let it go
	s, b = e.call(user, "DELETE", "/devices/"+device.pk, nil)
	expect(t, s, 200, b)
	e.clock = e.clock.Add(time.Second)
	for _, k := range []key{other, user} {
		s, b = e.call(k, "POST", "/devices", good)
		wantError(t, s, b, 403, "proof: replayed")
	}
}

// F44 (a): a deleted user's key can't be named as someone's device to take it off the gone list.
func TestDeviceProofKeepsTheGoneGone(t *testing.T) {
	e := newEnv(t)
	gone, attacker := newKey(), newKey()
	e.registered(gone, attacker)
	s, b := e.call(gone, "DELETE", "/account", nil)
	expect(t, s, 200, b)
	for name, p := range map[string]map[string]any{
		"no proof":             nil,
		"the attacker's own":   e.proof(attacker, nonce(), e.clock),
		"a release of its own": nil,
	} {
		body := map[string]any{"v": 1, "device_pubkey": gone.pk}
		if p != nil {
			body["proof"] = p
		}
		if name == "a release of its own" {
			body["release"] = e.release(attacker, gone.pk, attacker.pk, e.clock)
		}
		if s, b := e.call(attacker, "POST", "/devices", body); s == 200 {
			t.Fatalf("%s: %d %v", name, s, b)
		}
	}
	if g, _ := e.st.Gone(t.Context(), 0); len(g) != 1 || g[0] != gone.pk {
		t.Fatalf("gone %v: the deleted key must stay listed", g)
	}
}

// F44 (b): another user can't take over a browser, delete its inbox blobs or cut it off.
func TestDeviceCannotBeTakenOver(t *testing.T) {
	e := newEnv(t)
	owner, device, thief := newKey(), newKey(), newKey()
	e.registered(owner, thief)
	expect(t, e.addDevice(owner, device), 200, nil)
	inbox := []byte("a browser save not yet drained")
	if s, b := e.upload(device, inbox); s != 200 {
		t.Fatalf("upload %d %v", s, b)
	}
	tries := map[string]map[string]any{
		"no proof":               {"v": 1, "device_pubkey": device.pk},
		"a proof by the thief":   {"v": 1, "device_pubkey": device.pk, "proof": e.proof(thief, nonce(), e.clock)},
		"a release by the thief": {"v": 1, "device_pubkey": device.pk, "release": e.release(thief, device.pk, thief.pk, e.clock)},
		"a release naming the owner": {"v": 1, "device_pubkey": device.pk, "release": func() map[string]any {
			r := e.release(thief, device.pk, thief.pk, e.clock)
			r["pubkey"] = owner.pk
			return r
		}()},
		"the owner's release to another": {"v": 1, "device_pubkey": device.pk, "release": e.release(owner, device.pk, newKey().pk, e.clock)},
	}
	for name, body := range tries {
		if s, b := e.call(thief, "POST", "/devices", body); s == 200 {
			t.Fatalf("%s: %d %v", name, s, b)
		}
	}
	e.clock = e.clock.Add(time.Second)
	s, b := e.call(thief, "POST", "/devices", tries["a release by the thief"])
	wantError(t, s, b, 403, "release: holder")
	if e.holder(device) != owner.pk {
		t.Fatal("the device moved")
	}
	s, b = e.call(thief, "DELETE", "/devices/"+device.pk, nil)
	expect(t, s, 404, b)
	if s, _ := e.fetch(hash(inbox)); s != 200 {
		t.Fatal("the owner's inbox blob went")
	}
	if s, b := e.upload(device, []byte("another save")); s != 200 {
		t.Fatalf("the owner's browser was cut off: %d %v", s, b)
	}
	s, b = e.call(owner, "DELETE", "/devices/"+device.pk, nil)
	expect(t, s, 200, b)
}

// A move (contract 4.8 step 4): T takes S's browser on S's release, once, and only T can use it.
func TestDeviceMoveTakesARelease(t *testing.T) {
	e := newEnv(t)
	S, T, device, other := newKey(), newKey(), newKey(), newKey()
	e.registered(S, T, other)
	expect(t, e.addDevice(S, device), 200, nil)
	before := []byte("sent while S held the browser")
	if s, b := e.upload(device, before); s != 200 {
		t.Fatalf("upload %d %v", s, b)
	}
	move := func(k key, rel map[string]any) (int, map[string]any) {
		return e.call(k, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": device.pk, "release": rel})
	}
	// a release older than a minute, or one S signed for another library
	s, b := move(T, e.release(S, device.pk, T.pk, e.clock.Add(-2*time.Minute)))
	wantError(t, s, b, 403, "release: stale")
	s, b = move(T, e.release(S, device.pk, other.pk, e.clock))
	wantError(t, s, b, 403, "release: signature")
	rel := e.release(S, device.pk, T.pk, e.clock)
	// someone else holding T's release can't use it
	s, b = move(other, rel)
	wantError(t, s, b, 403, "release: signature")
	s, b = move(T, rel)
	expect(t, s, 200, b)
	if u, ok, _ := e.st.DeviceUser(t.Context(), device.pk); !ok || u != T.pk {
		t.Fatalf("device is %q's, want T's", u)
	}
	// the move's retry after a lost answer changes nothing
	e.clock = e.clock.Add(time.Second)
	s, b = move(T, rel)
	expect(t, s, 200, b)
	// S no longer holds it, so S's release does nothing more
	s, b = e.call(other, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": device.pk, "release": e.release(S, device.pk, other.pk, e.clock)})
	wantError(t, s, b, 403, "release: holder")
	// T letting the browser go deletes only what counts against T: what it sent for S goes with S's account
	after := []byte("sent once T held the browser")
	if s, b := e.upload(device, after); s != 200 {
		t.Fatalf("upload %d %v", s, b)
	}
	s, b = e.call(T, "DELETE", "/devices/"+device.pk, nil)
	expect(t, s, 200, b)
	if s, _ := e.fetch(hash(after)); s != 404 {
		t.Fatal("T's inbox blob stayed")
	}
	if s, _ := e.fetch(hash(before)); s != 200 {
		t.Fatal("S's inbox blob went with T's disconnect")
	}
	s, b = e.call(S, "DELETE", "/account", nil)
	expect(t, s, 200, b)
	if s, _ := e.fetch(hash(before)); s != 404 {
		t.Fatal("S's inbox blob outlived S's account")
	}
}

// A library could authorise device keys without end, 60 a minute: each is a wrap recipient on the relay, and the write
// policy loads every one into memory every five seconds (probe plugindevices: a million devices, 470 MB and answers held
// up to five seconds at each reload). The phone's connected-browsers record holds about 42 browsers under the 16 KB
// ceiling, so MaxDevices a library is room enough; past it Connect shows Can't connect, and a move leaves the browser
// with its old library, as for any refusal.
func TestDevicesPerLibrary(t *testing.T) {
	e := newEnv(t)
	user, T := newKey(), newKey()
	e.registered(user, T)
	var first key
	for i := 0; i < httpapi.MaxDevices; i++ {
		e.clock = e.clock.Add(time.Second)
		d := newKey()
		if i == 0 {
			first = d
		}
		if s := e.addDevice(user, d); s != 200 {
			t.Fatalf("device %d: %d", i, s)
		}
	}
	e.clock = e.clock.Add(time.Second)
	extra := newKey()
	s, b := e.call(user, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": extra.pk, "proof": e.proof(extra, nonce(), e.clock)})
	wantError(t, s, b, 403, "devices: too_many")
	if e.holder(extra) != "" {
		t.Fatal("a device past the limit was authorised")
	}
	// one it holds already is still a 200, as after a lost answer
	e.clock = e.clock.Add(time.Second)
	s, b = e.call(user, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": first.pk, "proof": e.proof(first, nonce(), e.clock)})
	expect(t, s, 200, b)
	// a move into a full library is refused the same way, and the browser stays where it was
	expect(t, e.addDevice(T, extra), 200, nil)
	e.clock = e.clock.Add(time.Second)
	s, b = e.call(user, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": extra.pk, "release": e.release(T, extra.pk, user.pk, e.clock)})
	wantError(t, s, b, 403, "devices: too_many")
	if e.holder(extra) != T.pk {
		t.Fatal("the browser left its library")
	}
	// Disconnect makes room
	s, b = e.call(user, "DELETE", "/devices/"+first.pk, nil)
	expect(t, s, 200, b)
	e.clock = e.clock.Add(time.Second)
	s, b = e.call(user, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": extra.pk, "release": e.release(T, extra.pk, user.pk, e.clock)})
	expect(t, s, 200, b)
}

// A browser that shows a new code consents afresh: its proof connects it to whichever library uses it first.
func TestDeviceFreshProofConnectsAgain(t *testing.T) {
	e := newEnv(t)
	first, second, device := newKey(), newKey(), newKey()
	e.registered(first, second)
	expect(t, e.addDevice(first, device), 200, nil)
	e.clock = e.clock.Add(time.Hour)
	expect(t, e.addDevice(second, device), 200, nil)
	if e.holder(device) != second.pk {
		t.Fatal("a fresh offer's proof didn't connect the browser")
	}
}

// F44 (b): a browser its library holds already shows a new code (after Disconnect, or a Connect whose answer was
// lost): the phone's new proof is used up all the same, so anyone else who saw the code can't take the browser with
// it; and the holder's retry after the proof's life still gets 200.
func TestDeviceHeldProofIsUsedUp(t *testing.T) {
	e := newEnv(t)
	user, device, other := newKey(), newKey(), newKey()
	e.registered(user, other)
	expect(t, e.addDevice(user, device), 200, nil)
	again := map[string]any{"v": 1, "device_pubkey": device.pk, "proof": e.proof(device, nonce(), e.clock)}
	s, b := e.call(user, "POST", "/devices", again)
	expect(t, s, 200, b)
	e.clock = e.clock.Add(time.Second)
	s, b = e.call(other, "POST", "/devices", again)
	wantError(t, s, b, 403, "proof: replayed")
	if e.holder(device) != user.pk {
		t.Fatal("a proof the holder had sent moved the device")
	}
	e.clock = e.clock.Add(httpapi.ProofLife + time.Minute)
	s, b = e.call(user, "POST", "/devices", again)
	expect(t, s, 200, b)
	s, b = e.call(other, "POST", "/devices", again)
	wantError(t, s, b, 403, "proof: stale")
}
