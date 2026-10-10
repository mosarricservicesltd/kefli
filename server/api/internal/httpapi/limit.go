package httpapi

import (
	"sync"
	"time"
)

// Limiter counts requests per key in fixed windows: enough to bound what one key or address can cost (backend spec 5),
// in memory, since a restart forgetting the counts costs nothing.
type Limiter struct {
	mu     sync.Mutex
	max    int
	window time.Duration
	now    func() time.Time
	seen   map[string]*bucket
}

type bucket struct {
	start time.Time
	n     int
}

func NewLimiter(max int, window time.Duration, now func() time.Time) *Limiter {
	return &Limiter{max: max, window: window, now: now, seen: map[string]*bucket{}}
}

// Allow counts one request for key and says whether it is within the limit; retry is how long until the window resets.
func (l *Limiter) Allow(key string) (ok bool, retry time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	b := l.seen[key]
	if b == nil || now.Sub(b.start) >= l.window {
		b = &bucket{start: now}
		l.seen[key] = b
		if len(l.seen) > 100_000 {
			l.prune(now)
		}
	}
	b.n++
	if b.n > l.max {
		return false, l.window - now.Sub(b.start)
	}
	return true, 0
}

func (l *Limiter) prune(now time.Time) {
	for k, b := range l.seen {
		if now.Sub(b.start) >= l.window {
			delete(l.seen, k)
		}
	}
}
