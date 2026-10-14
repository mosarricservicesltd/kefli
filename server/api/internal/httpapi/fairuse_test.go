package httpapi_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/richardminton-glitch/Kefli/server/api/internal/blossom"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// blossomAuth is a kind 24242 for one verb on one blob, signed by k now.
func (e *env) blossomAuth(k key, verb, sha string) string {
	return k.sign(e.t, 24242, nostr.Tags{{"t", verb}, {"x", sha}, {"expiration", strconv.FormatInt(e.clock.Add(time.Hour).Unix(), 10)}}, e.clock)
}

// put uploads body signed by k: the status, X-Reason and the body of the answer.
func (e *env) put(k key, body []byte) (int, string, map[string]any) {
	sha := hash(body)
	req, _ := http.NewRequest("PUT", e.blob.URL+"/upload", bytes.NewReader(body))
	req.Header.Set("Authorization", e.blossomAuth(k, "upload", sha))
	req.Header.Set("X-SHA-256", sha)
	req.Header.Set("Content-Type", "application/octet-stream")
	return e.answer(req)
}

// ask is BUD-06's preflight for an upload of size bytes: the status and X-Reason.
func (e *env) ask(k key, sha string, size int64) (int, string) {
	req, _ := http.NewRequest("HEAD", e.blob.URL+"/upload", nil)
	req.Header.Set("Authorization", e.blossomAuth(k, "upload", sha))
	req.Header.Set("X-SHA-256", sha)
	req.Header.Set("X-Content-Length", strconv.FormatInt(size, 10))
	s, reason, _ := e.answer(req)
	return s, reason
}

func (e *env) answer(req *http.Request) (int, string, map[string]any) {
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, res.Header.Get("X-Reason"), out
}

// figures reads a library's figures from the store.
func (e *env) figures(k key) store.Figures {
	f, ok, err := e.st.Figures(e.t.Context(), k.pk)
	if err != nil || !ok {
		e.t.Fatalf("figures: %v %v", ok, err)
	}
	return f
}

// seed records an upload of size bytes for k's library without sending one, as if made earlier: it counts against
// the quota and, unless the blob is already stored, against the day.
func (e *env) seed(k key, name string, size int64) {
	if err := e.st.Upload(e.t.Context(), hash([]byte(name)), k.pk, k.pk, size, false); err != nil {
		e.t.Fatal(err)
	}
}

// refusedFor checks a 413 for one of the two limits: the reason in X-Reason and the body, and the figures it carries.
func refusedFor(t *testing.T, s int, reason string, b map[string]any, want string, f store.Figures) {
	t.Helper()
	if s != 413 || reason != want || b["error"] != want || b["v"] != float64(1) {
		t.Fatalf("got %d %q %v, want 413 %s", s, reason, b, want)
	}
	for name, n := range map[string]int64{"quota": f.Quota, "used": f.Used, "daily": f.Daily, "today": f.Today} {
		if got, ok := b[name].(float64); !ok || int64(got) != n {
			t.Fatalf("%s is %v, want %d (%v)", name, b[name], n, b)
		}
	}
}

// Contract 5: an upload past the library's quota gets 413 quota, in X-Reason and the body, with the library's figures
// as GET /account gives them; BUD-06's preflight answers the same before the body is sent.
func TestQuotaRefusalCarriesTheFigures(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.registered(user)
	if err := e.st.AddOwner(t.Context(), hash([]byte("big")), user.pk, user.pk, store.DefaultQuota-10, false); err != nil {
		t.Fatal(err)
	}
	s, reason, b := e.put(user, []byte("eleven byte"))
	refusedFor(t, s, reason, b, "quota", store.Figures{Quota: store.DefaultQuota, Used: store.DefaultQuota - 10, Daily: store.DailyLimit})
	if s, reason := e.ask(user, hash([]byte("eleven byte")), 11); s != 413 || reason != "quota" {
		t.Fatalf("preflight %d %q", s, reason)
	}
	s, _, b = e.put(user, []byte("ten bytes!"))
	expect(t, s, 200, b)
	// any other refusal carries its reason alone
	s, reason, b = e.put(newKey(), []byte("from nobody"))
	if s != 401 || reason != "not_registered" || len(b) != 2 || b["error"] != "not_registered" {
		t.Fatalf("an unregistered upload: %d %q %v", s, reason, b)
	}
}

// Contract 5: a library's uploads may add at most DailyLimit to the disk in any 24 hours. A blob the server already
// stores, for this library or any other, adds nothing; deleting gives none of the day back; a day on, it takes uploads
// again.
func TestUploadsPastTheDay(t *testing.T) {
	e := newEnv(t)
	user, other := newKey(), newKey()
	e.registered(user, other)
	e.seed(user, "this morning's uploads", store.DailyLimit-10)
	s, _, b := e.put(user, []byte("ten bytes!"))
	expect(t, s, 200, b)
	s, reason, b := e.put(user, []byte("one more"))
	refusedFor(t, s, reason, b, "daily", store.Figures{Quota: store.DefaultQuota, Used: store.DailyLimit, Daily: store.DailyLimit, Today: store.DailyLimit})
	if s, reason := e.ask(user, hash([]byte("one more")), 8); s != 413 || reason != "daily" {
		t.Fatalf("preflight %d %q", s, reason)
	}
	// a blob another library has stored costs the day nothing, nor does one this library holds
	shared := []byte("stored by another library")
	s, _, b = e.put(other, shared)
	expect(t, s, 200, b)
	for _, blob := range [][]byte{shared, []byte("ten bytes!")} {
		s, _, b = e.put(user, blob)
		expect(t, s, 200, b)
	}
	if f := e.figures(user); f.Today != store.DailyLimit || f.Used != store.DailyLimit+int64(len(shared)) {
		t.Fatalf("figures %+v: a stored blob counts against the quota, never the day", f)
	}
	if s := e.remove(user, hash([]byte("ten bytes!"))); s != 200 {
		t.Fatalf("delete %d", s)
	}
	s, reason, b = e.put(user, []byte("one more"))
	if s != 413 || reason != "daily" {
		t.Fatalf("a delete gave the day back: %d %q %v", s, reason, b)
	}
	e.clock = e.clock.Add(store.Day)
	s, _, b = e.put(user, []byte("one more"))
	expect(t, s, 200, b)
}

// Contract 5: an upload past both limits is answered quota.
func TestQuotaAnswersAnUploadPastBoth(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.registered(user)
	e.seed(user, "today's", store.DailyLimit-5)
	if err := e.st.AddOwner(t.Context(), hash([]byte("older")), user.pk, user.pk, store.DefaultQuota-store.DailyLimit, false); err != nil {
		t.Fatal(err)
	}
	s, reason, b := e.put(user, []byte("ten bytes!"))
	refusedFor(t, s, reason, b, "quota", store.Figures{Quota: store.DefaultQuota, Used: store.DefaultQuota - 5, Daily: store.DailyLimit, Today: store.DailyLimit - 5})
}

// F2 and contract 5: the day is checked again at commit, one upload at a time, so uploads racing for the last of it
// can't together pass it.
func TestUploadsRacingForTheDay(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.registered(user)
	e.seed(user, "the day so far", store.DailyLimit-10)
	var wg sync.WaitGroup
	accepted := make(chan struct{}, 20)
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s, _, _ := e.put(user, []byte(fmt.Sprintf("blob %03d", i))); s == 200 {
				accepted <- struct{}{}
			}
		}()
	}
	wg.Wait()
	close(accepted)
	if n := len(accepted); n != 1 || len(e.files()) != 1 {
		t.Fatalf("%d of 20 eight-byte uploads accepted into ten bytes of the day, %d files", n, len(e.files()))
	}
	if f := e.figures(user); f.Today > store.DailyLimit {
		t.Fatalf("today %d past the daily limit", f.Today)
	}
}

type answered struct {
	status int
	reason string
	body   map[string]any
	err    error
}

// waiting starts an upload whose body is held back until the server has checked the upload and is reading its body
// (its temporary file is there). send then sends the body and returns the answer.
func (e *env) waiting(k key, body []byte) (send func() answered) {
	sha := hash(body)
	pr, pw := io.Pipe()
	req, _ := http.NewRequest("PUT", e.blob.URL+"/upload", pr)
	req.ContentLength = int64(len(body))
	req.Header.Set("Authorization", e.blossomAuth(k, "upload", sha))
	req.Header.Set("X-SHA-256", sha)
	done := make(chan answered, 1)
	go func() {
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			done <- answered{err: err}
			return
		}
		defer res.Body.Close()
		a := answered{status: res.StatusCode, reason: res.Header.Get("X-Reason")}
		_ = json.NewDecoder(res.Body).Decode(&a.body)
		done <- a
	}()
	for start := time.Now(); !e.receiving(); time.Sleep(5 * time.Millisecond) {
		if time.Since(start) > 10*time.Second {
			e.t.Fatal("the upload never reached its body")
		}
	}
	return func() answered {
		_, _ = pw.Write(body)
		_ = pw.Close()
		a := <-done
		if a.err != nil {
			e.t.Fatal(a.err)
		}
		return a
	}
}

// receiving is whether an upload's temporary file is in the blob directory.
func (e *env) receiving() bool {
	for _, f := range e.files() {
		if strings.HasPrefix(f, ".upload-") {
			return true
		}
	}
	return false
}

// F2 and contract 5: the limits are checked again at commit with the real size, one upload at a time. An upload that
// passed its first check while another was on its way is refused once that one has taken the room, and an upload
// whose account went while its body was on its way is refused, leaving nothing on the disk.
func TestTheLimitsAreCheckedAgainAtCommit(t *testing.T) {
	for _, c := range []struct {
		name, reason string
		status       int
		fill         func(e *env, k key)
	}{
		{"the quota", "quota", 413, func(e *env, k key) {
			if err := e.st.AddOwner(e.t.Context(), hash([]byte("older")), k.pk, k.pk, store.DefaultQuota-10, false); err != nil {
				e.t.Fatal(err)
			}
		}},
		{"the day", "daily", 413, func(e *env, k key) { e.seed(k, "the day so far", store.DailyLimit-10) }},
		{"the account", "not_registered", 401, nil},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t)
			user := newKey()
			e.registered(user)
			if c.fill != nil {
				c.fill(e, user)
			}
			send := e.waiting(user, []byte("blob one"))
			if c.fill != nil {
				s, _, b := e.put(user, []byte("blob two"))
				expect(t, s, 200, b)
			} else {
				s, b := e.call(user, "DELETE", "/account", nil)
				expect(t, s, 200, b)
			}
			a := send()
			if a.status != c.status || a.reason != c.reason {
				t.Fatalf("the upload that waited: %d %q %v, want %d %s", a.status, a.reason, a.body, c.status, c.reason)
			}
			if s, _ := e.fetch(hash([]byte("blob one"))); s != 404 {
				t.Fatal("the refused upload is served")
			}
			if c.fill == nil && len(e.files()) != 0 {
				t.Fatalf("a refused upload left %v", e.files())
			}
		})
	}
}

// Contract 5: a library above its quota, as one lowered from 200 MB may be, keeps every blob it holds, a repeat upload
// of one included, and takes no new one until deleting brings it back within its quota.
func TestALibraryAboveItsQuotaKeepsItsBlobs(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.registered(user)
	first, second := bytes.Repeat([]byte("a"), 30), bytes.Repeat([]byte("b"), 30)
	for _, blob := range [][]byte{first, second} {
		if s, _, b := e.put(user, blob); s != 200 {
			t.Fatalf("upload %d %v", s, b)
		}
	}
	if found, err := e.st.SetQuota(t.Context(), user.pk, 40); err != nil || !found {
		t.Fatalf("set quota %v %v", found, err)
	}
	for _, blob := range [][]byte{first, second} {
		if s, got := e.fetch(hash(blob)); s != 200 || !bytes.Equal(got, blob) {
			t.Fatalf("a blob went with the lowered quota: %d", s)
		}
	}
	s, reason, b := e.put(user, []byte("c"))
	refusedFor(t, s, reason, b, "quota", store.Figures{Quota: 40, Used: 60, Daily: store.DailyLimit, Today: 60})
	s, _, b = e.put(user, first)
	expect(t, s, 200, b)
	if s := e.remove(user, hash(first)); s != 200 {
		t.Fatalf("delete %d", s)
	}
	s, _, b = e.put(user, []byte("c"))
	expect(t, s, 200, b)
}

// Contract 4.8 step 3 and 5: the new library's upload of a blob the server already stores costs nothing against its
// day, though it counts against its storage, and keeps the blob when the old library lets go of it.
func TestAMovesUploadsCostNothingAgainstTheDay(t *testing.T) {
	e := newEnv(t)
	from, to := newKey(), newKey()
	e.registered(from, to)
	text := []byte("a text backed up under the old library")
	if s, _, b := e.put(from, text); s != 200 {
		t.Fatalf("upload %d %v", s, b)
	}
	e.seed(to, "the new library's day", store.DailyLimit)
	s, _, b := e.put(to, text)
	expect(t, s, 200, b)
	if f := e.figures(to); f.Today != store.DailyLimit || f.Used != store.DailyLimit+int64(len(text)) {
		t.Fatalf("figures %+v", f)
	}
	if s := e.remove(from, hash(text)); s != 200 {
		t.Fatalf("the old library's delete %d", s)
	}
	if s, _ := e.fetch(hash(text)); s != 200 {
		t.Fatal("the blob went with the old library's delete")
	}
	s, reason, b := e.put(to, []byte("new to the disk"))
	if s != 413 || reason != "daily" {
		t.Fatalf("a new blob past the day: %d %q %v", s, reason, b)
	}
}

// Contract 4.4 and 5: the library a browser's capture counts against may delete it, once the phone has made the save;
// a user's delete takes every upload of the blob counted against them, a device key's only its own, and the file
// goes with its last owner. A capture another library holds isn't the user's to delete.
func TestAUserDeletesItsBrowsersCapture(t *testing.T) {
	e := newEnv(t)
	user, device, other := newKey(), newKey(), newKey()
	e.registered(user, other)
	expect(t, e.addDevice(user, device), 200, nil)
	capture := []byte("<p>a captured page</p>, encrypted")
	if s, _, b := e.put(device, capture); s != 200 {
		t.Fatalf("the browser's upload %d %v", s, b)
	}
	if s := e.remove(other, hash(capture)); s != 404 {
		t.Fatalf("another library's delete %d", s)
	}
	if s := e.remove(user, hash(capture)); s != 200 {
		t.Fatalf("the user's delete of its browser's capture %d", s)
	}
	if s, _ := e.fetch(hash(capture)); s != 404 {
		t.Fatal("the capture is still served")
	}
	if f := e.figures(user); f.Used != 0 || f.Today != int64(len(capture)) {
		t.Fatalf("figures %+v: the room comes back, the day doesn't", f)
	}
	// held by the user and its browser both: the user's delete takes both
	both := []byte("held twice")
	for _, k := range []key{device, user} {
		if s, _, b := e.put(k, both); s != 200 {
			t.Fatalf("upload %d %v", s, b)
		}
	}
	if s := e.remove(user, hash(both)); s != 200 {
		t.Fatalf("delete %d", s)
	}
	if s, _ := e.fetch(hash(both)); s != 404 {
		t.Fatal("the browser's copy kept the blob")
	}
	if len(e.files()) != 0 {
		t.Fatalf("files left behind: %v", e.files())
	}
	// a device key's delete takes only its own upload
	for _, k := range []key{device, user} {
		if s, _, b := e.put(k, both); s != 200 {
			t.Fatalf("upload %d %v", s, b)
		}
	}
	if s := e.remove(device, hash(both)); s != 200 {
		t.Fatalf("the browser's delete %d", s)
	}
	if s, _ := e.fetch(hash(both)); s != 200 {
		t.Fatal("a browser's delete took the user's copy")
	}
}

// Contract 4.4 and 5: a capture counts against its library's room until it expires, not until the hourly sweep after:
// a library full with its browser's capture takes a text that fits as soon as the capture has expired, and GET
// /account's figures no longer count it.
func TestAnExpiredCaptureGivesBackItsRoom(t *testing.T) {
	e := newEnv(t)
	user, device := newKey(), newKey()
	e.registered(user)
	expect(t, e.addDevice(user, device), 200, nil)
	capture, text := bytes.Repeat([]byte("c"), 40), bytes.Repeat([]byte("t"), 20)
	if s, _, b := e.put(device, capture); s != 200 {
		t.Fatalf("the capture %d %v", s, b)
	}
	if found, err := e.st.SetQuota(t.Context(), user.pk, 50); err != nil || !found {
		t.Fatalf("set quota %v %v", found, err)
	}
	if s, reason, _ := e.put(user, text); s != 413 || reason != "quota" {
		t.Fatalf("a text past the room the capture leaves: %d %q", s, reason)
	}
	e.clock = e.clock.Add(store.InboxLife)
	s, _, b := e.put(user, text)
	expect(t, s, 200, b)
	s, b = e.account(user)
	// the capture's upload is 14 days old, so only the text counts against the day
	wantAccount(t, s, b, store.Figures{Quota: 50, Used: int64(len(text)), Daily: store.DailyLimit, Today: int64(len(text))})
}

// After a move (contract 4.8 step 4), a capture the browser sent while the old library held it stays that library's:
// the new library can't delete it, the old one can.
func TestAMovedBrowsersCaptureStaysWithItsLibrary(t *testing.T) {
	e := newEnv(t)
	from, to, device := newKey(), newKey(), newKey()
	e.registered(from, to)
	expect(t, e.addDevice(from, device), 200, nil)
	capture := []byte("sent while the old library held the browser")
	if s, _, b := e.put(device, capture); s != 200 {
		t.Fatalf("upload %d %v", s, b)
	}
	s, b := e.call(to, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": device.pk, "release": e.release(from, device.pk, to.pk, e.clock)})
	expect(t, s, 200, b)
	if s := e.remove(to, hash(capture)); s != 404 {
		t.Fatalf("the new library's delete %d", s)
	}
	if s := e.remove(from, hash(capture)); s != 200 {
		t.Fatalf("the old library's delete %d", s)
	}
	if s, _ := e.fetch(hash(capture)); s != 404 {
		t.Fatal("the capture is still served")
	}
}

// Contract 5: a blob over 8 MB gets 413 too_large, never tried again, whatever the library's room, with no figures.
func TestTooLargeIsAnsweredFirst(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.registered(user)
	e.seed(user, "a full day", store.DailyLimit)
	if s, reason := e.ask(user, hash([]byte("x")), blossom.MaxBlob+1); s != 413 || reason != "too_large" {
		t.Fatalf("preflight %d %q", s, reason)
	}
	s, reason, b := e.put(user, make([]byte, blossom.MaxBlob+1))
	if s != 413 || reason != "too_large" || len(b) != 2 {
		t.Fatalf("an upload over 8 MB: %d %q %v", s, reason, b)
	}
}

// Unlink keeps the file of a blob an owner holds: an upload of it may have landed between a delete and its unlink.
func TestUnlinkKeepsAHeldBlob(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.registered(user)
	blob := []byte("landed between a delete and its unlink")
	if s, _, b := e.put(user, blob); s != 200 {
		t.Fatalf("upload %d %v", s, b)
	}
	e.bs.Unlink(hash(blob))
	if _, err := os.Stat(filepath.Join(e.dir, "blobs", hash(blob)[:2], hash(blob))); err != nil {
		t.Fatalf("a held blob's file went: %v", err)
	}
	if s, _ := e.fetch(hash(blob)); s != 200 {
		t.Fatal("a held blob is no longer served")
	}
}
