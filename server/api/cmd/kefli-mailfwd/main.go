// kefli-mailfwd forwards the mail Resend receives for the operator's addresses to the operator's inbox
// (internal/mailfwd). It listens on loopback, behind Caddy's https://kefli.app/hooks/resend, and reads its settings
// from the environment:
//
//	RESEND_API_KEY          a Resend key with sending and receiving access
//	RESEND_WEBHOOK_SECRET   the email.received webhook's signing secret, whsec_…
//	KEFLI_MAILFWD_ADDR      where to listen (127.0.0.1:8449)
//	KEFLI_MAILFWD_ACCEPT    the addresses to forward, comma-separated (privacy@kefli.app)
//	KEFLI_MAILFWD_FROM      the forward's sender, on the verified domain
//	KEFLI_MAILFWD_TO        the inbox it goes to
package main

import (
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/mailfwd"
)

func main() {
	log.SetPrefix("kefli-mailfwd: ")
	log.SetFlags(0)
	cfg, addr, err := config(os.Getenv)
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/hooks/resend", mailfwd.Handler(cfg))
	log.Fatal(server(addr, mux).ListenAndServe())
}

// server bounds what one connection may hold: a webhook's body is under a megabyte, sent at once, where with no read
// timeout a body sent a byte at a time held its connection for ever, and anyone may connect.
func server(addr string, h http.Handler) *http.Server {
	return &http.Server{Addr: addr, Handler: h, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second,
		WriteTimeout: 2 * time.Minute, IdleTimeout: 2 * time.Minute, MaxHeaderBytes: 64 << 10}
}

func config(env func(string) string) (mailfwd.Config, string, error) {
	cfg := mailfwd.Config{
		APIKey:        env("RESEND_API_KEY"),
		WebhookSecret: env("RESEND_WEBHOOK_SECRET"),
		From:          env("KEFLI_MAILFWD_FROM"),
		To:            env("KEFLI_MAILFWD_TO"),
		APIBase:       "https://api.resend.com",
		Client:        &http.Client{Timeout: 60 * time.Second},
		Now:           time.Now,
	}
	for _, a := range strings.Split(env("KEFLI_MAILFWD_ACCEPT"), ",") {
		if a = strings.TrimSpace(a); a != "" {
			cfg.Accept = append(cfg.Accept, a)
		}
	}
	addr := env("KEFLI_MAILFWD_ADDR")
	if cfg.APIKey == "" || cfg.WebhookSecret == "" || cfg.From == "" || cfg.To == "" || len(cfg.Accept) == 0 || addr == "" {
		return cfg, "", errors.New("RESEND_API_KEY, RESEND_WEBHOOK_SECRET and every KEFLI_MAILFWD_ setting are required")
	}
	return cfg, addr, nil
}
