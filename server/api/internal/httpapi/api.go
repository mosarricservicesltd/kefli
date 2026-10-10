// Package httpapi is the operator HTTP API (contract 6): defaults.json, registration, device keys, the two pairing
// offers, account deletion and NIP-05. Every request except the two public documents carries NIP-98; every body is a
// JSON object with v; every answer is {"v":1,…}, and errors {"v":1,"error":…}, as the phone and extension read them.
package httpapi

import (
	"context"
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
}

const maxBody = 64 << 10

type API struct {
	cfg   Config
	st    *store.Store
	log   *slog.Logger
	now   func() time.Time
	calls *Limiter // per pubkey, 60 a minute (backend spec 3.3)
	pairs *Limiter // offers, 30 an hour per key and per address (contract 6)
	regIP *Limiter // registrations, 5 a day per address (backend spec 5)
}

func New(cfg Config, st *store.Store, log *slog.Logger) *API {
	now := st.Now
	return &API{
		cfg: cfg, st: st, log: log, now: now,
		calls: NewLimiter(60, time.Minute, now),
		pairs: NewLimiter(30, time.Hour, now),
		regIP: NewLimiter(5, 24*time.Hour, now),
	}
}

func (a *API) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /defaults.json", a.defaults)
	mux.HandleFunc("GET /.well-known/nostr.json", a.nip05)
	mux.HandleFunc("POST /register", a.register)
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

// short is a pubkey as the logs show it: 12 hex characters, never the whole key (backend spec 5).
func short(pubkey string) string {
	if len(pubkey) < 12 {
		return pubkey
	}
	return pubkey[:12]
}
