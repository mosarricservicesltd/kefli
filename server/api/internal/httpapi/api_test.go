package httpapi_test

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/richardminton-glitch/Kefli/server/api/internal/blossom"
	"github.com/richardminton-glitch/Kefli/server/api/internal/httpapi"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

type env struct {
	t     *testing.T
	st    *store.Store
	api   *httptest.Server
	blob  *httptest.Server
	clock time.Time
	dir   string
	bs    *blossom.Server
	// from is the client address Caddy would pass in X-Forwarded-For, when set
	from string
}

// newEnv is an API and blob store on a fresh database; opts may change the API's configuration.
func newEnv(t *testing.T, opts ...func(*httpapi.Config)) *env {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "k.db"))
	if err != nil {
		t.Fatal(err)
	}
	e := &env{t: t, st: st, clock: time.Unix(1_791_600_000, 0), dir: dir}
	st.Now = func() time.Time { return e.clock }
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	apiMux, blobMux := http.NewServeMux(), http.NewServeMux()
	e.api = httptest.NewServer(httpapi.CORS(apiMux))
	e.blob = httptest.NewServer(httpapi.CORS(blobMux))
	b := blossom.New(filepath.Join(dir, "blobs"), e.blob.URL, st, log)
	b.Routes(blobMux)
	e.bs = b
	cfg := httpapi.Config{Base: e.api.URL, Defaults: []byte(`{"v":1}`), Names: map[string]string{"_": "ab"}, Relays: []string{"wss://r"}, Unlink: b.Unlink}
	for _, o := range opts {
		o(&cfg)
	}
	httpapi.New(cfg, st, log).Routes(apiMux)
	t.Cleanup(func() { e.api.Close(); e.blob.Close(); st.Close() })
	return e
}

type key struct{ sk, pk string }

func newKey() key {
	sk := nostr.GeneratePrivateKey()
	pk, _ := nostr.GetPublicKey(sk)
	return key{sk, pk}
}

func (k key) sign(t *testing.T, kind int, tags nostr.Tags, at time.Time) string {
	ev := nostr.Event{Kind: kind, CreatedAt: nostr.Timestamp(at.Unix()), Tags: tags}
	if err := ev.Sign(k.sk); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(ev)
	return "Nostr " + base64.StdEncoding.EncodeToString(raw)
}

func hash(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// call sends a NIP-98 request signed by k; tweak may change the authorisation's tags before signing.
func (e *env) call(k key, method, path string, body any, tweak ...func(nostr.Tags) nostr.Tags) (int, map[string]any) {
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	tags := nostr.Tags{{"u", e.api.URL + path}, {"method", method}}
	if method != "GET" {
		tags = append(tags, nostr.Tag{"payload", hash(raw)})
	}
	for _, f := range tweak {
		tags = f(tags)
	}
	req, _ := http.NewRequest(method, e.api.URL+path, bytes.NewReader(raw))
	req.Header.Set("Authorization", k.sign(e.t, 27235, tags, e.clock))
	if e.from != "" {
		req.Header.Set("X-Forwarded-For", e.from)
	}
	return send(e.t, req)
}

func send(t *testing.T, req *http.Request) (int, map[string]any) {
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func expect(t *testing.T, got, want int, body map[string]any) {
	t.Helper()
	if got != want {
		t.Fatalf("status %d, want %d (%v)", got, want, body)
	}
}

func TestDefaultsAndCORS(t *testing.T) {
	e := newEnv(t)
	res, _ := http.Get(e.api.URL + "/defaults.json")
	if res.StatusCode != 200 || res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("defaults %d", res.StatusCode)
	}
	req, _ := http.NewRequest("OPTIONS", e.api.URL+"/register", nil)
	res, _ = http.DefaultClient.Do(req)
	if res.StatusCode != 204 || res.Header.Get("Access-Control-Allow-Headers") == "" {
		t.Fatalf("preflight %d", res.StatusCode)
	}
	s, body := send(t, mustReq("GET", e.api.URL+"/.well-known/nostr.json?name=_"))
	if s != 200 || body["names"].(map[string]any)["_"] != "ab" {
		t.Fatalf("nip05 %v", body)
	}
}

func mustReq(method, url string) *http.Request {
	r, _ := http.NewRequest(method, url, nil)
	return r
}

func TestNip98(t *testing.T) {
	e := newEnv(t)
	k := newKey()
	replace := func(name, value string) func(nostr.Tags) nostr.Tags {
		return func(ts nostr.Tags) nostr.Tags {
			for i := range ts {
				if ts[i][0] == name {
					ts[i][1] = value
				}
			}
			return ts
		}
	}
	for name, tw := range map[string]func(nostr.Tags) nostr.Tags{
		"url":     replace("u", "https://elsewhere/register"),
		"method":  replace("method", "GET"),
		"payload": replace("payload", hash([]byte("x"))),
	} {
		if s, b := e.call(k, "POST", "/register", map[string]any{"v": 1}, tw); s != 401 {
			t.Fatalf("%s: %d %v", name, s, b)
		}
	}
	req := mustReq("POST", e.api.URL+"/register")
	if s, _ := send(t, req); s != 401 {
		t.Fatal("no authorisation accepted")
	}
	// a stale event, and the same event twice
	stale := k.sign(t, 27235, nostr.Tags{{"u", e.api.URL + "/register"}, {"method", "POST"}, {"payload", hash([]byte(`{"v":1}`))}}, e.clock.Add(-2*time.Minute))
	req, _ = http.NewRequest("POST", e.api.URL+"/register", bytes.NewReader([]byte(`{"v":1}`)))
	req.Header.Set("Authorization", stale)
	if s, b := send(t, req); s != 401 || b["error"] != "auth: stale" {
		t.Fatalf("stale: %d %v", s, b)
	}
	good := k.sign(t, 27235, nostr.Tags{{"u", e.api.URL + "/register"}, {"method", "POST"}, {"payload", hash([]byte(`{"v":1}`))}}, e.clock)
	for i, want := range []int{200, 401} {
		req, _ = http.NewRequest("POST", e.api.URL+"/register", bytes.NewReader([]byte(`{"v":1}`)))
		req.Header.Set("Authorization", good)
		if s, b := send(t, req); s != want {
			t.Fatalf("use %d: %d %v", i, s, b)
		}
	}
	if s, b := e.call(k, "POST", "/register", map[string]any{"v": 2}); s != 400 {
		t.Fatalf("v2 body: %d %v", s, b)
	}
}

func TestRegisterAndDevices(t *testing.T) {
	e := newEnv(t)
	user, device, other := newKey(), newKey(), newKey()
	s, b := e.call(device, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": other.pk, "label": "x"})
	expect(t, s, 403, b)
	s, b = e.call(user, "POST", "/register", map[string]any{"v": 1})
	expect(t, s, 200, b)
	if b["quota"] != float64(store.DefaultQuota) {
		t.Fatalf("quota %v", b)
	}
	e.clock = e.clock.Add(time.Second)
	s, b = e.call(user, "POST", "/register", map[string]any{"v": 1})
	expect(t, s, 200, b)
	s, b = e.call(user, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": "nothex", "label": "x"})
	expect(t, s, 400, b)
	s, b = e.call(user, "POST", "/devices", map[string]any{"v": 1, "device_pubkey": device.pk, "label": "Chrome on a Mac", "proof": e.proof(device, "n1", e.clock)})
	expect(t, s, 200, b)
	if u, ok, _ := e.st.DeviceUser(t.Context(), device.pk); !ok || u != user.pk {
		t.Fatal("device not authorised")
	}
	// the label an older phone sends is never stored (F30)
	db, _ := sql.Open("sqlite", "file:"+filepath.Join(e.dir, "k.db")+"?mode=ro")
	var label string
	if err := db.QueryRow(`SELECT label FROM devices WHERE device_pubkey = ?`, device.pk).Scan(&label); err != nil || label != "" {
		t.Fatalf("label %q %v", label, err)
	}
	db.Close()
	s, b = e.call(other, "POST", "/register", map[string]any{"v": 1})
	expect(t, s, 200, b)
	s, b = e.call(other, "DELETE", "/devices/"+device.pk, nil)
	expect(t, s, 404, b)
	s, b = e.call(user, "DELETE", "/devices/"+device.pk, nil)
	expect(t, s, 200, b)
	if _, ok, _ := e.st.DeviceUser(t.Context(), device.pk); ok {
		t.Fatal("device still authorised")
	}
}

func TestOffers(t *testing.T) {
	e := newEnv(t)
	user, device, stranger := newKey(), newKey(), newKey()
	lookup := hash([]byte("code"))
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	// a pair offer from an unauthorised device key, read by a registered user only
	s, b := e.call(device, "POST", "/pair-offers", map[string]any{"v": 1, "lookup": lookup, "offer": "sealed"})
	expect(t, s, 200, b)
	s, b = e.call(device, "POST", "/pair-offers", map[string]any{"v": 1, "lookup": lookup, "offer": "again"})
	expect(t, s, 409, b)
	s, b = e.call(stranger, "GET", "/pair-offers/"+lookup, nil)
	expect(t, s, 403, b)
	s, b = e.call(user, "GET", "/pair-offers/"+lookup, nil)
	if s != 200 || b["offer"] != "sealed" {
		t.Fatalf("pair offer %d %v", s, b)
	}
	e.clock = e.clock.Add(store.OfferLife)
	s, b = e.call(user, "GET", "/pair-offers/"+lookup, nil)
	expect(t, s, 404, b)
	s, b = e.call(device, "POST", "/pair-offers", map[string]any{"v": 1, "lookup": lookup, "offer": "fresh"})
	expect(t, s, 200, b)
	// a phone offer from a registered user, fetched once by any key
	s, b = e.call(stranger, "POST", "/phone-offers", map[string]any{"v": 1, "lookup": lookup, "offer": "x"})
	expect(t, s, 403, b)
	s, b = e.call(user, "POST", "/phone-offers", map[string]any{"v": 1, "lookup": lookup, "offer": "mnemonic"})
	expect(t, s, 200, b)
	s, b = e.call(stranger, "GET", "/phone-offers/"+lookup, nil)
	if s != 200 || b["offer"] != "mnemonic" {
		t.Fatalf("phone offer %d %v", s, b)
	}
	e.clock = e.clock.Add(time.Second) // a fresh authorisation: the same one twice is a replay
	s, b = e.call(stranger, "GET", "/phone-offers/"+lookup, nil)
	expect(t, s, 404, b)
}

func TestOfferRateLimit(t *testing.T) {
	e := newEnv(t)
	device := newKey()
	for i := 0; i < 30; i++ {
		e.clock = e.clock.Add(time.Second)
		s, b := e.call(device, "POST", "/pair-offers", map[string]any{"v": 1, "lookup": hash([]byte(strconv.Itoa(i))), "offer": "o"})
		expect(t, s, 200, b)
	}
	s, b := e.call(device, "POST", "/pair-offers", map[string]any{"v": 1, "lookup": hash([]byte("31")), "offer": "o"})
	expect(t, s, 429, b)
}

// upload puts body on the blob store signed by k; it returns the status and the descriptor.
func (e *env) upload(k key, body []byte) (int, map[string]any) {
	sha := hash(body)
	req, _ := http.NewRequest("PUT", e.blob.URL+"/upload", bytes.NewReader(body))
	req.Header.Set("Authorization", k.sign(e.t, 24242, nostr.Tags{{"t", "upload"}, {"x", sha}, {"expiration", strconv.FormatInt(e.clock.Add(time.Hour).Unix(), 10)}}, e.clock))
	req.Header.Set("X-SHA-256", sha)
	req.Header.Set("Content-Type", "application/octet-stream")
	return send(e.t, req)
}

func (e *env) fetch(sha string) (int, []byte) {
	res, err := http.Get(e.blob.URL + "/" + sha)
	if err != nil {
		e.t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, b
}

func (e *env) remove(k key, sha string) int {
	req, _ := http.NewRequest("DELETE", e.blob.URL+"/"+sha, nil)
	req.Header.Set("Authorization", k.sign(e.t, 24242, nostr.Tags{{"t", "delete"}, {"x", sha}, {"expiration", strconv.FormatInt(e.clock.Add(time.Hour).Unix(), 10)}}, e.clock))
	s, _ := send(e.t, req)
	return s
}

func TestBlossom(t *testing.T) {
	e := newEnv(t)
	user, stranger := newKey(), newKey()
	blob := []byte("ciphertext of an article")
	s, b := e.upload(stranger, blob)
	expect(t, s, 401, b)
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	s, b = e.upload(user, blob)
	expect(t, s, 200, b)
	if b["sha256"] != hash(blob) || b["url"] != e.blob.URL+"/"+hash(blob) {
		t.Fatalf("descriptor %v", b)
	}
	if s, got := e.fetch(hash(blob)); s != 200 || !bytes.Equal(got, blob) {
		t.Fatalf("fetch %d", s)
	}
	req := mustReq("GET", e.blob.URL+"/"+hash(blob)+".bin")
	req.Header.Set("Range", "bytes=0-9")
	res, _ := http.DefaultClient.Do(req)
	part, _ := io.ReadAll(res.Body)
	if res.StatusCode != 206 || string(part) != string(blob[:10]) {
		t.Fatalf("range %d %q", res.StatusCode, part)
	}
	// a body that isn't the blob authorised
	req, _ = http.NewRequest("PUT", e.blob.URL+"/upload", bytes.NewReader([]byte("other")))
	req.Header.Set("Authorization", user.sign(t, 24242, nostr.Tags{{"t", "upload"}, {"x", hash(blob)}, {"expiration", strconv.FormatInt(e.clock.Add(time.Hour).Unix(), 10)}}, e.clock))
	req.Header.Set("X-SHA-256", hash(blob))
	if s, _ := send(t, req); s != 400 {
		t.Fatalf("mismatched body %d", s)
	}
	if s := e.remove(stranger, hash(blob)); s != 404 {
		t.Fatalf("a stranger's delete %d", s)
	}
	if s := e.remove(user, hash(blob)); s != 200 {
		t.Fatalf("delete %d", s)
	}
	if s, _ := e.fetch(hash(blob)); s != 404 {
		t.Fatal("blob still served")
	}
	if _, err := os.Stat(filepath.Join(e.dir, "blobs", hash(blob)[:2], hash(blob))); !os.IsNotExist(err) {
		t.Fatal("file left behind")
	}
}

func TestQuotaAndPreflight(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	used := store.DefaultQuota - 5000
	if err := e.st.AddOwner(t.Context(), hash([]byte("big")), user.pk, user.pk, used, false); err != nil {
		t.Fatal(err)
	}
	s, b := e.upload(user, bytes.Repeat([]byte("o"), 5001))
	expect(t, s, 413, b)
	if b["error"] != "quota" {
		t.Fatalf("reason %v", b)
	}
	s, b = e.upload(user, bytes.Repeat([]byte("f"), 5000))
	expect(t, s, 200, b)
	// BUD-06: the same check without the body
	req := mustReq("HEAD", e.blob.URL+"/upload")
	req.Header.Set("X-SHA-256", hash([]byte("x")))
	req.Header.Set("X-Content-Length", "1")
	req.Header.Set("Authorization", user.sign(t, 24242, nostr.Tags{{"t", "upload"}, {"x", hash([]byte("x"))}, {"expiration", strconv.FormatInt(e.clock.Add(time.Hour).Unix(), 10)}}, e.clock))
	res, _ := http.DefaultClient.Do(req)
	if res.StatusCode != 413 || res.Header.Get("X-Reason") != "quota" {
		t.Fatalf("preflight %d %q", res.StatusCode, res.Header.Get("X-Reason"))
	}
}

// files under the blob directory, temporaries included
func (e *env) files() []string {
	var out []string
	_ = filepath.WalkDir(filepath.Join(e.dir, "blobs"), func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			out = append(out, d.Name())
		}
		return nil
	})
	return out
}

// F2: a refused upload leaves nothing on disk, a body of unknown length is refused before it is read, and uploads
// racing for the last of a quota, room for one tiny blob's block, can't together overshoot it.
func TestRefusedUploadsLeaveNothing(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	if err := e.st.AddOwner(t.Context(), hash([]byte("big")), user.pk, user.pk, store.DefaultQuota-store.BlockSize-10, false); err != nil {
		t.Fatal(err)
	}
	blob := []byte("a chunked body")
	req, _ := http.NewRequest("PUT", e.blob.URL+"/upload", io.NopCloser(bytes.NewReader(blob)))
	req.ContentLength = -1
	req.Header.Set("Authorization", user.sign(t, 24242, nostr.Tags{{"t", "upload"}, {"x", hash(blob)}, {"expiration", strconv.FormatInt(e.clock.Add(time.Hour).Unix(), 10)}}, e.clock))
	req.Header.Set("X-SHA-256", hash(blob))
	if s, b := send(t, req); s != 411 {
		t.Fatalf("chunked upload %d %v", s, b)
	}
	if s, _ := e.upload(user, bytes.Repeat([]byte("o"), int(store.BlockSize)+11)); s != 413 {
		t.Fatalf("over quota %d", s)
	}
	if f := e.files(); len(f) != 0 {
		t.Fatalf("refused uploads left %v", f)
	}
	var wg sync.WaitGroup
	accepted := make(chan struct{}, 20)
	for i := range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if s, _ := e.upload(user, []byte(fmt.Sprintf("blob %03d", i))); s == 200 {
				accepted <- struct{}{}
			}
		}()
	}
	wg.Wait()
	close(accepted)
	if n := len(accepted); n != 1 || len(e.files()) != 1 {
		t.Fatalf("%d of 20 eight-byte uploads accepted into a block and ten bytes of quota, %d files", n, len(e.files()))
	}
	if used, _ := e.st.Used(t.Context(), user.pk); used > store.DefaultQuota {
		t.Fatalf("used %d over the quota", used)
	}
}

// F2: the hourly sweep removes blob files nobody owns and stale upload temporaries, once an hour old.
func TestSweepFiles(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	owned := []byte("kept")
	if s, _ := e.upload(user, owned); s != 200 {
		t.Fatal("upload")
	}
	orphan := hash([]byte("nobody's"))
	dir := filepath.Join(e.dir, "blobs", orphan[:2])
	_ = os.MkdirAll(dir, 0o750)
	for _, name := range []string{orphan, ".upload-123", hash([]byte("fresh"))} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o640); err != nil {
			t.Fatal(err)
		}
	}
	old := e.clock.Add(-2 * time.Hour)
	_ = os.Chtimes(filepath.Join(dir, orphan), old, old)
	_ = os.Chtimes(filepath.Join(dir, ".upload-123"), old, old)
	ownedPath := filepath.Join(e.dir, "blobs", hash(owned)[:2], hash(owned))
	_ = os.Chtimes(ownedPath, old, old)
	_ = os.Chtimes(filepath.Join(dir, hash([]byte("fresh"))), e.clock, e.clock)
	n, err := e.bs.SweepFiles(t.Context(), e.clock)
	if err != nil || n != 2 {
		t.Fatalf("removed %d %v", n, err)
	}
	if _, err := os.Stat(ownedPath); err != nil {
		t.Fatal("an owned blob was swept")
	}
	if _, err := os.Stat(filepath.Join(dir, hash([]byte("fresh")))); err != nil {
		t.Fatal("a file under an hour old was swept")
	}
}

func TestDeviceInboxAndAccountDeletion(t *testing.T) {
	e := newEnv(t)
	user, device := newKey(), newKey()
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	expect(t, e.addDevice(user, device), 200, nil)
	inbox, own, shared := []byte("an inbox blob"), []byte("the user's blob"), []byte("held twice")
	for _, up := range []struct {
		k key
		b []byte
	}{{device, inbox}, {user, own}, {user, shared}, {device, shared}} {
		if s, b := e.upload(up.k, up.b); s != 200 {
			t.Fatalf("upload %d %v", s, b)
		}
	}
	if used, _ := e.st.Used(t.Context(), user.pk); used != costs(inbox, own, shared) {
		t.Fatalf("used %d: a device's uploads count against its user, each blob once", used)
	}
	// the inbox blob expires after 14 days; the user's own and the one the user also holds stay
	e.clock = e.clock.Add(store.InboxLife)
	orphaned, err := e.st.ExpireInbox(t.Context())
	if err != nil || len(orphaned) != 1 || orphaned[0] != hash(inbox) {
		t.Fatalf("expired %v %v", orphaned, err)
	}
	if s, _ := e.fetch(hash(shared)); s != 200 {
		t.Fatal("a blob the user also holds went with the inbox copy")
	}
	s, b := e.call(user, "DELETE", "/account", nil)
	expect(t, s, 200, b)
	for _, blob := range [][]byte{own, shared} {
		if s, _ := e.fetch(hash(blob)); s != 404 {
			t.Fatalf("blob kept after the account went: %s", blob)
		}
	}
	if _, ok, _ := e.st.DeviceUser(t.Context(), device.pk); ok {
		t.Fatal("device kept after the account went")
	}
	gone, _ := e.st.Gone(t.Context(), 0)
	if len(gone) != 2 {
		t.Fatalf("gone %v: the user and the device", gone)
	}
	if s, b := e.upload(user, own); s != 401 {
		t.Fatalf("upload after deletion %d %v", s, b)
	}
	e.clock = e.clock.Add(time.Second)
	s, b = e.call(user, "DELETE", "/account", nil)
	expect(t, s, 200, b)
}
