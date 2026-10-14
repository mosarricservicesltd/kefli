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
	"net"
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
	return &API{
		cfg: cfg, st: st, log: log, now: now, logKey: logKey,
		calls:  limit.New(60, time.Minute, now),
		pairs:  limit.New(30, time.Hour, now),
		regIP:  limit.New(5, 24*time.Hour, now),
		regBlk: limit.New(MaxBlockRegistrations, 24*time.Hour, now),
		misses: limit.New(MaxMisses, store.OfferLife, now),
		blkMis: limit.New(MaxBlockMisses, store.OfferLife, now),
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
	return limit.Addr(ClientIP(r, a.cfg.TrustProxy), 64)
}

// ClientIP is the caller's address: Caddy's X-Forwarded-For when trusted, else the connection's.
func ClientIP(r *http.Request, trustProxy bool) string {
	if trustProxy {
		if f := r.Header.Get("X-Forwarded-For"); f != "" {
			return strings.TrimSpace(strings.Split(f, ",")[0])
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// request is a NIP-98 request read and checked: its signer, its JSON body (if any), refused once its id is reused.
type request struct {
	pubkey string
	body   map[string]any
}

func (a *API) authed(w http.ResponseWriter, r *http.Request) (*request, bool) {
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
