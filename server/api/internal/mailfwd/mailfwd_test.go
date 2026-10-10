package mailfwd

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

var (
	key    = []byte("a test signing key")
	secret = "whsec_" + base64.StdEncoding.EncodeToString(key)
	now    = time.Unix(1_790_000_000, 0)
)

func sign(id string, ts time.Time, body string) http.Header {
	mac := hmac.New(sha256.New, key)
	fmt.Fprintf(mac, "%s.%d.%s", id, ts.Unix(), body)
	h := http.Header{}
	h.Set("svix-id", id)
	h.Set("svix-timestamp", fmt.Sprint(ts.Unix()))
	h.Set("svix-signature", "v1,bm90IHRoaXMgb25l v1,"+base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	return h
}

func TestVerify(t *testing.T) {
	body := []byte(`{"type":"email.received"}`)
	if err := Verify(secret, sign("msg_1", now, string(body)), body, now); err != nil {
		t.Fatalf("a good signature failed: %v", err)
	}
	cases := map[string]struct {
		h    http.Header
		body string
	}{
		"tampered body": {sign("msg_1", now, string(body)), `{"type":"email.sent"}`},
		"stale":         {sign("msg_1", now.Add(-6*time.Minute), string(body)), string(body)},
		"no headers":    {http.Header{}, string(body)},
	}
	for name, c := range cases {
		if Verify(secret, c.h, []byte(c.body), now) == nil {
			t.Errorf("%s passed", name)
		}
	}
	if Verify("whsec_!!", sign("msg_1", now, string(body)), body, now) == nil {
		t.Error("a malformed secret passed")
	}
}

// fakeResend stands in for the Receiving, Attachments and Send APIs and the attachment store.
type fakeResend struct {
	mu        sync.Mutex
	sent      []outgoing
	keys      []string
	sendFails bool
	srv       *httptest.Server
}

func newFake(t *testing.T) *fakeResend {
	f := &fakeResend{}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeResend) serve(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/files/cv.pdf" {
		if r.Header.Get("Authorization") != "" {
			http.Error(w, "the key went to the file store", http.StatusBadRequest)
			return
		}
		io.WriteString(w, "%PDF")
		return
	}
	if r.Header.Get("Authorization") != "Bearer re_test" {
		http.Error(w, "no key", http.StatusUnauthorized)
		return
	}
	switch r.URL.Path {
	case "/emails/receiving/em_1":
		json.NewEncoder(w).Encode(received{From: "Ann <ann@example.org>", To: []string{"privacy@kefli.app"},
			Subject: "Delete my data", HTML: "<p>Please</p>", Text: "Please"})
	case "/emails/receiving/em_1/attachments":
		fmt.Fprintf(w, `{"data":[{"filename":"cv.pdf","content_type":"application/pdf","download_url":"%s/files/cv.pdf","size":4}]}`, f.srv.URL)
	case "/emails":
		f.send(w, r)
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeResend) send(w http.ResponseWriter, r *http.Request) {
	if f.sendFails {
		http.Error(w, "down", http.StatusServiceUnavailable)
		return
	}
	var out outgoing
	json.NewDecoder(r.Body).Decode(&out)
	f.mu.Lock()
	f.sent = append(f.sent, out)
	f.keys = append(f.keys, r.Header.Get("Idempotency-Key"))
	f.mu.Unlock()
	io.WriteString(w, `{"id":"sent_1"}`)
}

func post(t *testing.T, f *fakeResend, body string) int {
	cfg := Config{APIKey: "re_test", WebhookSecret: secret, From: "Kefli privacy <privacy@kefli.app>",
		To: "inbox@example.com", Accept: []string{"privacy@kefli.app"}, APIBase: f.srv.URL,
		Client: f.srv.Client(), Now: func() time.Time { return now }}
	req := httptest.NewRequest(http.MethodPost, "/hooks/resend", strings.NewReader(body))
	req.Header = sign("msg_1", now, body)
	rec := httptest.NewRecorder()
	Handler(cfg).ServeHTTP(rec, req)
	return rec.Code
}

func TestForwards(t *testing.T) {
	f := newFake(t)
	body := `{"type":"email.received","data":{"email_id":"em_1","to":["Privacy <PRIVACY@kefli.app>"]}}`
	if code := post(t, f, body); code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if len(f.sent) != 1 || f.keys[0] != "kefli-mailfwd/em_1" {
		t.Fatalf("sent %d, keys %v", len(f.sent), f.keys)
	}
	got := f.sent[0]
	if got.To[0] != "inbox@example.com" || got.ReplyTo[0] != "Ann <ann@example.org>" || got.Subject != "Delete my data" {
		t.Errorf("addressed wrongly: %+v", got)
	}
	if !strings.HasPrefix(got.Text, "From Ann <ann@example.org> to privacy@kefli.app") || !strings.Contains(got.HTML, "&lt;ann@example.org&gt;") {
		t.Errorf("no sender note: %q / %q", got.Text, got.HTML)
	}
	if len(got.Attachments) != 1 || got.Attachments[0].Content != base64.StdEncoding.EncodeToString([]byte("%PDF")) {
		t.Errorf("attachments %+v", got.Attachments)
	}
}

func TestDropsAndRejects(t *testing.T) {
	f := newFake(t)
	cases := map[string]struct {
		body string
		want int
	}{
		"other address": {`{"type":"email.received","data":{"email_id":"em_1","to":["sales@kefli.app"]}}`, http.StatusNoContent},
		"other event":   {`{"type":"email.sent","data":{"email_id":"em_1"}}`, http.StatusNoContent},
		"not json":      {`nope`, http.StatusBadRequest},
		"unknown email": {`{"type":"email.received","data":{"email_id":"em_2","received_for":["privacy@kefli.app"]}}`, http.StatusBadGateway},
	}
	for name, c := range cases {
		if code := post(t, f, c.body); code != c.want {
			t.Errorf("%s: status %d, want %d", name, code, c.want)
		}
	}
	if len(f.sent) != 0 {
		t.Errorf("sent %d", len(f.sent))
	}
}

func TestSendFailureRetries(t *testing.T) {
	f := newFake(t)
	f.sendFails = true
	body := `{"type":"email.received","data":{"email_id":"em_1","cc":["privacy@kefli.app"]}}`
	if code := post(t, f, body); code != http.StatusBadGateway {
		t.Fatalf("status %d", code)
	}
}

func TestBadRequests(t *testing.T) {
	cfg := Config{WebhookSecret: secret, Now: func() time.Time { return now }}
	rec := httptest.NewRecorder()
	Handler(cfg).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/hooks/resend", nil))
	if rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("GET: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	Handler(cfg).ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/hooks/resend", strings.NewReader("{}")))
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("unsigned: %d", rec.Code)
	}
}
