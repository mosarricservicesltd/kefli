package httpapi_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/blossom"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

// sendWhole uploads body as a client that sends the whole request before it reads anything, as the phone's HTTP client
// (OkHttp 4.9.2) does: half the body, a pause as a slow line would make, the rest, and only then the answer. expect is
// sent as the Expect header when it isn't empty. It returns the answer, or why there was none.
func (e *env) sendWhole(k key, body []byte, pause time.Duration, expect string) (*http.Response, []byte, error) {
	sha := hash(body)
	host := strings.TrimPrefix(e.blob.URL, "http://")
	conn, err := net.Dial("tcp", host)
	if err != nil {
		return nil, nil, err
	}
	defer conn.Close()
	head := fmt.Sprintf("PUT /upload HTTP/1.1\r\nHost: %s\r\nAuthorization: %s\r\nX-SHA-256: %s\r\nContent-Type: application/octet-stream\r\nContent-Length: %d\r\n",
		host, e.blossomAuth(k, "upload", sha), sha, len(body))
	if expect != "" {
		head += "Expect: " + expect + "\r\n"
	}
	half := len(body) / 2
	if _, err := conn.Write(append([]byte(head+"\r\n"), body[:half]...)); err != nil {
		return nil, nil, fmt.Errorf("the first half: %w", err)
	}
	time.Sleep(pause)
	if _, err := conn.Write(body[half:]); err != nil {
		return nil, nil, fmt.Errorf("the second half: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(10 * time.Second))
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		return nil, nil, fmt.Errorf("the answer: %w", err)
	}
	defer res.Body.Close()
	got, err := io.ReadAll(res.Body)
	return res, got, err
}

// Contract 4.2 and 5: the phone acts on the reason an upload is refused for, sending the save without its text, so the
// reason must reach it. A refusal the server reaches before the body (quota, daily, too_large and 507 for a full disk)
// is answered only once the rest of the body is read: otherwise the server answers and then closes the connection under
// a client still sending a body past 256 KB, and that client gets a reset in place of the answer, which it would retry
// as a network failure for as long as the refusal stands, holding the save back.
func TestARefusalBeforeTheBodyReachesAClientStillSending(t *testing.T) {
	big := bytes.Repeat([]byte("k"), 1<<20)
	for _, c := range []struct {
		name, reason string
		status       int
		body         []byte
		fill         func(e *env, k key)
		figures      bool
	}{
		{"past the quota", "quota", 413, big, func(e *env, k key) { e.quota(k, 0) }, true},
		{"past the day", "daily", 413, big, func(e *env, k key) { e.seed(k, "the day so far", store.DailyLimit) }, true},
		{"over 8 MB", "too_large", 413, make([]byte, blossom.MaxBlob+1), nil, false},
		{"the disk nearly full", "storage", 507, big, func(e *env, _ key) {
			e.bs.MinFree = 1 << 30
			e.bs.Free = func(string) (int64, error) { return 1 << 30, nil }
		}, false},
	} {
		t.Run(c.name, func(t *testing.T) {
			e := newEnv(t)
			user := newKey()
			e.registered(user)
			if c.fill != nil {
				c.fill(e, user)
			}
			res, got, err := e.sendWhole(user, c.body, 700*time.Millisecond, "")
			if err != nil {
				t.Fatalf("no answer for a client still sending: %v", err)
			}
			var b map[string]any
			_ = json.Unmarshal(got, &b)
			if res.StatusCode != c.status || res.Header.Get("X-Reason") != c.reason || b["error"] != c.reason {
				t.Fatalf("got %d %q %v, want %d %s", res.StatusCode, res.Header.Get("X-Reason"), b, c.status, c.reason)
			}
			if _, has := b["quota"]; has != c.figures {
				t.Fatalf("figures in %v: want them %v", b, c.figures)
			}
			if len(e.files()) != 0 {
				t.Fatalf("a refused upload left %v", e.files())
			}
		})
	}
}

// A client that asks to be told before it sends the body (Expect: 100-continue) is answered at once, its body unsent,
// and a refusal of a caller the server doesn't know is never read past: neither costs the server a body.
func TestARefusalReadsNoBodyItNeedNot(t *testing.T) {
	e := newEnv(t)
	user := newKey()
	e.registered(user)
	e.quota(user, 0)
	for _, c := range []struct {
		name, expect, reason string
		k                    key
		status               int
	}{
		{"a client waiting for 100 Continue", "100-continue", "quota", user, 413},
		{"an unregistered key", "", "not_registered", newKey(), 401},
	} {
		t.Run(c.name, func(t *testing.T) {
			conn, err := net.Dial("tcp", strings.TrimPrefix(e.blob.URL, "http://"))
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			body := []byte("never sent")
			head := fmt.Sprintf("PUT /upload HTTP/1.1\r\nHost: x\r\nAuthorization: %s\r\nX-SHA-256: %s\r\nContent-Length: %d\r\n",
				e.blossomAuth(c.k, "upload", hash(body)), hash(body), 1<<20)
			if c.expect != "" {
				head += "Expect: " + c.expect + "\r\n"
			}
			if _, err := conn.Write([]byte(head + "\r\n")); err != nil {
				t.Fatal(err)
			}
			_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			res, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatalf("no answer before the body: %v", err)
			}
			res.Body.Close()
			if res.StatusCode != c.status || res.Header.Get("X-Reason") != c.reason {
				t.Fatalf("got %d %q, want %d %s", res.StatusCode, res.Header.Get("X-Reason"), c.status, c.reason)
			}
		})
	}
}

// quota sets k's library's quota to mb megabytes.
func (e *env) quota(k key, mb int64) {
	if found, err := e.st.SetQuota(e.t.Context(), k.pk, mb<<20); err != nil || !found {
		e.t.Fatalf("set quota %v %v", found, err)
	}
}
