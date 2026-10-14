// Package httpapi is the operator HTTP API (contract 6): defaults.json, registration, the library's fair-use figures,
// device keys, the two pairing offers, account deletion and NIP-05. Every request except the two public documents
// carries NIP-98; every body is a JSON object with v; every answer is {"v":1,…}, and errors {"v":1,"error":…}, as the
// phone and extension read them.
package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/nbd-wtf/go-nostr"
	"github.com/richardminton-glitch/Kefli/server/api/internal/auth"
	"github.com/richardminton-glitch/Kefli/server/api/internal/limit"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// Config is what the API needs to know about where it runs.
type Config struct {
	// Base is the public address requests are signed for, such as https://api.kefli.app; NIP-98's u must equal Base plus
	// the path exactly.
	Base string
	// Defaults is defaults.json as served (contract 3.1).
	Defaults []byte
	// Names is NIP-05 for the operator's own identity in v1: name to hex pubkey, with Relays for every name.
	Names  map[string]string
	Relays []string
	// TrustProxy reads the client's address from X-Forwarded-For, set by Caddy in front.
	TrustProxy bool
	// Blobs forgets files no owner holds any longer (the Blossom side unlinks them).
	Unlink func(sha string)
	// MaxRegistrations is how many new accounts an hour the API takes from everyone together (DefaultMaxRegistrations
	// when 0), so a caller with many addresses still can't make accounts without end (F8).
	MaxRegistrations int
	// MaxOffers is how many pairing offers the API holds at once, pair and phone offers together (DefaultMaxOffers when
	// 0), so offers posted from many addresses can't fill the disk.
	MaxOffers int
}

// DefaultMaxRegistrations is backend spec 5's alert level, 200 new accounts an hour, held as a limit.
const DefaultMaxRegistrations = 200

// MaxMisses is how many phone-offer lookups may find nothing in five minutes, an offer's life, from every caller
// together. Each address is held to 30 an hour, but someone with many addresses could otherwise try a large share of
// the million codes while an offer waits. An offer's five minutes span at most two windows, so this keeps the share
// to two in ten thousand (F8, contract 2).
const MaxMisses = 100

// MaxBlockMisses is how many of those MaxMisses one block of addresses (an IPv4 /24, an IPv6 /48) may spend in an
// offer's life: past it, that block's lookups wait, and nobody else's, so filling the shared count takes ten blocks in
// every five minutes rather than one tunnel's addresses (F8). A person mistyping a code misses once or twice.
const MaxBlockMisses = 10

// MaxBlockRegistrations is how many new accounts a day one IPv6 /48 may make, beside the five a day per /56: a
// tunnel broker hands out a /48 free, 256 /56s, which could otherwise hold MaxRegistrations full for hours a day.
// IPv4 has no such limit, since a carrier's shared addresses sit many people in one /24, and each address already
// costs its owner something.
const MaxBlockRegistrations = 20

// DefaultMaxOffers is how many offers are held at once from everyone: each is at most maxOffer bytes, so 80 MB at
// most, where pairings in progress in any five minutes number a few hundred at the most.
const DefaultMaxOffers = 10_000

// MaxBlockOffers is how many offers an hour one IPv6 /48 may post, beside the 30 per /64 and per key: a /48 is 65,536
// /64s, which could otherwise post two million offers an hour, and hold DefaultMaxOffers full alone. It is four /64s'
// worth; an IPv4 /24 has no such limit, being many people's, and each address costs its owner something.
const MaxBlockOffers = 120

// MaxAddressCalls is how many API requests one address (an IPv6 /64) makes a minute, counted before anything is read
// or verified: any key may call DELETE /account or DELETE /devices, so a fresh key per request goes round every limit
// per key. The phone calls the API a handful of times in its life (registration, each Connect and Disconnect, a second
// phone), so a carrier's address shared by thousands stays far below it.
const MaxAddressCalls = 600

// MaxBlockCalls is the same a minute for one IPv6 /48, whose 65,536 /64s would otherwise each make MaxAddressCalls.
const MaxBlockCalls = 3000

// MaxDevices is how many device keys one library may have authorised at once. Each is a wrap recipient on the relay,
// and the write policy holds every one in memory; the phone's connected-browsers record (contract 4.9) holds about 42
// under the 16 KB ceiling, so this leaves room for rows a Disconnect hasn't reached yet.
const MaxDevices = 64

// MaxDeviceAdds is how many browser keys one library may connect a day, beside MaxDevices at once. A browser's proof
// costs nothing to make, and each Disconnect lists the browser as gone for store.GoneLife, 60 days, a row that every
// nightly relay sweep and the write policy's hourly prune read (F45): connecting and disconnecting fresh keys within
// the API's 60 calls a minute, one library put 43,200 on the list a day. A user connects a browser now and then and a
// move connects the library's browsers once, so twice MaxDevices a day is a full set replaced and moved in one day.
const MaxDeviceAdds = 2 * MaxDevices

// maxOffer is the largest offer taken: a pair offer sealed as the extension makes it is under 1 KB, a phone offer
// under 300 bytes.
const maxOffer = 8192

const maxBody = 64 << 10

type API struct {
	cfg    Config
	st     *store.Store
	log    *slog.Logger
	now    func() time.Time
	calls  *limit.Limiter // per pubkey, 60 a minute (backend spec 3.3)
	pairs  *limit.Limiter // offers, 30 an hour per key and per address (contract 6)
	regIP  *limit.Limiter // registrations, 5 a day per address, an IPv6 line by its /56 (backend spec 5)
	regBlk *limit.Limiter // registrations, MaxBlockRegistrations a day per IPv6 /48
	misses *limit.Limiter // phone-offer lookups that found nothing, MaxMisses an offer's life from everyone
	blkMis *limit.Limiter // the same, MaxBlockMisses an offer's life per block of addresses
	offBlk *limit.Limiter // offers posted, MaxBlockOffers an hour per IPv6 /48
	adrCal *limit.Limiter // requests, MaxAddressCalls a minute per address, before anything is read
	blkCal *limit.Limiter // the same, MaxBlockCalls a minute per IPv6 /48
	devAdd *limit.Limiter // browsers connected, MaxDeviceAdds a day per library
	// logKey keys the fingerprints the logs show for pubkeys (short)
	logKey []byte
}

func New(cfg Config, st *store.Store, log *slog.Logger) *API {
	now := st.Now
	logKey := make([]byte, 32)
	if _, err := rand.Read(logKey); err != nil {
		panic(err) // crypto/rand never fails on Linux
	}
	if cfg.MaxRegistrations == 0 {
		cfg.MaxRegistrations = DefaultMaxRegistrations
	}
	if cfg.MaxOffers == 0 {
		cfg.MaxOffers = DefaultMaxOffers
	}
	return &API{
		cfg: cfg, st: st, log: log, now: now, logKey: logKey,
		calls:  limit.New(60, time.Minute, now),
		pairs:  limit.New(30, time.Hour, now),
		regIP:  limit.New(5, 24*time.Hour, now),
		regBlk: limit.New(MaxBlockRegistrations, 24*time.Hour, now),
		misses: limit.New(MaxMisses, store.OfferLife, now),
		blkMis: limit.New(MaxBlockMisses, store.OfferLife, now),
		offBlk: limit.New(MaxBlockOffers, time.Hour, now),
		adrCal: limit.New(MaxAddressCalls, time.Minute, now),
		blkCal: limit.New(MaxBlockCalls, time.Minute, now),
		devAdd: limit.New(MaxDeviceAdds, 24*time.Hour, now),
	}
}

func (a *API) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /defaults.json", a.defaults)
	mux.HandleFunc("GET /.well-known/nostr.json", a.nip05)
	mux.HandleFunc("POST /register", a.register)
	mux.HandleFunc("GET /account", a.account)
	mux.HandleFunc("DELETE /account", a.deleteAccount)
	mux.HandleFunc("POST /devices", a.addDevice)
	mux.HandleFunc("DELETE /devices/{device}", a.removeDevice)
	mux.HandleFunc("POST /pair-offers", a.postOffer("pair"))
	mux.HandleFunc("GET /pair-offers/{lookup}", a.getOffer("pair"))
	mux.HandleFunc("POST /phone-offers", a.postOffer("phone"))
	mux.HandleFunc("GET /phone-offers/{lookup}", a.getOffer("phone"))
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) { reply(w, 200, map[string]any{"v": 1}) })
}

// CORS on every answer, so the browser extension needs no host permissions (extension spec 15); NIP-98 rides in
// Authorization, so its requests are preflighted.
func CORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-SHA-256, X-Content-Length, X-Content-Type")
		h.Set("Access-Control-Max-Age", "600")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func reply(w http.ResponseWriter, status int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func fail(w http.ResponseWriter, status int, why string) {
	reply(w, status, map[string]any{"v": 1, "error": why})
}

// clientAddr is the address the caller is counted as by a limit: an IPv6 caller by its /64 (F8).
func (a *API) clientAddr(r *http.Request) string {
	return limit.Addr(limit.ClientIP(r, a.cfg.TrustProxy), 64)
}

// request is a NIP-98 request read and checked: its signer, its JSON body (if any), refused once its id is reused.
type request struct {
	pubkey string
	body   map[string]any
}

func (a *API) authed(w http.ResponseWriter, r *http.Request) (*request, bool) {
	if !a.callAllowed(w, r) {
		return nil, false
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil || len(raw) > maxBody {
		fail(w, http.StatusRequestEntityTooLarge, "too_large")
		return nil, false
	}
	ev, err := auth.HTTP(r.Header.Get("Authorization"), a.cfg.Base+r.URL.RequestURI(), r.Method, raw, a.now())
	if err == nil && !a.fresh(r.Context(), ev) {
		err = auth.Replayed
	}
	if err != nil {
		fail(w, http.StatusUnauthorized, authWord(err))
		return nil, false
	}
	if ok, retry := a.calls.Allow(ev.PubKey); !ok {
		w.Header().Set("Retry-After", retryAfter(retry))
		fail(w, http.StatusTooManyRequests, "rate")
		return nil, false
	}
	return a.parsed(w, ev, raw)
}

// callAllowed counts a request against its IPv6 /48, then its address, before its body is read or its signature
// checked, so a flood from one place costs a map lookup each.
func (a *API) callAllowed(w http.ResponseWriter, r *http.Request) bool {
	ip := limit.ClientIP(r, a.cfg.TrustProxy)
	var counts []func() (bool, time.Duration)
	if block := limit.Block(ip); strings.Contains(block, ":") {
		counts = append(counts, func() (bool, time.Duration) { return a.blkCal.Allow(block) })
	}
	counts = append(counts, func() (bool, time.Duration) { return a.adrCal.Allow(limit.Addr(ip, 64)) })
	for _, allow := range counts {
		if ok, retry := allow(); !ok {
			w.Header().Set("Retry-After", retryAfter(retry))
			fail(w, http.StatusTooManyRequests, "rate")
			return false
		}
	}
	return true
}

func (a *API) fresh(ctx context.Context, ev *nostr.Event) bool {
	ok, err := a.st.UseAuth(ctx, ev.ID, ev.CreatedAt.Time().Add(2*auth.Window).Unix())
	return err == nil && ok
}

func (a *API) parsed(w http.ResponseWriter, ev *nostr.Event, raw []byte) (*request, bool) {
	req := &request{pubkey: ev.PubKey}
	if len(raw) == 0 {
		return req, true
	}
	if err := json.Unmarshal(raw, &req.body); err != nil || req.body["v"] != float64(1) {
		fail(w, http.StatusBadRequest, "body")
		return nil, false
	}
	return req, true
}

func authWord(err error) string {
	var f auth.Failure
	if errors.As(err, &f) {
		return "auth: " + string(f)
	}
	return "auth"
}

// retryAfter is Retry-After's whole seconds, rounded up.
func retryAfter(d time.Duration) string {
	return strconv.Itoa(int(d.Seconds()) + 1)
}

// registered refuses a caller who isn't a registered, enabled user.
func (a *API) registered(w http.ResponseWriter, r *http.Request, pubkey string) bool {
	_, ok, err := a.st.Account(r.Context(), pubkey)
	if err != nil {
		a.serverError(w, err)
		return false
	}
	if !ok {
		fail(w, http.StatusForbidden, "not_registered")
	}
	return ok
}

func (a *API) serverError(w http.ResponseWriter, err error) {
	a.log.Error("request failed", "err", err)
	fail(w, http.StatusInternalServerError, "server")
}

// short is a pubkey as the logs show it (backend spec 5, F30): 12 hex characters of an HMAC under a key made at
// each start and never written, so a log line can be followed within a run but never leads back to the key, which
// the privacy page promises ("a short, one-way fingerprint ... never the identifier itself").
func (a *API) short(pubkey string) string {
	m := hmac.New(sha256.New, a.logKey)
	m.Write([]byte(pubkey))
	return hex.EncodeToString(m.Sum(nil))[:12]
}
