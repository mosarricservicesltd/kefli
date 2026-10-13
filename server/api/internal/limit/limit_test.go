package limit

import (
	"strconv"
	"testing"
	"time"
)

func TestAllowAndSpent(t *testing.T) {
	now := time.Unix(1_791_600_000, 0)
	l := New(2, time.Hour, func() time.Time { return now })
	for i, want := range []bool{true, true, false} {
		if ok, _ := l.Allow("k"); ok != want {
			t.Fatalf("request %d: %v", i, ok)
		}
	}
	if ok, retry := l.Allow("k"); ok || retry != time.Hour {
		t.Fatalf("over the limit: %v %v", ok, retry)
	}
	m := New(2, time.Hour, func() time.Time { return now })
	m.Allow("misses")
	if spent, _ := m.Spent("misses"); spent {
		t.Fatal("spent after one of two")
	}
	m.Allow("misses")
	if spent, retry := m.Spent("misses"); !spent || retry != time.Hour {
		t.Fatalf("not spent after two of two: %v %v", spent, retry)
	}
	now = now.Add(time.Hour)
	if spent, _ := m.Spent("misses"); spent {
		t.Fatal("still spent in the next window")
	}
	if ok, _ := l.Allow("k"); !ok {
		t.Fatal("refused in the next window")
	}
}

// F45: past 100,000 live windows, a new key used to scan the whole map under the lock, so a flood of fresh keys
// within the window took minutes and stalled every caller. Expired windows still go.
func TestManyKeysStayCheap(t *testing.T) {
	now := time.Unix(1_791_600_000, 0)
	l := New(30, time.Hour, func() time.Time { return now })
	start := time.Now()
	for i := range 300_000 {
		l.Allow(strconv.Itoa(i))
	}
	if took := time.Since(start); took > 15*time.Second {
		t.Fatalf("300,000 new keys took %v", took)
	}
	now = now.Add(time.Hour)
	for i := range 300_001 {
		l.Allow("later " + strconv.Itoa(i))
	}
	if n := len(l.seen); n > 300_001 {
		t.Fatalf("%d windows held: the expired ones weren't dropped", n)
	}
}

func TestAddr(t *testing.T) {
	for in, want := range map[string]string{
		"203.0.113.9":                    "203.0.113.9",
		" 203.0.113.9 ":                  "203.0.113.9",
		"::ffff:203.0.113.9":             "203.0.113.9",
		"2a01:4f8:1c16:497a::1":          "2a01:4f8:1c16:497a::/64",
		"2a01:4f8:1c16:497a:dead:beef::": "2a01:4f8:1c16:497a::/64",
		"fe80::1%eth0":                   "fe80::/64",
		"not an address":                 "not an address",
	} {
		if got := Addr(in, 64); got != want {
			t.Errorf("Addr(%q) = %q, want %q", in, got, want)
		}
	}
	if Addr("2a01:4f8:1c16:4900::1", 56) != Addr("2a01:4f8:1c16:49ff::1", 56) {
		t.Error("two /64s of one /56 counted apart")
	}
}
