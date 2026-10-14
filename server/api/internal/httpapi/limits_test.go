package httpapi_test

import (
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/httpapi"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

func behindCaddy(c *httpapi.Config) { c.TrustProxy = true }

// F8: every address in an IPv6 /64 is one client's for free, so a /64 gets one address's 30 offers an hour.
func TestOffersCountAnIPv6BlockOnce(t *testing.T) {
	e := newEnv(t, behindCaddy)
	// spread over twenty minutes, so the block's ten misses in an offer's life aren't what stops it
	for i := 0; i < 30; i++ {
		e.clock = e.clock.Add(40 * time.Second)
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

// F8: one block of addresses (a tunnel broker's free /48, an IPv4 /24) spends at most MaxBlockMisses of everyone's
// misses in an offer's life, so it can't hold every second phone's setup up alone: its own lookups wait, and a right
// code from elsewhere is taken.
func TestPhoneOfferMissesFromOneBlock(t *testing.T) {
	e := newEnv(t, behindCaddy)
	user := newKey()
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	lookup := hash([]byte("the right code"))
	s, b := e.call(user, "POST", "/phone-offers", map[string]any{"v": 1, "lookup": lookup, "offer": "mnemonic"})
	expect(t, s, 200, b)
	for _, block := range []string{"2001:db8:5:%x::1", "198.51.100.%d"} {
		for i := 0; i < httpapi.MaxBlockMisses; i++ {
			e.from = fmt.Sprintf(block, i+1)
			s, b := e.call(newKey(), "GET", "/phone-offers/"+hash([]byte(fmt.Sprint(block, i))), nil)
			expect(t, s, 404, b)
		}
		e.from = fmt.Sprintf(block, 200)
		s, b = e.call(newKey(), "GET", "/phone-offers/"+lookup, nil)
		expect(t, s, 429, b)
	}
	e.from = "203.0.113.77"
	s, b = e.call(newKey(), "GET", "/phone-offers/"+lookup, nil)
	if s != 200 || b["offer"] != "mnemonic" {
		t.Fatalf("a right code from another block: %d %v", s, b)
	}
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

// F8: a tunnel broker's free /48 is 256 /56s, five accounts a day each; it is held to MaxBlockRegistrations a day, so
// one /48 can't hold everyone's hourly limit full for hours. An IPv4 /24 has no such limit, being many people's.
func TestRegistrationsFromOneBlock(t *testing.T) {
	e := newEnv(t, behindCaddy)
	for i := 0; i < httpapi.MaxBlockRegistrations; i++ {
		e.from = fmt.Sprintf("2001:db8:6:%x00::1", i/5+1)
		s, b := e.call(newKey(), "POST", "/register", map[string]any{"v": 1})
		expect(t, s, 200, b)
	}
	e.from = "2001:db8:6:ff00::1"
	s, b := e.call(newKey(), "POST", "/register", map[string]any{"v": 1})
	expect(t, s, 429, b)
	e.from = "2001:db8:7::1"
	s, b = e.call(newKey(), "POST", "/register", map[string]any{"v": 1})
	expect(t, s, 200, b)
	for i := 0; i < 25; i++ {
		e.from = fmt.Sprintf("192.0.2.%d", i+1)
		s, b := e.call(newKey(), "POST", "/register", map[string]any{"v": 1})
		expect(t, s, 200, b)
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

// Offers held were limited per /64 and per key only, and kept an hour, until the sweep: one IPv6 /48's 65,536 /64s at
// 30 each could post two million 8 KB offers an hour, 16 GB of database, from fresh keys (probe offerflood: 20,000
// taken from one /48 in two and a half minutes, 182 MB). Now one /48 posts MaxBlockOffers an hour, an IPv4 /24 being
// many people's as with registrations.
func TestOffersFromOneBlock(t *testing.T) {
	e := newEnv(t, behindCaddy)
	for i := 0; i < httpapi.MaxBlockOffers; i++ {
		e.from = fmt.Sprintf("2001:db8:9:%x::1", i/30)
		s, b := e.call(newKey(), "POST", "/pair-offers", map[string]any{"v": 1, "lookup": hash([]byte(fmt.Sprint("block ", i))), "offer": "o"})
		expect(t, s, 200, b)
	}
	e.from = "2001:db8:9:ffff::1"
	s, b := e.call(newKey(), "POST", "/pair-offers", map[string]any{"v": 1, "lookup": hash([]byte("one more")), "offer": "o"})
	expect(t, s, 429, b)
	if b["error"] != "rate" {
		t.Fatalf("refusal %v", b)
	}
	// a phone offer from the same /48 waits too; another /48 goes ahead
	user := newKey()
	e.from = "2001:db8:10::1"
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	e.from = "2001:db8:9:fffe::1"
	s, b = e.call(user, "POST", "/phone-offers", map[string]any{"v": 1, "lookup": hash([]byte("phone")), "offer": "o"})
	expect(t, s, 429, b)
	e.from = "2001:db8:10::1"
	e.clock = e.clock.Add(time.Second) // a fresh authorisation: the same one twice is a replay
	s, b = e.call(user, "POST", "/phone-offers", map[string]any{"v": 1, "lookup": hash([]byte("phone")), "offer": "o"})
	expect(t, s, 200, b)
	// an IPv4 /24 isn't one site: past MaxBlockOffers from its addresses, each still has its own 30
	for i := 0; i <= httpapi.MaxBlockOffers; i++ {
		e.from = fmt.Sprintf("198.51.100.%d", i/25+1)
		s, b := e.call(newKey(), "POST", "/pair-offers", map[string]any{"v": 1, "lookup": hash([]byte(fmt.Sprint("v4 ", i))), "offer": "o"})
		expect(t, s, 200, b)
	}
}

// Offers held at once had no ceiling, and expired ones stayed until the hourly sweep. Now at most MaxOffers are held
// (the shared ceiling an availability trade, as for registrations): past it every new offer waits, and the extension's
// pairing page and the phone show their offline state and try again; an expired offer goes as the next one comes.
func TestOffersHeldAtOnce(t *testing.T) {
	few := func(c *httpapi.Config) { c.TrustProxy, c.MaxOffers = true, 5 }
	e := newEnv(t, few)
	post := func(i int) (int, map[string]any) {
		e.from = fmt.Sprintf("192.0.2.%d", i+1)
		return e.call(newKey(), "POST", "/pair-offers", map[string]any{"v": 1, "lookup": hash([]byte(fmt.Sprint("held ", i))), "offer": "o"})
	}
	for i := 0; i < 5; i++ {
		s, b := post(i)
		expect(t, s, 200, b)
	}
	s, b := post(5)
	expect(t, s, 429, b)
	if b["error"] != "rate" {
		t.Fatalf("refusal %v", b)
	}
	e.clock = e.clock.Add(store.OfferLife)
	s, b = post(6)
	expect(t, s, 200, b)
	db, err := sql.Open("sqlite", "file:"+filepath.Join(e.dir, "k.db")+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM offers`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("%d offers kept (%v): the five expired ones should have gone", n, err)
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

// Every blob is a file, and the quota counts bytes: one account's 4-byte blobs used up a disk's inodes long before its
// quota or the floor on free space (probe tinyblobs: on a disk of 1,500 inodes, the 1,242nd upload and every one after
// it, anyone's, failed with 500, and so did every other writer on that disk). Uploads now keep a tenth of the disk's
// files free, as they keep MinFree of its bytes, and are refused with 507 past it, which clients try again later.
func TestUploadsLeaveTheDiskFiles(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.call(user, "POST", "/register", map[string]any{"v": 1})
	free, total := int64(101), int64(1000)
	e.bs.MinFree = 1
	e.bs.Free = func(string) (int64, error) { return 1 << 40, nil }
	e.bs.FreeFiles = func(string) (int64, int64, error) { return free, total, nil }
	s, b := e.upload(user, []byte("leaves a tenth of the files"))
	expect(t, s, 200, b)
	free = 100
	s, b = e.upload(user, []byte("would leave less"))
	expect(t, s, 507, b)
	if len(e.files()) != 1 {
		t.Fatalf("a refused upload left %v", e.files())
	}
	// a filesystem that makes inodes as it needs them reports none, and isn't held to any
	free, total = 0, 0
	s, b = e.upload(user, []byte("no inode count"))
	expect(t, s, 200, b)
}
