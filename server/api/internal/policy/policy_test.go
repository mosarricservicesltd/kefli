package policy

import (
	"encoding/json"
	"strconv"
	"strings"
	"testing"
	"time"
)

type fake struct {
	users   map[string]bool
	devices map[string]string // device to user
	wraps   map[string]Wrap
}

func (f *fake) Registered(pk string) bool { return f.users[pk] }
func (f *fake) Authorised(pk string) bool { return f.devices[pk] != "" }
func (f *fake) DeviceUser(pk string) (string, bool) {
	u, ok := f.devices[pk]
	return u, ok
}
func (f *fake) Wrap(id string) (string, string, bool) {
	w, ok := f.wraps[id]
	return w.Author, w.P, ok
}

const (
	user    = "aa"
	device  = "dd"
	throw   = "ee"
	nobody  = "ff"
	address = "203.0.113.9"
)

func line(t *testing.T, ev Event, pad int) Input {
	t.Helper()
	raw, _ := json.Marshal(map[string]any{"id": ev.ID, "pubkey": ev.Pubkey, "kind": ev.Kind, "tags": ev.Tags, "content": strings.Repeat("x", pad)})
	return Input{Type: "new", Event: raw, SourceType: "IP4", SourceInfo: address}
}

func setup() (*Policy, *fake, *time.Time) {
	f := &fake{users: map[string]bool{user: true, "bb": true}, devices: map[string]string{device: user}, wraps: map[string]Wrap{"w1": {ID: "w1", Author: throw, P: user}}}
	now := time.Unix(1_791_600_000, 0)
	return New(f, func() time.Time { return now }), f, &now
}

func TestRegisteredAuthorsWrite(t *testing.T) {
	p, _, _ := setup()
	if v := p.Decide(line(t, Event{ID: "1", Pubkey: user, Kind: KindAppData}, 100)); v.Out.Action != "accept" {
		t.Fatalf("%+v", v)
	}
	if v := p.Decide(line(t, Event{ID: "2", Pubkey: nobody, Kind: KindAppData}, 100)); v.Out.Action != "reject" || !strings.HasPrefix(v.Out.Msg, "blocked:") {
		t.Fatalf("an unregistered author: %+v", v)
	}
	if v := p.Decide(line(t, Event{ID: "3", Pubkey: user, Kind: KindAppData}, SmallMax)); v.Out.Action != "reject" {
		t.Fatalf("a kind 30078 over 16 KB: %+v", v)
	}
	if v := p.Decide(line(t, Event{ID: "4", Pubkey: user, Kind: 10002}, SmallMax)); v.Out.Action != "accept" {
		t.Fatalf("other kinds keep strfry's 64 KB: %+v", v)
	}
}

func TestWraps(t *testing.T) {
	p, _, _ := setup()
	for _, to := range []string{user, device} {
		v := p.Decide(line(t, Event{ID: "w-" + to, Pubkey: throw, Kind: KindWrap, Tags: [][]string{{"p", to}}}, 100))
		if v.Out.Action != "accept" || v.Record == nil || v.Record.P != to {
			t.Fatalf("a wrap to %s: %+v", to, v)
		}
	}
	for name, tags := range map[string][][]string{"to a stranger": {{"p", nobody}}, "to two": {{"p", user}, {"p", device}}, "to no one": nil} {
		if v := p.Decide(line(t, Event{ID: "x", Pubkey: throw, Kind: KindWrap, Tags: tags}, 100)); v.Out.Action != "reject" {
			t.Fatalf("a wrap %s: %+v", name, v)
		}
	}
}

func TestDeletions(t *testing.T) {
	p, _, _ := setup()
	// the extension's Undo: its own wrap, held here
	if v := p.Decide(line(t, Event{ID: "d1", Pubkey: throw, Kind: KindDeletion, Tags: [][]string{{"e", "w1"}, {"k", "1059"}}}, 0)); v.Out.Action != "accept" || len(v.Deletes) != 0 {
		t.Fatalf("undo: %+v", v)
	}
	for name, ev := range map[string]Event{
		"someone else's wrap":   {ID: "d2", Pubkey: nobody, Kind: KindDeletion, Tags: [][]string{{"e", "w1"}}},
		"a wrap not held":       {ID: "d3", Pubkey: throw, Kind: KindDeletion, Tags: [][]string{{"e", "gone"}}},
		"one held, one not":     {ID: "d4", Pubkey: throw, Kind: KindDeletion, Tags: [][]string{{"e", "w1"}, {"e", "gone"}}},
		"naming nothing":        {ID: "d5", Pubkey: throw, Kind: KindDeletion},
		"another kind, unknown": {ID: "d6", Pubkey: throw, Kind: 1},
	} {
		if v := p.Decide(line(t, ev, 0)); v.Out.Action != "reject" {
			t.Fatalf("%s: %+v", name, v)
		}
	}
	// the recipient deleting a wrap it consumed: accepted, and the wrap is removed for it
	v := p.Decide(line(t, Event{ID: "d7", Pubkey: user, Kind: KindDeletion, Tags: [][]string{{"e", "w1"}, {"e", "an item"}}}, 0))
	if v.Out.Action != "accept" || len(v.Deletes) != 1 || v.Deletes[0] != "w1" {
		t.Fatalf("recipient: %+v", v)
	}
}

func TestLimitsAndImports(t *testing.T) {
	p, _, now := setup()
	for i := 0; i < 60; i++ {
		if v := p.Decide(line(t, Event{ID: "e", Pubkey: user, Kind: KindAppData}, 10)); v.Out.Action != "accept" {
			t.Fatalf("event %d: %+v", i, v)
		}
	}
	if v := p.Decide(line(t, Event{ID: "e", Pubkey: user, Kind: KindAppData}, 10)); v.Out.Action != "reject" || !strings.HasPrefix(v.Out.Msg, "rate-limited:") {
		t.Fatalf("the 61st in a minute: %+v", v)
	}
	*now = now.Add(time.Minute)
	if v := p.Decide(line(t, Event{ID: "e", Pubkey: user, Kind: KindAppData}, 10)); v.Out.Action != "accept" {
		t.Fatalf("a minute later: %+v", v)
	}
	in := line(t, Event{ID: "i", Pubkey: nobody, Kind: KindAppData}, 10)
	in.SourceType = "Import"
	if v := p.Decide(in); v.Out.Action != "accept" {
		t.Fatalf("an operator's import: %+v", v)
	}
	if v := p.Decide(Input{Type: "new", Event: json.RawMessage(`nonsense`)}); v.Out.Action != "reject" {
		t.Fatalf("an unreadable line: %+v", v)
	}
}

// wrapFrom is a wrap to someone from a throwaway key, sent from an address, on a connection AUTHed as authed (or not).
func wrapFrom(t *testing.T, id, to, addr, authed string) Input {
	in := line(t, Event{ID: id, Pubkey: throw, Kind: KindWrap, Tags: [][]string{{"p", to}}}, 10)
	in.SourceInfo, in.Authed = addr, authed
	return in
}

// F9: one address filling a user's wraps for the hour used to block every save from the user's browser. Now its wraps
// count against its own address and its share of the recipient, and a wrap sent AUTHed as the user's device passes.
func TestOthersCantUseUpARecipient(t *testing.T) {
	p, _, now := setup()
	n := 0
	for i := 0; i < AddrMax && p.Decide(wrapFrom(t, "junk", user, address, "")).Out.Action == "accept"; i++ {
		n++
	}
	if n != ToAddrMax {
		t.Fatalf("one address sent %d wraps to one recipient, want %d", n, ToAddrMax)
	}
	if v := p.Decide(wrapFrom(t, "save", user, "198.51.100.20", "")); v.Out.Action != "accept" {
		t.Fatalf("a save from another address: %+v", v)
	}
	// from many addresses together, the recipient's ceiling holds; the browser AUTHed as the user's device still saves,
	// and so does the phone's pair-ack to that browser
	for i := 0; i < RecipientMax; i++ {
		p.Decide(wrapFrom(t, "flood", user, "192.0.2."+strconv.Itoa(i%250), ""))
	}
	if v := p.Decide(wrapFrom(t, "unauthed", user, "203.0.113.50", "")); v.Out.Action != "reject" {
		t.Fatalf("past the recipient's ceiling: %+v", v)
	}
	if v := p.Decide(wrapFrom(t, "browser", user, "203.0.113.50", device)); v.Out.Action != "accept" || v.Record == nil {
		t.Fatalf("the user's own browser: %+v", v)
	}
	if v := p.Decide(wrapFrom(t, "ack", device, "203.0.113.50", user)); v.Out.Action != "accept" {
		t.Fatalf("the phone's pair-ack: %+v", v)
	}
	if v := p.Decide(wrapFrom(t, "stranger", user, "203.0.113.50", nobody)); v.Out.Action != "reject" {
		t.Fatalf("AUTHed as a stranger counts as unAUTHed: %+v", v)
	}
	*now = now.Add(time.Hour)
	if v := p.Decide(wrapFrom(t, "next hour", user, address, "")); v.Out.Action != "accept" {
		t.Fatalf("the next hour: %+v", v)
	}
}

// F9: a wrap the address limit refuses counts against nothing else, and one the recipient's share refuses still counts
// against the sender's own address, so a sender can't keep firing at a recipient for free.
func TestRefusedWrapsCostTheSender(t *testing.T) {
	p, _, _ := setup()
	for i := 0; i < AddrMax; i++ {
		p.Decide(wrapFrom(t, "junk", user, address, ""))
	}
	if v := p.Decide(wrapFrom(t, "own", "bb", address, "")); v.Out.Action != "reject" {
		t.Fatalf("the sender's address limit didn't count its refused wraps: %+v", v)
	}
	if v := p.Decide(wrapFrom(t, "save", user, "198.51.100.20", "")); v.Out.Action != "accept" {
		t.Fatalf("a save from another address: %+v", v)
	}
}

// F8: every address in an IPv6 /64 is one sender's for free, so the /64 is what the limits count.
func TestAnIPv6BlockIsOneAddress(t *testing.T) {
	p, _, _ := setup()
	refused := 0
	for i := 0; i < AddrMax+10; i++ {
		in := wrapFrom(t, "w", []string{user, "bb", device}[i%3], "2001:db8:1:2::"+strconv.FormatInt(int64(i+1), 16), "")
		if p.Decide(in).Out.Action != "accept" {
			refused++
		}
	}
	if refused != 10 {
		t.Fatalf("%d of %d wraps from one /64 refused, want 10", refused, AddrMax+10)
	}
	if v := p.Decide(wrapFrom(t, "w", user, "2001:db8:1:3::1", "")); v.Out.Action != "accept" {
		t.Fatalf("the next /64: %+v", v)
	}
}
