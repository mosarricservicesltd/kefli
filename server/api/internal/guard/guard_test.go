package guard

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// fast is a guard with its times scaled down, so a test meets each of them in a fraction of a second.
func fast() *Guard {
	g := New(true)
	g.Pace = Pace{Grace: 300 * time.Millisecond, Floor: 64 << 10, Stall: 400 * time.Millisecond}
	g.Answer = 500 * time.Millisecond
	g.Drain = 200 * time.Millisecond
	return g
}

// serving runs h behind g on a loopback server set up as keflid's are (cmd/keflid server), and counts the connections
// it has closed.
func serving(t *testing.T, g *Guard, h http.Handler) (string, *atomic.Int64) {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closed := new(atomic.Int64)
	s := &http.Server{Handler: g.Wrap(h), ReadHeaderTimeout: time.Second, WriteTimeout: g.Answer, IdleTimeout: time.Minute,
		ErrorLog: log.New(io.Discard, "", 0),
		ConnState: func(_ net.Conn, st http.ConnState) {
			if st == http.StateClosed {
				closed.Add(1)
			}
		}}
	go func() { _ = s.Serve(l) }()
	t.Cleanup(func() { _ = s.Close() })
	return l.Addr().String(), closed
}

// dial opens a connection to addr and sends head, the start of a request, as a client would.
func dial(t *testing.T, addr, head string) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	if _, err := io.WriteString(c, head); err != nil {
		t.Fatal(err)
	}
	return c
}

// answerOf reads c's answer, within limit, as Go's client reads one.
func answerOf(t *testing.T, c net.Conn, limit time.Duration) *http.Response {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(limit))
	res, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatalf("no answer within %v: %v", limit, err)
	}
	t.Cleanup(func() { _ = res.Body.Close() })
	return res
}

// waitClosed waits up to limit for the server to have closed n connections in all.
func waitClosed(t *testing.T, closed *atomic.Int64, n int64, limit time.Duration) time.Duration {
	t.Helper()
	start := time.Now()
	for closed.Load() < n {
		if time.Since(start) > limit {
			t.Fatalf("the server held the connection for more than %v", limit)
		}
		time.Sleep(5 * time.Millisecond)
	}
	return time.Since(start)
}

// refusal checks a refusal of the guard's own: the status, the reason in X-Reason and the body, and open to any origin.
func refusal(t *testing.T, res *http.Response, status int, reason string) {
	t.Helper()
	var body struct {
		V     int    `json:"v"`
		Error string `json:"error"`
	}
	_ = json.NewDecoder(res.Body).Decode(&body)
	if res.StatusCode != status || res.Header.Get("X-Reason") != reason || body.V != 1 || body.Error != reason || res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("%d %q %+v, want %d %s", res.StatusCode, res.Header.Get("X-Reason"), body, status, reason)
	}
}

// No route reads the body of a GET, a HEAD, a DELETE or an OPTIONS, and Go's server read such a body to its end
// before answering, so one that never came kept its request in keflid until the server's deadline. One is now refused
// with 400 body before its route sees it, and its connection closed at once; the same request without a body, and a
// POST or PUT with one, reach the route.
func TestABodyNoRouteReadsIsRefused(t *testing.T) {
	var routed atomic.Int64
	addr, closed := serving(t, fast(), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		routed.Add(1)
		n, _ := io.Copy(io.Discard, r.Body)
		fmt.Fprint(w, n)
	}))
	for i, method := range []string{"GET", "HEAD", "DELETE", "OPTIONS"} {
		c := dial(t, addr, method+" /x HTTP/1.1\r\nHost: k\r\nContent-Length: 100\r\n\r\n0123456789")
		res := answerOf(t, c, time.Second)
		if res.StatusCode != http.StatusBadRequest || res.Header.Get("X-Reason") != "body" || !res.Close {
			t.Fatalf("%s with a body: %d %q, closing %v", method, res.StatusCode, res.Header.Get("X-Reason"), res.Close)
		}
		waitClosed(t, closed, int64(i+1), time.Second)
	}
	if routed.Load() != 0 {
		t.Fatalf("a refused request reached its route %d times", routed.Load())
	}
	res, err := http.DefaultClient.Do(must(http.NewRequest("DELETE", "http://"+addr+"/x", strings.NewReader("x"))))
	if err != nil {
		t.Fatal(err)
	}
	refusal(t, res, http.StatusBadRequest, "body")
	// the same without a body, on one connection kept open, and a POST and a PUT with theirs
	c := dial(t, addr, "GET /x HTTP/1.1\r\nHost: k\r\n\r\nGET /x HTTP/1.1\r\nHost: k\r\n\r\n")
	r := bufio.NewReader(c)
	for i := 0; i < 2; i++ {
		_ = c.SetReadDeadline(time.Now().Add(time.Second))
		res, err := http.ReadResponse(r, nil)
		if err != nil || res.StatusCode != http.StatusOK || res.Close {
			t.Fatalf("a GET without a body, %d: %v", i, err)
		}
		_, _ = io.Copy(io.Discard, res.Body)
	}
	for _, method := range []string{"POST", "PUT"} {
		res, err := http.DefaultClient.Do(must(http.NewRequest(method, "http://"+addr+"/x", strings.NewReader("twelve bytes"))))
		if err != nil {
			t.Fatal(err)
		}
		if got, _ := io.ReadAll(res.Body); res.StatusCode != http.StatusOK || string(got) != "12" {
			t.Fatalf("a %s with its body: %d %q", method, res.StatusCode, got)
		}
	}
}

func must(r *http.Request, err error) *http.Request {
	if err != nil {
		panic(err)
	}
	return r
}

// A route that answers before the body is in, as every refusal does, got its answer written only once Go's server had
// read the rest of a body under 256 KB, so a body that never came kept the request in keflid, unanswered, until the
// server's deadline. The answer now goes at once, closing the connection, and the server reads on for Drain at most;
// a request whose body was read to its end keeps its connection for the next.
func TestAnAnswerBeforeTheBodyIsLetGo(t *testing.T) {
	g := fast()
	addr, closed := serving(t, g, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Read") != "" {
			_, _ = io.Copy(io.Discard, r.Body)
		}
		w.WriteHeader(http.StatusUnauthorized)
	}))
	start := time.Now()
	c := dial(t, addr, "POST /x HTTP/1.1\r\nHost: k\r\nContent-Length: 100\r\n\r\n0123456789")
	if res := answerOf(t, c, time.Second); res.StatusCode != http.StatusUnauthorized || !res.Close {
		t.Fatalf("the answer: %d, closing %v", res.StatusCode, res.Close)
	}
	if took := time.Since(start); took > g.Drain {
		t.Fatalf("the answer waited %v for the body", took)
	}
	// Drain, and the half second Go's server waits before it closes a connection whose body it didn't read
	waitClosed(t, closed, 1, g.Drain+time.Second)
	c = dial(t, addr, "POST /x HTTP/1.1\r\nHost: k\r\nRead: 1\r\nContent-Length: 10\r\n\r\n0123456789")
	if res := answerOf(t, c, time.Second); res.StatusCode != http.StatusUnauthorized || res.Close {
		t.Fatalf("an answer once the body was read: %d, closing %v", res.StatusCode, res.Close)
	}
	time.Sleep(g.Drain + 100*time.Millisecond)
	if closed.Load() != 1 {
		t.Fatal("a connection whose body was read was closed")
	}
}

// slowRoute reads the whole body, and answers its size, or TooSlow for a body that fell behind its pace, with how
// long the read took in Took.
func slowRoute(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	n, err := io.Copy(io.Discard, r.Body)
	w.Header().Set("Took", time.Since(start).String())
	if errors.Is(err, ErrSlow) {
		TooSlow(w)
		return
	}
	fmt.Fprint(w, n)
}

func took(t *testing.T, res *http.Response) time.Duration {
	t.Helper()
	d, err := time.ParseDuration(res.Header.Get("Took"))
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// A body was held to nothing but the server's ReadTimeout, two minutes from the request's start for the whole
// request, so one that never came, came a byte at a time or stopped half way kept its request for all of it. Now a
// body that brings nothing in its Grace, falls behind its Floor or waits a Stall for a byte is cut there: the route's
// read returns ErrSlow and the route answers 503 timeout with Retry-After.
func TestABodyBehindItsPaceIsCut(t *testing.T) {
	g := fast()
	addr, _ := serving(t, g, http.HandlerFunc(slowRoute))
	head := func(n int) string {
		return "PUT /x HTTP/1.1\r\nHost: k\r\nContent-Length: " + strconv.Itoa(n) + "\r\n\r\n"
	}
	for _, c := range []struct {
		name     string
		size     int
		send     func(net.Conn)
		min, max time.Duration
	}{
		{"nothing after its head", 100, func(net.Conn) {}, g.Pace.Grace, g.Pace.Grace + 300*time.Millisecond},
		{"a trickle below the floor", 1 << 20, func(c net.Conn) {
			for i := 0; i < 20; i++ {
				if _, err := c.Write(make([]byte, 100)); err != nil {
					return
				}
				time.Sleep(50 * time.Millisecond)
			}
		}, g.Pace.Grace, g.Pace.Grace + 300*time.Millisecond},
		{"a pause past the stall, well ahead of the floor", 1 << 20, func(c net.Conn) {
			_, _ = c.Write(make([]byte, 128<<10))
		}, g.Pace.Stall, g.Pace.Stall + 300*time.Millisecond},
	} {
		conn := dial(t, addr, head(c.size))
		go c.send(conn)
		res := answerOf(t, conn, 3*time.Second)
		refusal(t, res, http.StatusServiceUnavailable, "timeout")
		if d := took(t, res); d < c.min || d > c.max || res.Header.Get("Retry-After") != "10" {
			t.Fatalf("%s: cut after %v, want %v to %v, Retry-After %q", c.name, d, c.min, c.max, res.Header.Get("Retry-After"))
		}
	}
}

// A body that keeps its pace is read whole however long it takes, past the Grace, a Stall and the server's two
// minutes' WriteTimeout from the request's start alike; and its answer, which begins only then, has its own time to
// be written, where counted from the start it couldn't have been, and the upload would have been sent again for good.
func TestABodyThatKeepsItsPaceArrivesWhole(t *testing.T) {
	g := fast()
	addr, _ := serving(t, g, http.HandlerFunc(slowRoute))
	const size = 256 << 10
	c := dial(t, addr, "PUT /x HTTP/1.1\r\nHost: k\r\nContent-Length: "+strconv.Itoa(size)+"\r\n\r\n")
	// 16 KB a tenth of a second, two and a half times the floor, for 1.6 seconds
	go func() {
		for sent := 0; sent < size; sent += 16 << 10 {
			if _, err := c.Write(make([]byte, 16<<10)); err != nil {
				return
			}
			time.Sleep(100 * time.Millisecond)
		}
	}()
	res := answerOf(t, c, 5*time.Second)
	got, _ := io.ReadAll(res.Body)
	if res.StatusCode != http.StatusOK || string(got) != strconv.Itoa(size) {
		t.Fatalf("%d %q", res.StatusCode, got)
	}
	if d := took(t, res); d < g.Pace.Grace+g.Pace.Stall || d < g.Answer {
		t.Fatalf("the body took only %v", d)
	}
}

// Go's server watches a connection for its client going once the body has been read, and a read deadline met there
// would cancel the request: a route still working after the pace's last deadline would find its request cancelled.
// The server lifts the deadline as it starts to watch, which the guard relies on, and this holds it to that.
func TestTheBodysEndLiftsItsDeadline(t *testing.T) {
	g := fast()
	addr, _ := serving(t, g, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		time.Sleep(g.Pace.Grace + g.Pace.Stall + 200*time.Millisecond)
		if r.Context().Err() != nil {
			w.WriteHeader(http.StatusInternalServerError)
		}
	}))
	res, err := http.Post("http://"+addr+"/x", "text/plain", strings.NewReader("a small body"))
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("the request was cancelled after its body: %d", res.StatusCode)
	}
}

// The guard's ResponseWriter stays the server's own underneath: a blob's file is sent whole through its ReadFrom, an
// interim 1xx answer leaves the answer to begin with the final one, and http.ResponseController reaches the server's
// writer to flush.
func TestTheAnswerIsTheServersOwn(t *testing.T) {
	g := fast()
	blob := filepath.Join(t.TempDir(), "blob")
	if err := os.WriteFile(blob, []byte(strings.Repeat("ciphertext", 10_000)), 0o600); err != nil {
		t.Fatal(err)
	}
	addr, _ := serving(t, g, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/flush" {
			w.WriteHeader(http.StatusEarlyHints)
			w.WriteHeader(http.StatusAccepted)
			if err := http.NewResponseController(w).Flush(); err != nil {
				fmt.Fprint(w, err)
			}
			return
		}
		f, _ := os.Open(blob)
		defer f.Close()
		http.ServeContent(w, r, "", time.Time{}, f)
	}))
	res, err := http.Get("http://" + addr + "/blob")
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := io.ReadAll(res.Body); res.StatusCode != http.StatusOK || len(got) != 100_000 {
		t.Fatalf("a blob: %d, %d bytes", res.StatusCode, len(got))
	}
	res, err = http.Get("http://" + addr + "/flush")
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := io.ReadAll(res.Body); res.StatusCode != http.StatusAccepted || len(got) != 0 {
		t.Fatalf("a flush through the controller: %d %q", res.StatusCode, got)
	}
}
