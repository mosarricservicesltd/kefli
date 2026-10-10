package policy

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

type fake struct {
	users, devices map[string]bool
	wraps          map[string]Wrap
}

func (f *fake) Registered(pk string) bool { return f.users[pk] }
func (f *fake) Authorised(pk string) bool { return f.devices[pk] }
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
	f := &fake{users: map[string]bool{user: true}, devices: map[string]bool{device: true}, wraps: map[string]Wrap{"w1": {ID: "w1", Author: throw, P: user}}}
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
		"someone else's wrap":  {ID: "d2", Pubkey: nobody, Kind: KindDeletion, Tags: [][]string{{"e", "w1"}}},
		"a wrap not held":      {ID: "d3", Pubkey: throw, Kind: KindDeletion, Tags: [][]string{{"e", "gone"}}},
		"one held, one not":    {ID: "d4", Pubkey: throw, Kind: KindDeletion, Tags: [][]string{{"e", "w1"}, {"e", "gone"}}},
		"naming nothing":       {ID: "d5", Pubkey: throw, Kind: KindDeletion},
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
