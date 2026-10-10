// Package policy is the operator relay's write policy (contract 3.2), run by strfry as its writePolicy plugin: strfry
// sends one JSON line per incoming event and takes back accept or reject. It decides; the plugin command around it
// does the reading, the writing and the deletions strfry doesn't do itself.
package policy

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
)

// Lookups is what the policy asks of keflid's database and of its own record of the wraps the relay holds.
type Lookups interface {
	// Registered is a registered, enabled user.
	Registered(pubkey string) bool
	// Authorised is a device key some enabled user has authorised (contract 4.4).
	Authorised(pubkey string) bool
	// Wrap is a kind 1059 the relay holds: its author and its p tag.
	Wrap(id string) (author, p string, ok bool)
}

// Input is strfry's line for one event (strfry docs/plugins.md).
type Input struct {
	Type       string          `json:"type"`
	Event      json.RawMessage `json:"event"`
	ReceivedAt int64           `json:"receivedAt"`
	SourceType string          `json:"sourceType"`
	SourceInfo string          `json:"sourceInfo"`
	Authed     string          `json:"authed,omitempty"`
}

// Event is the part of a nostr event the rules read; strfry has already checked the id and signature.
type Event struct {
	ID     string     `json:"id"`
	Pubkey string     `json:"pubkey"`
	Kind   int        `json:"kind"`
	Tags   [][]string `json:"tags"`
}

type Output struct {
	ID     string `json:"id"`
	Action string `json:"action"`
	Msg    string `json:"msg,omitempty"`
}

const (
	KindDeletion = 5
	KindAppData  = 30078
	KindWrap     = 1059
	// SmallMax is contract 3.2's 16,384 bytes for kinds 30078 and 1059; strfry's own maxEventSize is the 64 KB for the
	// rest.
	SmallMax = 16_384
)

// Verdict is the policy's answer for one event. Deletes names wraps the relay must remove because their recipient
// asked (contract 3.2: a kind 5 also removes the kind 1059s it names that are addressed to its author).
type Verdict struct {
	Out     Output
	Record  *Wrap
	Deletes []string
}

// Wrap is a kind 1059 the relay accepted, which the plugin records for later kind 5s.
type Wrap struct{ ID, Author, P string }

type Policy struct {
	look  Lookups
	now   func() time.Time
	mu    sync.Mutex
	rates map[string]*window
}

type window struct {
	start time.Time
	n     int
}

func New(look Lookups, now func() time.Time) *Policy {
	return &Policy{look: look, now: now, rates: map[string]*window{}}
}

func accept(id string) Verdict { return Verdict{Out: Output{ID: id, Action: "accept"}} }

func reject(id, msg string) Verdict { return Verdict{Out: Output{ID: id, Action: "reject", Msg: msg}} }

func tags(ev Event, name string) []string {
	var out []string
	for _, t := range ev.Tags {
		if len(t) > 1 && t[0] == name {
			out = append(out, t[1])
		}
	}
	return out
}

// Decide is the rule table (contract 3.2). Imports by the operator (a restore) are taken as they are.
func (p *Policy) Decide(in Input) Verdict {
	var ev Event
	if err := json.Unmarshal(in.Event, &ev); err != nil || ev.ID == "" {
		return reject("", "invalid: unreadable event")
	}
	if in.Type != "new" || in.SourceType == "Import" {
		return accept(ev.ID)
	}
	if (ev.Kind == KindAppData || ev.Kind == KindWrap) && len(in.Event) > SmallMax {
		return reject(ev.ID, fmt.Sprintf("invalid: kind %d events are at most %d bytes", ev.Kind, SmallMax))
	}
	switch {
	case p.look.Registered(ev.Pubkey):
		return p.fromUser(in, ev)
	case ev.Kind == KindWrap:
		return p.wrap(in, ev)
	case ev.Kind == KindDeletion:
		return p.undo(in, ev)
	}
	return reject(ev.ID, "blocked: this relay keeps Kefli libraries, and this key isn't registered")
}

// fromUser: a registered author writes what it likes, 60 events a minute. A wrap it sends is recorded; a deletion it
// sends also removes the wraps it names that are addressed to it.
func (p *Policy) fromUser(in Input, ev Event) Verdict {
	if !p.allow("user:"+ev.Pubkey, 60, time.Minute) {
		return reject(ev.ID, "rate-limited: slow down")
	}
	v := accept(ev.ID)
	switch ev.Kind {
	case KindWrap:
		v.Record = p.record(ev)
	case KindDeletion:
		v.Deletes = p.consumed(ev)
	}
	return v
}

func (p *Policy) record(ev Event) *Wrap {
	ps := tags(ev, "p")
	if len(ps) != 1 {
		return nil
	}
	return &Wrap{ID: ev.ID, Author: ev.Pubkey, P: ps[0]}
}

// consumed is the wraps a deletion names that are addressed to its author: the recipient deleting a wrap it has
// consumed, which plain NIP-09 wouldn't allow since the recipient isn't the wrap's author.
func (p *Policy) consumed(ev Event) []string {
	var out []string
	for _, id := range tags(ev, "e") {
		if _, to, ok := p.look.Wrap(id); ok && to == ev.Pubkey {
			out = append(out, id)
		}
	}
	return out
}

// wrap: a gift wrap from a throwaway key, taken when its one p tag names a registered user or an authorised device;
// 120 an hour per recipient and 240 per address.
func (p *Policy) wrap(in Input, ev Event) Verdict {
	ps := tags(ev, "p")
	if len(ps) != 1 || !(p.look.Registered(ps[0]) || p.look.Authorised(ps[0])) {
		return reject(ev.ID, "blocked: gift wraps here are for Kefli users and their browsers")
	}
	if !p.allow("to:"+ps[0], 120, time.Hour) || !p.allow("ip:"+in.SourceInfo, 240, time.Hour) {
		return reject(ev.ID, "rate-limited: slow down")
	}
	v := accept(ev.ID)
	v.Record = &Wrap{ID: ev.ID, Author: ev.Pubkey, P: ps[0]}
	return v
}

// undo: a deletion from an unregistered key, taken only when every event it names is a wrap by that key which the
// relay holds; this is the extension's Undo (contract 3.2, 4.4).
func (p *Policy) undo(in Input, ev Event) Verdict {
	ids := tags(ev, "e")
	if len(ids) == 0 {
		return reject(ev.ID, "blocked: this key isn't registered")
	}
	for _, id := range ids {
		if author, _, ok := p.look.Wrap(id); !ok || author != ev.Pubkey {
			return reject(ev.ID, "blocked: deletes only a gift wrap of its own that this relay holds")
		}
	}
	if !p.allow("ip:"+in.SourceInfo, 240, time.Hour) {
		return reject(ev.ID, "rate-limited: slow down")
	}
	return accept(ev.ID)
}

// allow counts one event against key's limit in fixed windows.
func (p *Policy) allow(key string, max int, per time.Duration) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	w := p.rates[key]
	if w == nil || now.Sub(w.start) >= per {
		w = &window{start: now}
		p.rates[key] = w
		if len(p.rates) > 200_000 {
			p.rates = map[string]*window{key: w}
		}
	}
	w.n++
	return w.n <= max
}
