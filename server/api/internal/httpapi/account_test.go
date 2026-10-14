package httpapi_test

import (
	"database/sql"
	"net/http"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// wantAccount checks GET /account's answer: 200 and the figures, in bytes, as contract 6 gives them.
func wantAccount(t *testing.T, s int, b map[string]any, f store.Figures) {
	t.Helper()
	if s != 200 || b["v"] != float64(1) || len(b) != 5 {
		t.Fatalf("GET /account: %d %v", s, b)
	}
	for name, n := range map[string]int64{"quota": f.Quota, "used": f.Used, "daily": f.Daily, "today": f.Today} {
		if got, ok := b[name].(float64); !ok || int64(got) != n {
			t.Fatalf("%s is %v, want %d (%v)", name, b[name], n, b)
		}
	}
}

// account asks GET /account as k a second on, so asking twice isn't a replay of the same signed request.
func (e *env) account(k key) (int, map[string]any) {
	e.clock = e.clock.Add(time.Second)
	return e.call(k, "GET", "/account", nil)
}

// Contract 6: GET /account answers a registered library's quota, use, daily limit and last 24 hours' uploads, its
// browsers' included; deleting gives back room and none of the day. Any other key gets 403 not_registered.
func TestGetAccount(t *testing.T) {
	e := newEnv(t)
	user, device, stranger := newKey(), newKey(), newKey()
	s, b := e.account(stranger)
	wantError(t, s, b, 403, "not_registered")
	e.registered(user)
	s, b = e.account(user)
	wantAccount(t, s, b, store.Figures{Quota: store.DefaultQuota, Daily: store.DailyLimit})
	expect(t, e.addDevice(user, device), 200, nil)
	own, capture := []byte("the user's text"), []byte("a browser's capture")
	for _, up := range []struct {
		k    key
		blob []byte
	}{{user, own}, {device, capture}} {
		if s, _, b := e.put(up.k, up.blob); s != 200 {
			t.Fatalf("upload %d %v", s, b)
		}
	}
	both := int64(len(own) + len(capture))
	s, b = e.account(user)
	wantAccount(t, s, b, store.Figures{Quota: store.DefaultQuota, Used: both, Daily: store.DailyLimit, Today: both})
	if s := e.remove(user, hash(capture)); s != 200 {
		t.Fatalf("delete %d", s)
	}
	if found, err := e.st.SetQuota(t.Context(), user.pk, 100<<20); err != nil || !found {
		t.Fatalf("set quota %v %v", found, err)
	}
	s, b = e.account(user)
	wantAccount(t, s, b, store.Figures{Quota: 100 << 20, Used: int64(len(own)), Daily: store.DailyLimit, Today: both})
	// a device key, and a disabled library, aren't registered users
	s, b = e.account(device)
	wantError(t, s, b, 403, "not_registered")
	if err := e.st.SetDisabled(t.Context(), user.pk, true); err != nil {
		t.Fatal(err)
	}
	s, b = e.account(user)
	wantError(t, s, b, 403, "not_registered")
	// unsigned
	if s, _ := send(t, mustReq("GET", e.api.URL+"/account")); s != 401 {
		t.Fatalf("unsigned GET /account %d", s)
	}
}

// GET /account is held to the per-key limit of every signed call, 60 a minute (backend spec 3.3).
func TestGetAccountIsRateLimited(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.registered(user)
	nth := func(i int) func(nostr.Tags) nostr.Tags {
		return func(ts nostr.Tags) nostr.Tags { return append(ts, nostr.Tag{"n", strconv.Itoa(i)}) }
	}
	// registering spent one of the minute's 60
	for i := 0; i < 59; i++ {
		s, b := e.call(user, "GET", "/account", nil, nth(i))
		expect(t, s, 200, b)
	}
	req := mustReq("GET", e.api.URL+"/account")
	req.Header.Set("Authorization", user.sign(t, 27235, nostr.Tags{{"u", e.api.URL + "/account"}, {"method", "GET"}, {"n", "last"}}, e.clock))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 429 || res.Header.Get("Retry-After") == "" {
		t.Fatalf("the 61st call in a minute: %d, Retry-After %q", res.StatusCode, res.Header.Get("Retry-After"))
	}
}

// Contract 6: POST /register answers the library's own quota, the default or one set for it, and what its blobs take,
// whether or not it was registered already.
func TestRegisterAnswersTheLibrarysOwnFigures(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	s, b := e.call(user, "POST", "/register", map[string]any{"v": 1})
	if s != 200 || b["quota"] != float64(52_428_800) || b["used"] != float64(0) || len(b) != 3 {
		t.Fatalf("a new library: %d %v", s, b)
	}
	blob := []byte("thirty bytes of an article....")
	if s, _, b := e.put(user, blob); s != 200 {
		t.Fatalf("upload %d %v", s, b)
	}
	if found, err := e.st.SetQuota(t.Context(), user.pk, 100<<20); err != nil || !found {
		t.Fatalf("set quota %v %v", found, err)
	}
	e.clock = e.clock.Add(time.Second)
	s, b = e.call(user, "POST", "/register", map[string]any{"v": 1})
	if s != 200 || b["quota"] != float64(100<<20) || b["used"] != float64(len(blob)) {
		t.Fatalf("registering again: %d %v", s, b)
	}
}

// The figures' failures are answered 500, never swallowed into a figure of 0 (POST /register answered used 0 when
// its query failed).
func TestFiguresThatCantBeReadAre500(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.registered(user)
	db, err := sql.Open("sqlite", "file:"+filepath.Join(e.dir, "k.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`ALTER TABLE owners RENAME TO owners_away`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	e.clock = e.clock.Add(time.Second)
	s, b := e.call(user, "POST", "/register", map[string]any{"v": 1})
	wantError(t, s, b, 500, "server")
	s, b = e.call(user, "GET", "/account", nil)
	wantError(t, s, b, 500, "server")
}
