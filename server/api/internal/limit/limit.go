// Package limit is the rate limiting keflid and the relay's write policy share (backend spec 5): counts per key in
// fixed windows, and the address a client is counted as.
package limit

import (
	"net"
	"net/http"
	"net/netip"
	"strings"
	"sync"
	"time"
)

// pruneAt is the size at which a Limiter first drops its expired windows.
const pruneAt = 100_000

// Limiter counts requests per key in fixed windows: enough to bound what one key or address can cost, in memory, since
// a restart forgetting the counts costs nothing.
type Limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	now    func() time.Time
	seen   map[string]*bucket
	// next is the size at which expired windows are next dropped: twice what the last pass left, so a map full of live
	// windows is scanned once per doubling, never on every new key (F45)
	next int
}

type bucket struct {
	start time.Time
	n     int
}

func New(max int, window time.Duration, now func() time.Time) *Limiter {
	return &Limiter{max: max, window: window, now: now, seen: map[string]*bucket{}, next: pruneAt}
}

// Allow counts one request for key and says whether it is within the limit; retry is how long until the window resets.
func (l *Limiter) Allow(key string) (ok bool, retry time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b := l.bucketFor(key, now)
	b.n++
	if b.n > l.max {
		return false, l.window - now.Sub(b.start)
	}
	return true, 0
}

// bucketFor is key's window, a new one once the last has ended, for a caller holding mu.
func (l *Limiter) bucketFor(key string, now time.Time) *bucket {
	b := l.seen[key]
	if b == nil || now.Sub(b.start) >= l.window {
		b = &bucket{start: now}
		l.seen[key] = b
		if len(l.seen) > l.next {
			l.prune(now)
		}
	}
	return b
}

// Spent says whether key's window is already at its limit, without counting anything: for a limit on failures, which
// are counted only once they happen.
func (l *Limiter) Spent(key string) (spent bool, retry time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b := l.seen[key]
	if b == nil || now.Sub(b.start) >= l.window || b.n < l.max {
		return false, 0
	}
	return true, l.window - now.Sub(b.start)
}

func (l *Limiter) prune(now time.Time) {
	for k, b := range l.seen {
		if now.Sub(b.start) >= l.window {
			delete(l.seen, k)
		}
	}
	l.next = max(pruneAt, 2*len(l.seen))
}

// Block is the wider block an address belongs to, for limits a caller with one cheap allocation could otherwise fill
// alone: an IPv4 address's /24 and an IPv6 address's /48, what one site or one tunnel broker's account is given (F8).
// Anything that isn't an address is counted as it is.
func Block(addr string) string {
	a, err := netip.ParseAddr(strings.TrimSpace(addr))
	if err != nil {
		return addr
	}
	a = a.Unmap().WithZone("")
	bits := 48
	if a.Is4() {
		bits = 24
	}
	p, err := a.Prefix(bits)
	if err != nil {
		return addr
	}
	return p.String()
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

// Addr is the address a client is counted as: an IPv4 address whole, and an IPv6 address by its first bits, the block
// one line or one server is given (a /64, a home line's /56), since every address inside it is the same client's for
// free (F8). Anything that isn't an address is counted as it is.
func Addr(addr string, bits int) string {
	a, err := netip.ParseAddr(strings.TrimSpace(addr))
	if err != nil {
		return addr
	}
	if a = a.Unmap(); a.Is4() {
		return a.String()
	}
	p, err := a.WithZone("").Prefix(bits)
	if err != nil {
		return addr
	}
	return p.String()
}
