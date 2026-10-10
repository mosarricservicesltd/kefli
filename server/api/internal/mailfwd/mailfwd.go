// Package mailfwd forwards mail that Resend receives for the operator's addresses (privacy@kefli.app) to the operator's
// own inbox. Resend calls the handler with an email.received webhook, signed the Svix way; the handler fetches the
// message and its attachments from Resend's Receiving API and sends them on with the Send API, from the verified domain,
// with Reply-To set to the original sender. The email's id is the send's idempotency key, so Resend's webhook retries
// never deliver a message twice. Nothing about a message is logged beyond its id and the outcome.
package mailfwd

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"
)

// Config is what the forwarder needs. Accept holds the addresses whose mail is forwarded, in any case; mail for any
// other address on the domain is acknowledged and dropped.
type Config struct {
	APIKey        string
	WebhookSecret string // whsec_…, from the webhook's page in Resend
	From          string // a sender on the verified domain, e.g. "Kefli privacy <privacy@kefli.app>"
	To            string
	Accept        []string
	APIBase       string // https://api.resend.com
	Client        *http.Client
	Now           func() time.Time
}

const (
	maxWebhook     = 1 << 20
	maxAttachments = 30 << 20 // under the Send API's 40 MB, after base64
	tolerance      = 5 * time.Minute
)

type event struct {
	Type string `json:"type"`
	Data struct {
		EmailID     string   `json:"email_id"`
		To          []string `json:"to"`
		Cc          []string `json:"cc"`
		ReceivedFor []string `json:"received_for"`
	} `json:"data"`
}

// Handler serves the webhook. A bad signature is 401; a failure to forward is 502, so Resend tries again later.
func Handler(cfg Config) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, maxWebhook))
		if err != nil || Verify(cfg.WebhookSecret, r.Header, body, cfg.Now()) != nil {
			http.Error(w, "unauthorised", http.StatusUnauthorized)
			return
		}
		var ev event
		if err := json.Unmarshal(body, &ev); err != nil {
			http.Error(w, "bad event", http.StatusBadRequest)
			return
		}
		status := handle(r, cfg, ev)
		w.WriteHeader(status)
	})
}

func handle(r *http.Request, cfg Config, ev event) int {
	if ev.Type != "email.received" || ev.Data.EmailID == "" {
		return http.StatusNoContent
	}
	if !accepted(cfg.Accept, ev.Data.To, ev.Data.Cc, ev.Data.ReceivedFor) {
		log.Printf("%s: not for a forwarded address, dropped", ev.Data.EmailID)
		return http.StatusNoContent
	}
	c := client{cfg: cfg, req: r}
	if err := c.forward(ev.Data.EmailID); err != nil {
		log.Printf("%s: not forwarded: %v", ev.Data.EmailID, err)
		return http.StatusBadGateway
	}
	log.Printf("%s: forwarded", ev.Data.EmailID)
	return http.StatusOK
}

// Verify checks a Svix signature: HMAC-SHA256, keyed with the secret's base64 after "whsec_", over
// "id.timestamp.body", matching any "v1," entry in svix-signature, with the timestamp within five minutes of now.
func Verify(secret string, h http.Header, body []byte, now time.Time) error {
	id, ts, sigs := h.Get("svix-id"), h.Get("svix-timestamp"), h.Get("svix-signature")
	if id == "" || ts == "" || sigs == "" {
		return errors.New("missing signature headers")
	}
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil || now.Sub(time.Unix(sec, 0)).Abs() > tolerance {
		return errors.New("timestamp out of range")
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimPrefix(secret, "whsec_"))
	if err != nil {
		return errors.New("bad secret")
	}
	mac := hmac.New(sha256.New, key)
	fmt.Fprintf(mac, "%s.%s.%s", id, ts, body)
	want := mac.Sum(nil)
	for _, s := range strings.Fields(sigs) {
		got, ok := strings.CutPrefix(s, "v1,")
		if ok && hmac.Equal([]byte(got), []byte(base64.StdEncoding.EncodeToString(want))) {
			return nil
		}
	}
	return errors.New("no matching signature")
}

func accepted(accept []string, lists ...[]string) bool {
	for _, list := range lists {
		for _, a := range list {
			for _, ok := range accept {
				if strings.EqualFold(bare(a), ok) {
					return true
				}
			}
		}
	}
	return false
}

// bare turns "Name <a@b>" into "a@b"; anything it can't parse is compared as given.
func bare(addr string) string {
	if a, err := mail.ParseAddress(addr); err == nil {
		return a.Address
	}
	return strings.TrimSpace(addr)
}
