package guard

import (
	"testing"
	"time"
)

// arrival is some of a body's bytes, n of them, coming at when after the body's start.
type arrival struct {
	when time.Duration
	n    int64
}

// cutAt is when p cuts a body whose bytes come as arrivals, as paced reads do, or -1 for never: each read waits until
// the body falls behind its floor, or for a stall since the last bytes, whichever comes first.
func cutAt(p Pace, arrivals []arrival) time.Duration {
	start := time.Unix(1_791_600_000, 0)
	var got int64
	var last time.Duration
	for _, a := range arrivals {
		deadline := min(p.due(start, got).Sub(start), last+p.Stall)
		if a.when >= deadline {
			return deadline
		}
		got += a.n
		last = a.when
	}
	return -1
}

// steady is size bytes coming at rate bytes a second from after, 16 KB at a time, each piece when the whole of it is in.
func steady(size, rate int64, after time.Duration) []arrival {
	const piece = 16 << 10
	var out []arrival
	for got := int64(0); got < size; got += piece {
		n := min(piece, size-got)
		out = append(out, arrival{after + time.Duration(float64(got+n)/float64(rate)*float64(time.Second)), n})
	}
	return out
}

// clientTime is how long Kefli's phone and extension wait for an upload of size bytes before they let it go: 15
// seconds (the extension's 20) and a second for every 32 KB, the phone's net/http movingMs and the extension's
// uploadTimeoutMs. A call to the API has the base alone.
func clientTime(base time.Duration, size int64) time.Duration {
	return base + time.Duration((size+32767)/32768)*time.Second
}

// The pace is one no phone or browser comes near: an upload of any size up to the 8 MB a blob may be, coming steadily
// at the slowest rate at which the phone or the extension would see it through, is never cut, nor is an 8 MB upload
// on a link as slow as 256 kbps, a slower one the phone itself gives up on, a body that starts 25 seconds late, or one
// that pauses for 50 seconds part way. A body that brings nothing for its first 30 seconds, falls well behind 8 KB a
// second or pauses for more than a minute is cut.
func TestThePaceLeavesEveryRealUploadAlone(t *testing.T) {
	p := Default
	for _, size := range []int64{1 << 10, 8 << 10, 64 << 10, 480 << 10, 1 << 20, 2 << 20, 2900 << 10, 4 << 20, 8 << 20} {
		for _, base := range []time.Duration{15 * time.Second, 20 * time.Second} {
			wait := clientTime(base, size)
			rate := int64(float64(size) / wait.Seconds())
			if at := cutAt(p, steady(size, rate, 0)); at >= 0 {
				t.Fatalf("%d bytes at %d bytes a second, in the client's %v, cut at %v", size, rate, wait, at)
			}
		}
	}
	const blob = 8 << 20
	kept := map[string][]arrival{
		"8 MB at 256 kbps":                     steady(blob, 32<<10, 0),
		"8 MB at 64 kbps":                      steady(blob, 8<<10, 0),
		"a start 25 s late":                    steady(blob, 32<<10, 25*time.Second),
		"a pause of 50 s after the first 2 MB": append(steady(2<<20, 64<<10, 0), steady(6<<20, 64<<10, 32*time.Second+50*time.Second)...),
	}
	for name, a := range kept {
		if at := cutAt(p, a); at >= 0 {
			t.Fatalf("%s: cut at %v", name, at)
		}
	}
	for _, c := range []struct {
		name     string
		a        []arrival
		from, to time.Duration
	}{
		{"nothing for 31 s", []arrival{{31 * time.Second, 100}}, p.Grace, p.Grace},
		// half the floor: behind it once 4 KB a second for t is less than 8 KB a second for t less the grace, by 60 s
		{"4 KB a second", steady(blob, 4<<10, 0), p.Grace, 2 * p.Grace},
		{"a pause of 61 s", append(steady(1<<20, 64<<10, 0), arrival{16*time.Second + 61*time.Second, 1}), 16*time.Second + p.Stall, 16*time.Second + p.Stall},
	} {
		if at := cutAt(p, c.a); at < c.from || at > c.to {
			t.Fatalf("%s: cut at %v, want %v to %v", c.name, at, c.from, c.to)
		}
	}
}
