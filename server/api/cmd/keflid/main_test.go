package main

import (
	"bufio"
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/blossom"
	"github.com/richardminton-glitch/Kefli/server/api/internal/guard"
	"github.com/richardminton-glitch/Kefli/server/api/internal/store"
)

func write(t *testing.T, name, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadDefaults(t *testing.T) {
	good := `{"v":1,"operator":{"relay":"wss://r","blossom":"https://b","api":"https://a"},"relays":[],"mirrors":[]}`
	if _, err := readDefaults(write(t, "d.json", good)); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{`{"v":2,"operator":{"relay":"r","blossom":"b","api":"a"}}`, `{"v":1,"operator":{"relay":"r"}}`, `nonsense`} {
		if _, err := readDefaults(write(t, "d.json", bad)); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	if _, err := readDefaults(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("accepted a missing file")
	}
}

func TestReadNames(t *testing.T) {
	n, err := readNames(write(t, "n.json", `{"names":{"_":"ab"},"relays":["wss://r"]}`))
	if err != nil || n.Names["_"] != "ab" || n.Relays[0] != "wss://r" {
		t.Fatalf("%+v %v", n, err)
	}
	if n, err := readNames(""); err != nil || n.Names != nil {
		t.Fatal("no file should mean no names")
	}
	if _, err := readNames(filepath.Join(t.TempDir(), "missing.json")); err == nil {
		t.Fatal("accepted a missing file")
	}
}

func TestSweepOnce(t *testing.T) {
	dir := t.TempDir()
	st, err := store.Open(filepath.Join(dir, "k.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	clock := time.Unix(1_791_600_000, 0)
	st.Now = func() time.Time { return clock }
	ctx := context.Background()
	sha := "aa" + "00000000000000000000000000000000000000000000000000000000000000"[:62]
	blobs := blossom.New(filepath.Join(dir, "blobs"), "http://b", st, slog.New(slog.NewTextHandler(io.Discard, nil)))
	_ = os.MkdirAll(filepath.Join(dir, "blobs", "aa"), 0o750)
	_ = os.WriteFile(filepath.Join(dir, "blobs", "aa", sha), []byte("x"), 0o600)
	// an owner is recorded only for an account that stands, and an inbox blob only for its device
	if err := st.Register(ctx, "user"); err != nil {
		t.Fatal(err)
	}
	if err := st.AddDevice(ctx, "user", "device"); err != nil {
		t.Fatal(err)
	}
	if err := st.AddOwner(ctx, sha, "device", "user", 1, true); err != nil {
		t.Fatal(err)
	}
	if held, _ := st.Exists(ctx, sha); !held {
		t.Fatal("the inbox blob's owner wasn't recorded")
	}
	clock = clock.Add(store.InboxLife)
	if err := sweepOnce(ctx, st, blobs); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "blobs", "aa", sha)); !os.IsNotExist(err) {
		t.Fatal("an expired inbox blob's file is still there")
	}
}

// run starts both servers from the environment, answers, and shuts down when its context ends.
func TestRunServesAndStops(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("KEFLID_DEFAULTS", write(t, "d.json", `{"v":1,"operator":{"relay":"wss://r","blossom":"https://b","api":"https://a"}}`))
	t.Setenv("KEFLID_DB", filepath.Join(dir, "k.db"))
	t.Setenv("KEFLID_BLOBS", filepath.Join(dir, "blobs"))
	t.Setenv("KEFLID_API_ADDR", "127.0.0.1:18447")
	t.Setenv("KEFLID_BLOSSOM_ADDR", "127.0.0.1:13447")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, slog.New(slog.NewTextHandler(io.Discard, nil))) }()
	var res *http.Response
	var err error
	for i := 0; i < 50; i++ {
		if res, err = http.Get("http://127.0.0.1:18447/health"); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil || res.StatusCode != 200 {
		t.Fatalf("health: %v", err)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("run didn't stop")
	}
	t.Setenv("KEFLID_MIN_FREE_MB", "lots")
	if err := run(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		t.Fatal("ran with a free-space floor that isn't a number")
	}
	t.Setenv("KEFLID_DEFAULTS", filepath.Join(dir, "missing.json"))
	if err := run(context.Background(), slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		t.Fatal("ran without defaults.json")
	}
}

// Headers were taken up to Go's default of a megabyte: 300 requests at once with a 1 MB authorisation took keflid from
// 22 MB to 145 MB (probe odd), on a 2 GB box. A NIP-98 or Blossom authorisation is under a kilobyte, and a request's
// headers under 4 KB; more than maxHeader (and the 4 KB Go allows past it) is answered 431.
func TestServerHeadersAreBounded(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {})
	s := server(l.Addr().String(), guard.New(false), mux)
	go s.Serve(l)
	defer s.Close()
	for _, c := range []struct {
		size, want int
	}{{8 << 10, 200}, {2 * maxHeader, http.StatusRequestHeaderFieldsTooLarge}} {
		req, _ := http.NewRequest("GET", "http://"+l.Addr().String()+"/", nil)
		req.Header.Set("Authorization", "Nostr "+strings.Repeat("A", c.size))
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		if res.StatusCode != c.want {
			t.Fatalf("a %d-byte header: %d, want %d", c.size, res.StatusCode, c.want)
		}
	}
}

// started runs keflid from the environment on the given ports until the test ends, once its API answers.
func started(t *testing.T, api, blob string) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("KEFLID_DEFAULTS", write(t, "d.json", `{"v":1,"operator":{"relay":"wss://r","blossom":"https://b","api":"https://a"}}`))
	t.Setenv("KEFLID_DB", filepath.Join(dir, "k.db"))
	t.Setenv("KEFLID_BLOBS", filepath.Join(dir, "blobs"))
	t.Setenv("KEFLID_API_ADDR", api)
	t.Setenv("KEFLID_BLOSSOM_ADDR", blob)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- run(ctx, slog.New(slog.NewTextHandler(io.Discard, nil))) }()
	t.Cleanup(func() { cancel(); <-done })
	// A loaded runner under the race detector can take more than a second to bring keflid up (CI, 16 October 2026),
	// so the wait is generous; a run that ends first is reported with its error rather than as a slow start.
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case err := <-done:
			done <- nil
			t.Fatalf("keflid stopped before it answered: %v", err)
		default:
		}
		if res, err := http.Get("http://" + api + "/health"); err == nil {
			res.Body.Close()
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("keflid didn't start within 20 s")
}

// sent opens a connection and sends head, the start of a request whose body never finishes arriving.
func sent(t *testing.T, addr, head string) net.Conn {
	t.Helper()
	c, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	if _, err := io.WriteString(c, head); err != nil {
		t.Fatal(err)
	}
	return c
}

// status reads the status line of c's answer within limit.
func status(t *testing.T, c net.Conn, limit time.Duration) (string, *bufio.Reader) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(limit))
	r := bufio.NewReader(c)
	line, err := r.ReadString('\n')
	if err != nil {
		t.Fatalf("no answer within %v: %v", limit, err)
	}
	return strings.TrimSpace(line), r
}

// letGo waits, within limit, for keflid to close the connection whose answer r has begun to read.
func letGo(t *testing.T, c net.Conn, r *bufio.Reader, limit time.Duration) {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(limit))
	if _, err := io.Copy(io.Discard, r); err != nil {
		t.Fatalf("the connection was still held after %v: %v", limit, err)
	}
}

// A request whose small body never finishes arriving waited in keflid for its two-minute ReadTimeout on any route that
// answers without reading it, and each held a goroutine and about 31 KB (r5): a GET of a blob or of defaults.json, a
// refused upload, a DELETE. Now a body where no route reads one is refused at once, an answer written before the body
// is in goes at once, and either way the connection is let go.
func TestBodiesNoRouteReadsAreLetGo(t *testing.T) {
	api, blob := "127.0.0.1:18457", "127.0.0.1:13457"
	started(t, api, blob)
	sha := strings.Repeat("ab", 32)
	for _, c := range []struct{ name, addr, head, want string }{
		{"GET /defaults.json", api, "GET /defaults.json HTTP/1.1\r\nHost: a\r\nContent-Length: 100\r\n\r\n0123456789", "HTTP/1.1 400 Bad Request"},
		{"GET of a blob", blob, "GET /" + sha + " HTTP/1.1\r\nHost: b\r\nContent-Length: 100\r\n\r\n0123456789", "HTTP/1.1 400 Bad Request"},
		{"DELETE of a blob", blob, "DELETE /" + sha + " HTTP/1.1\r\nHost: b\r\nAuthorization: Nostr x\r\nContent-Length: 100\r\n\r\n0123456789", "HTTP/1.1 400 Bad Request"},
		{"an upload refused", blob, "PUT /upload HTTP/1.1\r\nHost: b\r\nX-SHA-256: " + sha + "\r\nAuthorization: Nostr x\r\nContent-Length: 100\r\n\r\n0123456789", "HTTP/1.1 401 Unauthorized"},
	} {
		conn := sent(t, c.addr, c.head)
		got, r := status(t, conn, 3*time.Second)
		if got != c.want {
			t.Fatalf("%s: %q, want %q", c.name, got, c.want)
		}
		letGo(t, conn, r, 3*time.Second)
	}
}

// Nothing limited how many requests one client had waiting in keflid (r5): each address may now have guard's
// MaxInFlight at once, its API's and its blob store's together, and one more gets 429 at once, a GET as any other.
func TestRequestsInFlightAreCapped(t *testing.T) {
	api, blob := "127.0.0.1:18467", "127.0.0.1:13467"
	started(t, api, blob)
	var held []net.Conn
	for i := 0; i < guard.MaxInFlight; i++ {
		held = append(held, sent(t, api, "POST /register HTTP/1.1\r\nHost: a\r\nContent-Length: 100\r\n\r\n{\"v\":1"))
	}
	time.Sleep(200 * time.Millisecond)
	if got, _ := status(t, sent(t, blob, "GET /"+strings.Repeat("ab", 32)+" HTTP/1.1\r\nHost: b\r\n\r\n"), 3*time.Second); got != "HTTP/1.1 429 Too Many Requests" {
		t.Fatalf("one request past the cap: %q", got)
	}
	for _, c := range held {
		c.Close()
	}
	time.Sleep(200 * time.Millisecond)
	if res, err := http.Get("http://" + api + "/health"); err != nil || res.StatusCode != 200 {
		t.Fatalf("once they were let go: %v", err)
	}
}

// serve reports an address it can't listen on.
func TestServeFailsOnABusyAddress(t *testing.T) {
	busy, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer busy.Close()
	if err := serve(context.Background(), []*http.Server{server(busy.Addr().String(), guard.New(false), http.NewServeMux())}, slog.New(slog.NewTextHandler(io.Discard, nil))); err == nil {
		t.Fatal("served on a busy address")
	}
}
