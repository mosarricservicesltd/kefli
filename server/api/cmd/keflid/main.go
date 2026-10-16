// keflid is the operator's API and blob store (backend spec 2): the HTTP API of contract 6 on one address and the
// Blossom server of contract 5 on another, Caddy putting api.<domain> and blossom.<domain> in front of each, one SQLite
// database between them. Configuration is the environment:
//
//	KEFLID_DB           SQLite file (keflid.db)
//	KEFLID_BLOBS        blob directory (blobs)
//	KEFLID_API_ADDR     API listen address (127.0.0.1:8447)
//	KEFLID_BLOSSOM_ADDR Blossom listen address (127.0.0.1:3447)
//	KEFLID_API_BASE     the API's public address, which NIP-98's u names (https://api.<domain>)
//	KEFLID_BLOSSOM_BASE the blob store's public address (https://blossom.<domain>)
//	KEFLID_DEFAULTS     defaults.json to serve (defaults.json)
//	KEFLID_NIP05        optional JSON {"names":{"_":"<hex>"},"relays":["wss://…"]}
//	KEFLID_TRUST_PROXY  "1" behind Caddy, so the client's address is read from X-Forwarded-For
//	KEFLID_MIN_FREE_MB  space an upload must leave free on the blobs' disk, in MB (4096); 0 sets no floor
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/blossom"
	"github.com/richardminton-glitch/Kefli/server/api/internal/guard"
	"github.com/richardminton-glitch/Kefli/server/api/internal/httpapi"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}

type nip05 struct {
	Names  map[string]string `json:"names"`
	Relays []string          `json:"relays"`
}

func readNames(path string) (nip05, error) {
	var n nip05
	if path == "" {
		return n, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return n, err
	}
	return n, json.Unmarshal(raw, &n)
}

// readDefaults loads defaults.json and checks it parses as contract 3.1's v1, so a broken file stops the start.
func readDefaults(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if !validDefaults(raw) {
		return nil, fmt.Errorf("%s isn't a v1 defaults.json", path)
	}
	return raw, nil
}

func validDefaults(raw []byte) bool {
	var d struct {
		V        int `json:"v"`
		Operator struct {
			Relay, Blossom, API string
		} `json:"operator"`
	}
	if json.Unmarshal(raw, &d) != nil || d.V != 1 {
		return false
	}
	return d.Operator.Relay != "" && d.Operator.Blossom != "" && d.Operator.API != ""
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, log); err != nil {
		log.Error("keflid stopped", "err", err)
		os.Exit(1)
	}
}

// run serves until ctx ends, then shuts both servers down.
func run(ctx context.Context, log *slog.Logger) error {
	defaults, err := readDefaults(env("KEFLID_DEFAULTS", "defaults.json"))
	if err != nil {
		return err
	}
	names, err := readNames(os.Getenv("KEFLID_NIP05"))
	if err != nil {
		return err
	}
	st, err := store.Open(env("KEFLID_DB", "keflid.db"))
	if err != nil {
		return err
	}
	defer st.Close()

	minFree, err := strconv.ParseInt(env("KEFLID_MIN_FREE_MB", "4096"), 10, 64)
	if err != nil || minFree < 0 {
		return fmt.Errorf("KEFLID_MIN_FREE_MB isn't a number of megabytes")
	}
	trustProxy := os.Getenv("KEFLID_TRUST_PROXY") == "1"
	blobs := blossom.New(env("KEFLID_BLOBS", "blobs"), env("KEFLID_BLOSSOM_BASE", "http://localhost:3447"), st, log)
	blobs.MinFree = minFree << 20
	blobs.TrustProxy = trustProxy
	api := httpapi.New(httpapi.Config{
		Base: env("KEFLID_API_BASE", "http://localhost:8447"), Defaults: defaults, Names: names.Names, Relays: names.Relays,
		TrustProxy: trustProxy, Unlink: blobs.Unlink,
	}, st, log)

	apiMux, blobMux := http.NewServeMux(), http.NewServeMux()
	api.Routes(apiMux)
	blobs.Routes(blobMux)
	// one guard for both servers, so a client's requests in flight count together
	g := guard.New(trustProxy)
	servers := []*http.Server{
		server(env("KEFLID_API_ADDR", "127.0.0.1:8447"), g, httpapi.CORS(apiMux)),
		server(env("KEFLID_BLOSSOM_ADDR", "127.0.0.1:3447"), g, httpapi.CORS(blobMux)),
	}
	go sweep(ctx, st, blobs, log)
	return serve(ctx, servers, log)
}

// maxHeader is the most header a request may carry: a NIP-98 or Blossom authorisation is under a kilobyte and a
// request's headers under 4 KB, where Go's default megabyte a request let a few hundred at once take 120 MB.
const maxHeader = 64 << 10

// server serves h behind g, which holds every request's body to its pace and gives each answer its own time to be
// written, and which takes the place of a ReadTimeout: two minutes from the request's start, one cut an 8 MB upload
// on any link slower than about 550 kbps, where the phone waits four and a half minutes for it, and left a body that
// no route read keeping keflid for all of it. WriteTimeout bounds the writes before an answer begins, as of a 100
// Continue. A request's headers have 10 seconds and 64 KB, and a connection may idle for two minutes between them.
func server(addr string, g *guard.Guard, h http.Handler) *http.Server {
	return &http.Server{Addr: addr, Handler: g.Wrap(h), ReadHeaderTimeout: 10 * time.Second, WriteTimeout: g.Answer, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: maxHeader}
}

func serve(ctx context.Context, servers []*http.Server, log *slog.Logger) error {
	errs := make(chan error, len(servers))
	for _, s := range servers {
		go func() {
			log.Info("listening", "addr", s.Addr)
			if err := s.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
				errs <- err
			}
		}()
	}
	select {
	case err := <-errs:
		return err
	case <-ctx.Done():
	}
	shut, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.Shutdown(shut)
	}
	return nil
}

// sweep, hourly until ctx ends.
func sweep(ctx context.Context, st *store.Store, blobs *blossom.Server, log *slog.Logger) {
	tick := time.NewTicker(time.Hour)
	defer tick.Stop()
	for {
		if err := sweepOnce(ctx, st, blobs); err != nil {
			log.Error("sweep", "err", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
	}
}

// sweepOnce: inbox blobs past their 14 days go (contract 5), and so do expired offers and used authorisation ids,
// then blob files no owner holds and stale upload temporaries (F2).
func sweepOnce(ctx context.Context, st *store.Store, blobs *blossom.Server) error {
	orphaned, err := st.ExpireInbox(ctx)
	for _, sha := range orphaned {
		blobs.Unlink(sha)
	}
	if err != nil {
		return err
	}
	if err := st.Sweep(ctx); err != nil {
		return err
	}
	_, err = blobs.SweepFiles(ctx, st.Now())
	return err
}
