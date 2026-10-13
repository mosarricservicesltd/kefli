package httpapi

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/auth"
	"github.com/richardminton-glitch/Kefli/server/api/internal/limit"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

func (a *API) defaults(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_, _ = w.Write(a.cfg.Defaults)
}

// nip05 answers for the operator's own names only (contract 6; user names are v2).
func (a *API) nip05(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	names := map[string]any{}
	relays := map[string]any{}
	if pk, ok := a.cfg.Names[name]; ok {
		names[name] = pk
		relays[pk] = a.cfg.Relays
	}
	w.Header().Set("Content-Type", "application/json")
	reply(w, http.StatusOK, map[string]any{"names": names, "relays": relays})
}

// register adds the caller to the allowlist with the default quota; idempotent (contract 6). Five a day per address,
// and cfg.MaxRegistrations an hour from everyone.
func (a *API) register(w http.ResponseWriter, r *http.Request) {
	req, ok := a.authed(w, r)
	if !ok {
		return
	}
	if _, known, _ := a.st.Account(r.Context(), req.pubkey); !known && !a.newAccountAllowed(w, r) {
		return
	}
	if err := a.st.Register(r.Context(), req.pubkey); err != nil {
		a.serverError(w, err)
		return
	}
	used, _ := a.st.Used(r.Context(), req.pubkey)
	a.log.Info("registered", "user", a.short(req.pubkey))
	reply(w, http.StatusOK, map[string]any{"v": 1, "quota": store.DefaultQuota, "used": used})
}

// deleteAccount is idempotent: a caller with no account still gets 200, so a retry after a lost answer succeeds.
func (a *API) deleteAccount(w http.ResponseWriter, r *http.Request) {
	req, ok := a.authed(w, r)
	if !ok {
		return
	}
	orphaned, err := a.st.DeleteAccount(r.Context(), req.pubkey)
	if err != nil {
		a.serverError(w, err)
		return
	}
	a.unlink(orphaned)
	a.log.Info("account deleted", "user", a.short(req.pubkey), "blobs", len(orphaned))
	reply(w, http.StatusOK, map[string]any{"v": 1, "deleted": map[string]any{"blobs": len(orphaned)}})
}

// newAccountAllowed holds new accounts to five a day per address, a home line's whole /56 counting as one, and to
// cfg.MaxRegistrations an hour from everyone together. The hourly count is the accounts table's, so a restart
// doesn't reset it (F8).
func (a *API) newAccountAllowed(w http.ResponseWriter, r *http.Request) bool {
	recent, err := a.st.Registrations(r.Context(), a.now().Add(-time.Hour))
	if err != nil {
		a.serverError(w, err)
		return false
	}
	if recent >= a.cfg.MaxRegistrations {
		w.Header().Set("Retry-After", retryAfter(5*time.Minute))
		fail(w, http.StatusTooManyRequests, "rate")
		return false
	}
	if ok, retry := a.regIP.Allow(limit.Addr(ClientIP(r, a.cfg.TrustProxy), 56)); !ok {
		w.Header().Set("Retry-After", retryAfter(retry))
		fail(w, http.StatusTooManyRequests, "rate")
		return false
	}
	// the backend spec's alert, in the journal until monitoring reads it
	if recent+1 == a.cfg.MaxRegistrations {
		a.log.Error("registrations held: the hourly limit is reached", "limit", a.cfg.MaxRegistrations)
	}
	return true
}

func (a *API) unlink(shas []string) {
	if a.cfg.Unlink == nil {
		return
	}
	for _, s := range shas {
		a.cfg.Unlink(s)
	}
}

// addDevice authorises a device key to upload against the caller's quota (contract 4.4, 6).
func (a *API) addDevice(w http.ResponseWriter, r *http.Request) {
	req, ok := a.authed(w, r)
	if !ok || !a.registered(w, r, req.pubkey) {
		return
	}
	// a label older phones still send is ignored, never stored: the privacy page lists nothing about browsers (F30)
	device, _ := req.body["device_pubkey"].(string)
	if !auth.IsHex64(device) || device == req.pubkey {
		fail(w, http.StatusBadRequest, "device")
		return
	}
	if err := a.st.AddDevice(r.Context(), req.pubkey, device); err != nil {
		a.serverError(w, err)
		return
	}
	a.log.Info("device added", "user", a.short(req.pubkey), "device", a.short(device))
	reply(w, http.StatusOK, map[string]any{"v": 1})
}

// removeDevice revokes a device and deletes its unexpired inbox blobs (contract 6).
func (a *API) removeDevice(w http.ResponseWriter, r *http.Request) {
	req, ok := a.authed(w, r)
	if !ok {
		return
	}
	found, orphaned, err := a.st.RemoveDevice(r.Context(), req.pubkey, r.PathValue("device"))
	if err != nil {
		a.serverError(w, err)
		return
	}
	if !found {
		fail(w, http.StatusNotFound, "not_found")
		return
	}
	a.unlink(orphaned)
	reply(w, http.StatusOK, map[string]any{"v": 1})
}

// postOffer holds a pairing offer for five minutes (contract 6). A pair offer comes from an extension's device key,
// which needn't be authorised yet; a phone offer comes from a registered user. Both are limited to 30 an hour per key
// and per address.
func (a *API) postOffer(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		req, ok := a.authed(w, r)
		if !ok || (kind == "phone" && !a.registered(w, r, req.pubkey)) || !a.offerAllowed(w, r, req.pubkey) {
			return
		}
		lookup, _ := req.body["lookup"].(string)
		offer, _ := req.body["offer"].(string)
		if !auth.IsHex64(lookup) || offer == "" || len(offer) > 8192 {
			fail(w, http.StatusBadRequest, "offer")
			return
		}
		err := a.st.PutOffer(r.Context(), kind, lookup, offer)
		if errors.Is(err, store.ErrTaken) {
			fail(w, http.StatusConflict, "taken")
			return
		}
		if err != nil {
			a.serverError(w, err)
			return
		}
		reply(w, http.StatusOK, map[string]any{"v": 1})
	}
}

// offerAllowed counts an offer request against its address and then its key: the address first, so a request the
// address limit refuses leaves no window behind for a throwaway key (F45).
func (a *API) offerAllowed(w http.ResponseWriter, r *http.Request, pubkey string) bool {
	for _, key := range []string{"ip:" + a.clientAddr(r), "key:" + pubkey} {
		if ok, retry := a.pairs.Allow(key); !ok {
			w.Header().Set("Retry-After", retryAfter(retry))
			fail(w, http.StatusTooManyRequests, "rate")
			return false
		}
	}
	return true
}

// getOffer returns an unexpired offer. A pair offer is read by a registered user, the phone; a phone offer by any key,
// since the phone fetching it has no identity yet, and only once, limited to 30 an hour per address (contract 6) and
// refused for the rest of an offer's life once MaxMisses lookups from anyone have found nothing in it (F8).
func (a *API) getOffer(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		req, ok := a.authed(w, r)
		if !ok {
			return
		}
		if kind == "pair" && !a.registered(w, r, req.pubkey) {
			return
		}
		if kind == "phone" && (!a.offerAllowed(w, r, req.pubkey) || !a.guessesLeft(w)) {
			return
		}
		lookup := r.PathValue("lookup")
		offer, found, err := a.st.TakeOffer(r.Context(), kind, strings.ToLower(lookup), kind == "phone")
		if err != nil {
			a.serverError(w, err)
			return
		}
		if !found {
			if kind == "phone" {
				a.missed()
			}
			fail(w, http.StatusNotFound, "not_found")
			return
		}
		reply(w, http.StatusOK, map[string]any{"v": 1, "offer": offer})
	}
}

// guessesLeft refuses a phone-offer lookup while the last five minutes' misses are at MaxMisses: past that, a
// right code waits too, since nothing tells a right guess from a wrong one before the lookup.
func (a *API) guessesLeft(w http.ResponseWriter) bool {
	spent, retry := a.misses.Spent("phone")
	if spent {
		w.Header().Set("Retry-After", retryAfter(retry))
		fail(w, http.StatusTooManyRequests, "rate")
	}
	return !spent
}

// missed counts a phone-offer lookup that found nothing, and says so in the log once the misses reach the limit.
func (a *API) missed() {
	a.misses.Allow("phone")
	if spent, retry := a.misses.Spent("phone"); spent {
		a.log.Error("phone-offer lookups held: too many found nothing", "limit", MaxMisses, "for", retry.Round(time.Second))
	}
}
