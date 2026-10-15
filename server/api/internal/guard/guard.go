// Package guard is what every request to keflid passes before its route (backend spec 5). One client, an IPv4 address
// or an IPv6 /64, has at most MaxInFlight requests in keflid at once, and an IPv6 /48 MaxBlockInFlight, on every route,
// reads included. No route reads the body of anything but a POST or a PUT, so any other request that carries one is
// refused at once. A body that is read must keep a pace (Pace) that no phone or browser comes near. And an answer
// written before its request's body is in, as a refusal is, closes the connection, which is let go within a second:
// Go's server read the rest of a body under 256 KB before it answered, so a body that never came kept its request in
// keflid, a goroutine and about 31 KB, until the server's two-minute deadline, on routes that count against nothing.
package guard

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/limit"
)

// MaxInFlight is how many requests one address, an IPv4 address or an IPv6 /64, may have in keflid at once, its two
// servers together. A phone sends one request at a time, and so does a browser, and a mirror copies a text in under a
// second, so the many people one carrier address can stand for stay far below it. Each request held costs keflid a
// goroutine and about 31 KB, and Caddy a connection to keflid.
const MaxInFlight = 32

// MaxBlockInFlight is the same for an IPv6 /48, whose 65,536 /64s would otherwise each hold MaxInFlight: four /64s'
// worth, as the API's offers per /48 are.
const MaxBlockInFlight = 4 * MaxInFlight

// Pace is how a request's body must arrive: in its first Grace it may bring nothing at all, from then on it must have
// brought at least Floor bytes for every second past its Grace, so a body of n bytes may take Grace and a second for
// every Floor bytes, and no one read may wait longer than Stall for a byte.
type Pace struct {
	Grace time.Duration
	Floor int64
	Stall time.Duration
}

// Default is Kefli's pace, which no phone or browser comes near. Each gives a request to the operator 15 seconds (the
// extension's uploads 20) and a second more for every 32 KB it sends, and lets the request go past that (the phone's
// net/http movingMs, the extension's uploadTimeoutMs), so the slowest upload either can finish, 8 MB in four and a
// half minutes, averages about 31 KB a second. The pace allows twice the phone's base and four times their time for
// each byte: a body may take 30 seconds and a second for every 8 KB, under 18 minutes for 8 MB and 38 seconds for the
// most the API reads, and a body ahead of that may pause for up to a minute. The server-wide ReadTimeout it replaces,
// two minutes from the request's start, cut an 8 MB upload on any link slower than about 550 kbps.
var Default = Pace{Grace: 30 * time.Second, Floor: 8 << 10, Stall: time.Minute}

// due is when a body begun at start falls behind its pace if it has brought no more than got bytes.
func (p Pace) due(start time.Time, got int64) time.Time {
	return start.Add(p.Grace + time.Duration(got)*(time.Second/time.Duration(p.Floor)))
}

// ErrSlow is what a body's read returns once the body has fallen behind its pace; the route answers with TooSlow.
var ErrSlow = errors.New("guard: the body fell behind its pace")

// TooSlow answers a request whose body fell behind its pace: 503 timeout with Retry-After, which the phone and the
// extension send again later, as they do any 5xx, where they would take a 408 for a refusal. No phone or browser
// keeps a pace that slow, so in practice only a client that means to hold keflid is answered so.
func TooSlow(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "10")
	write(w, http.StatusServiceUnavailable, "timeout")
}

// write answers {"v":1,"error":reason} with status, the reason in X-Reason too, as keflid's refusals are written, and
// open to any origin, as every keflid answer is (httpapi.CORS), so the extension can read it.
func write(w http.ResponseWriter, status int, reason string) {
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", "*")
	h.Set("Content-Type", "application/json")
	h.Set("X-Reason", reason)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"v": 1, "error": reason})
}

// Guard holds the requests in flight from each client, and the figures every request is held to.
type Guard struct {
	// TrustProxy reads the client's address from X-Forwarded-For, which Caddy in front sets outright.
	TrustProxy bool
	// Pace is what every body read must keep (Default).
	Pace Pace
	// Answer is how long an answer has to be written once it begins, two minutes. Counted from the request's start, as
	// http.Server's WriteTimeout is, an upload whose body took longer could never be told it had arrived, and the phone
	// would send it again for good.
	Answer time.Duration
	// Drain is how long the server may go on reading a body after a route's answer written before it was in, a second:
	// a body already on its way, from a client that sends its whole request before it reads, arrives within it and the
	// connection closes cleanly, and one that never comes holds nothing longer.
	Drain time.Duration
	// MaxAddress and MaxBlock are how many requests one address, and one IPv6 /48, may have in flight at once.
	MaxAddress, MaxBlock int

	mu   sync.Mutex
	held map[string]int
}

// New is a guard with Kefli's figures.
func New(trustProxy bool) *Guard {
	return &Guard{TrustProxy: trustProxy, Pace: Default, Answer: 2 * time.Minute, Drain: time.Second,
		MaxAddress: MaxInFlight, MaxBlock: MaxBlockInFlight, held: map[string]int{}}
}

// Wrap puts the guard in front of next.
func (g *Guard) Wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cs := g.counts(r)
		if !g.take(cs) {
			w.Header().Set("Retry-After", "10")
			g.refuse(w, r, http.StatusTooManyRequests, "rate")
			return
		}
		defer g.release(cs)
		if r.ContentLength != 0 && r.Method != http.MethodPost && r.Method != http.MethodPut {
			g.refuse(w, r, http.StatusBadRequest, "body")
			return
		}
		g.serve(w, r, next)
	})
}

// count is one limit a request in flight counts against: its key and the most it may hold.
type count struct {
	key string
	max int
}

// counts are what a request counts against: its address, an IPv6 address by its /64, and an IPv6 address's /48 too.
// An IPv4 /24 isn't one site, as a carrier's addresses sit many people in one, and has no such limit.
func (g *Guard) counts(r *http.Request) []count {
	ip := limit.ClientIP(r, g.TrustProxy)
	cs := []count{{"address " + limit.Addr(ip, 64), g.MaxAddress}}
	if block := limit.Block(ip); strings.Contains(block, ":") {
		cs = append(cs, count{"block " + block, g.MaxBlock})
	}
	return cs
}

// take counts a request against each of cs, unless one of them is already at its most.
func (g *Guard) take(cs []count) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, c := range cs {
		if g.held[c.key] >= c.max {
			return false
		}
	}
	for _, c := range cs {
		g.held[c.key]++
	}
	return true
}

// release ends a request taken against cs; a key with nothing in flight is forgotten, so the counts hold only the
// requests keflid has now.
func (g *Guard) release(cs []count) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for _, c := range cs {
		g.held[c.key]--
		if g.held[c.key] <= 0 {
			delete(g.held, c.key)
		}
	}
}

// refuse answers a request the guard turns away before its route sees it. One with a body closes its connection with
// the answer and has none of the body read: a client sending such requests as fast as it could would otherwise have
// each kept while the server read on, past the count of requests in flight. No phone or browser sends one, unless a
// crowd behind one address has reached its cap, and that request is sent again later, as any 429 is. Closed at once
// with up to 256 KB of the body still to come, the connection is reset, and Caddy, its write to keflid meeting the
// reset before it has read the answer, may answer 502 in its place (two in five of the 429s to uploads of 100 KB sent
// to Caddy over HTTP/2, in the r5 review), which the phone and the extension send again later just as they do a 429.
// Waiting before the close, as the server does after a route's early answer (answer.done), would keep each refused
// request in keflid, uncounted, as reading on would.
func (g *Guard) refuse(w http.ResponseWriter, r *http.Request, status int, reason string) {
	if r.ContentLength != 0 {
		w.Header().Set("Connection", "close")
		_ = http.NewResponseController(w).SetReadDeadline(time.Now())
	}
	write(w, status, reason)
}

// serve hands the request to next with its body paced and its answer watched, and lets the body go once next is done.
func (g *Guard) serve(w http.ResponseWriter, r *http.Request, next http.Handler) {
	a := &answer{ResponseWriter: w, rc: http.NewResponseController(w), within: g.Answer}
	if r.ContentLength != 0 {
		a.body = &paced{ReadCloser: r.Body, rc: a.rc, pace: g.Pace, start: time.Now()}
		r.Body = a.body
	}
	defer a.done(r, g.Drain)
	next.ServeHTTP(a, r)
}

// answer is the route's ResponseWriter. As the answer begins, it closes the connection with the answer if the body
// isn't all in, so the server answers at once rather than first reading the rest of the body, and it gives the answer
// its own time to be written.
type answer struct {
	http.ResponseWriter
	rc     *http.ResponseController
	body   *paced
	within time.Duration
	begun  bool
}

func (a *answer) begin() {
	if a.begun {
		return
	}
	a.begun = true
	if a.body != nil && !a.body.whole {
		a.Header().Set("Connection", "close")
	}
	_ = a.rc.SetWriteDeadline(time.Now().Add(a.within))
}

func (a *answer) WriteHeader(code int) {
	if code >= http.StatusOK {
		a.begin()
	}
	a.ResponseWriter.WriteHeader(code)
}

func (a *answer) Write(b []byte) (int, error) {
	a.begin()
	return a.ResponseWriter.Write(b)
}

// ReadFrom keeps the server's own copy, which sends a blob's file to the connection with sendfile.
func (a *answer) ReadFrom(src io.Reader) (int64, error) {
	a.begin()
	return io.Copy(a.ResponseWriter, src)
}

// Unwrap is for http.ResponseController.
func (a *answer) Unwrap() http.ResponseWriter {
	return a.ResponseWriter
}

// done, once the route has finished: an answer it never began begins, for the server to write; the request has the
// server's own body back; and a body the route didn't read to its end has Drain for the server's own read of the rest,
// where it had until the read's deadline. The server looks for its own body on the request to know it left one unread
// (Go 1.26's closedRequestBodyEarly), and then half-closes the connection and waits half a second before it closes it,
// so the answer reaches a client still sending, as Caddy is. Left with the paced body, it closed the connection at
// once, and Caddy's write to keflid met the reset before it read the answer: of the early answers to uploads of 600 KB
// or more, one in five sent to Caddy over HTTP/1.1, and one in a hundred over HTTP/2, came back as a 502.
func (a *answer) done(r *http.Request, drain time.Duration) {
	a.begin()
	if a.body == nil {
		return
	}
	r.Body = a.body.ReadCloser
	if !a.body.whole {
		_ = a.rc.SetReadDeadline(time.Now().Add(drain))
	}
}

// paced is a request's body held to its pace: before each read the connection's read deadline is set to when the body
// falls behind it, or to Stall from now if that comes first, and a read past it returns ErrSlow.
type paced struct {
	io.ReadCloser
	rc    *http.ResponseController
	pace  Pace
	start time.Time
	got   int64
	whole bool // read to its end
	slow  bool // fell behind its pace
}

func (p *paced) Read(b []byte) (int, error) {
	switch {
	case p.slow:
		return 0, ErrSlow
	case p.whole:
		return 0, io.EOF
	}
	now := time.Now()
	due := p.pace.due(p.start, p.got)
	if !now.Before(due) {
		p.slow = true
		return 0, ErrSlow
	}
	_ = p.rc.SetReadDeadline(earlier(due, now.Add(p.pace.Stall)))
	n, err := p.ReadCloser.Read(b)
	p.got += int64(n)
	return n, p.after(err)
}

// after reads a read's error: the body's end, or, for a deadline passed, ErrSlow. At the body's end the server lifts
// the deadline itself, before it watches the connection for the client going.
func (p *paced) after(err error) error {
	switch {
	case err == io.EOF:
		p.whole = true
	case errors.Is(err, os.ErrDeadlineExceeded):
		p.slow = true
		return ErrSlow
	}
	return err
}

func earlier(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}
