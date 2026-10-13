package httpapi_test

import (
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/httpapi"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

func behindCaddy(c *httpapi.Config) { c.TrustProxy = true }

// F8: every address in an IPv6 /64 is one client's for free, so a /64 gets one address's 30 offers an hour.
func TestOffersCountAnIPv6BlockOnce(t *testing.T) {
	e := newEnv(t, behindCaddy)
	for i := 0; i < 30; i++ {
		e.clock = e.clock.Add(time.Second)
		e.from = fmt.Sprintf("2001:db8:7:8::%x", i+1)
		s, b := e.call(newKey(), "GET", "/phone-offers/"+hash([]byte{byte(i)}), nil)
		expect(t, s, 404, b)
	}
	e.from = "2001:db8:7:8:ffff::1"
	s, b := e.call(newKey(), "GET", "/phone-offers/"+hash([]byte("next")), nil)
	expect(t, s, 429, b)
	e.from = "2001:db8:7:9::1"
	s, b = e.call(newKey(), "GET", "/phone-offers/"+hash([]byte("next")), nil)
	expect(t, s, 404, b)
}

// F45: a request its address is refused for used to leave a window for its key, so throwaway keys grew the limiter
// without bound; and that window cost a key that moved addresses one of its 30.
func TestARefusedAddressCostsTheKeyNothing(t *testing.T) {
	e := newEnv(t, behindCaddy)
	e.from = "198.51.100.1"
	for i := 0; i < 30; i++ {
		e.clock = e.clock.Add(time.Second)
		e.call(newKey(), "POST", "/pair-offers", map[string]any{"v": 1, "lookup": hash([]byte{byte(i)}), "offer": "o"})
	}
	device := newKey()
	s, b := e.call(device, "POST", "/pair-offers", map[string]any{"v": 1, "lookup": hash([]byte("x")), "offer": "o"})
	expect(t, s, 429, b)
	e.from = "198.51.100.2"
	for i := 0; i < 30; i++ {
		e.clock = e.clock.Add(time.Second)
		s, b := e.call(device, "POST", "/pair-offers", map[string]any{"v": 1, "lookup": hash([]byte{'k', byte(i)}), "offer": "o"})
		expect(t, s, 200, b)
	}
}

// F8: someone with a photo of the QR and many addresses could try a large share of the million codes while an offer
// waited. Past MaxMisses wrong lookups in an offer's life, every lookup waits, the right one included.
func TestPhoneOfferMissesFromEveryone(t *testing.T) {
	e := newEnv(t, behindCaddy)
	user := newKey()
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	lookup := hash([]byte("the right code"))
	s, b := e.call(user, "POST", "/phone-offers", map[string]any{"v": 1, "lookup": lookup, "offer": "mnemonic"})
	expect(t, s, 200, b)
	for i := 0; i < httpapi.MaxMisses; i++ {
		e.from = fmt.Sprintf("2001:db8:%x::1", i+1)
		s, b := e.call(newKey(), "GET", "/phone-offers/"+hash([]byte(fmt.Sprint("guess ", i))), nil)
		expect(t, s, 404, b)
	}
	e.from = "203.0.113.77"
	s, b = e.call(newKey(), "GET", "/phone-offers/"+lookup, nil)
	expect(t, s, 429, b)
	// five minutes on, the offer has expired and the misses are forgotten: a new offer's right code is taken
	e.clock = e.clock.Add(store.OfferLife)
	s, b = e.call(user, "POST", "/phone-offers", map[string]any{"v": 1, "lookup": lookup, "offer": "mnemonic"})
	expect(t, s, 200, b)
	e.clock = e.clock.Add(time.Second)
	s, b = e.call(newKey(), "GET", "/phone-offers/"+lookup, nil)
	if s != 200 || b["offer"] != "mnemonic" {
		t.Fatalf("the next five minutes: %d %v", s, b)
	}
}

// F8: registrations were five a day per exact address and nothing more, so a /64 made accounts without end, and a
// restart forgot every count. Now a /56 is one address, and everyone together makes MaxRegistrations an hour, counted
// from the accounts themselves.
func TestRegistrationLimits(t *testing.T) {
	few := func(c *httpapi.Config) { c.TrustProxy, c.MaxRegistrations = true, 8 }
	e := newEnv(t, few)
	for i := 0; i < 5; i++ {
		e.from = fmt.Sprintf("2001:db8:0:%x::1", 0x4900+i)
		s, b := e.call(newKey(), "POST", "/register", map[string]any{"v": 1})
		expect(t, s, 200, b)
	}
	e.from = "2001:db8:0:49ff::1"
	s, b := e.call(newKey(), "POST", "/register", map[string]any{"v": 1})
	expect(t, s, 429, b)
	for i := 0; i < 3; i++ {
		e.from = fmt.Sprintf("198.51.100.%d", i+1)
		s, b := e.call(newKey(), "POST", "/register", map[string]any{"v": 1})
		expect(t, s, 200, b)
	}
	e.from = "198.51.100.50"
	s, b = e.call(newKey(), "POST", "/register", map[string]any{"v": 1})
	expect(t, s, 429, b)
	// a restart keeps the count
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	mux := http.NewServeMux()
	again := httptest.NewServer(mux)
	defer again.Close()
	httpapi.New(httpapi.Config{Base: again.URL, Defaults: []byte(`{"v":1}`), TrustProxy: true, MaxRegistrations: 8}, e.st, log).Routes(mux)
	e.api = again
	e.from = "198.51.100.51"
	s, b = e.call(newKey(), "POST", "/register", map[string]any{"v": 1})
	expect(t, s, 429, b)
	e.clock = e.clock.Add(time.Hour)
	s, b = e.call(newKey(), "POST", "/register", map[string]any{"v": 1})
	expect(t, s, 200, b)
}

// F45: DELETE /account from any fresh key wrote a gone row, kept for good, which every nightly sweep went through.
func TestGoneRowsAreForAccountsAndEnd(t *testing.T) {
	e := newEnv(t)
	s, b := e.call(newKey(), "DELETE", "/account", nil)
	expect(t, s, 200, b)
	if gone, _ := e.st.Gone(t.Context(), 0); len(gone) != 0 {
		t.Fatalf("a key that never had an account is gone: %v", gone)
	}
	user := newKey()
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	e.clock = e.clock.Add(time.Second)
	s, b = e.call(user, "DELETE", "/account", nil)
	expect(t, s, 200, b)
	e.clock = e.clock.Add(store.GoneLife - time.Second)
	if err := e.st.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if gone, _ := e.st.Gone(t.Context(), 0); len(gone) != 1 {
		t.Fatalf("gone %v before its time", gone)
	}
	e.clock = e.clock.Add(time.Second)
	if err := e.st.Sweep(t.Context()); err != nil {
		t.Fatal(err)
	}
	if gone, _ := e.st.Gone(t.Context(), 0); len(gone) != 0 {
		t.Fatalf("gone %v kept past GoneLife", gone)
	}
}

// F8: the quotas are per account, so only a floor on the disk's free space stops every account together filling it.
func TestUploadsLeaveTheDiskRoom(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	free := int64(1 << 20)
	e.bs.MinFree = 1<<20 - 100
	e.bs.Free = func(string) (int64, error) { return free, nil }
	s, b := e.upload(user, []byte("fits in the hundred bytes left"))
	expect(t, s, 200, b)
	free = 1<<20 - 90
	s, b = e.upload(user, []byte("would go below the floor"))
	expect(t, s, 507, b)
	if len(e.files()) != 1 {
		t.Fatalf("a refused upload left %v", e.files())
	}
}
