// Package policy is the operator relay's write policy (contract 3.2), run by strfry as its writePolicy plugin: strfry
// sends one JSON line per incoming event and takes back accept or reject. It decides; the plugin command around it
// does the reading, the writing and the deletions strfry doesn't do itself.
package policy

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/richardminton-glitch/Kefli/server/api/internal/limit"
)

// Lookups is what the policy asks of keflid's database and of its own record of the wraps the relay holds.
type Lookups interface {
	// Registered is a registered, enabled user.
	Registered(pubkey string) bool
	// Authorised is a device key some enabled user has authorised (contract 4.4).
	Authorised(pubkey string) bool
	// DeviceUser is the enabled user who authorised a device key.
	DeviceUser(pubkey string) (user string, ok bool)
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

// The limits, each in fixed windows. An address is an IPv6 sender's /64 (F8). A wrap from a sender that isn't AUTHed as
// its recipient or one of the recipient's devices counts against its address, then against the recipient from that
// address, then against the recipient from everyone: someone filling one recipient's allowance uses up only its own
// (F9), and the ceiling keeps junk from many addresses out of the recipient's inbox.
const (
	UserMax      = 60   // events a minute from a registered author, or wraps from a connection AUTHed as the recipient's
	AddrMax      = 240  // unregistered events an hour from an address
	ToAddrMax    = 120  // wraps an hour to one recipient from one address
	RecipientMax = 1200 // wraps an hour to one recipient from unAUTHed senders everywhere
)

type Policy struct {
	look      Lookups
	user      *limit.Limiter
	addr      *limit.Limiter
	toAddr    *limit.Limiter
	recipient *limit.Limiter
}

func New(look Lookups, now func() time.Time) *Policy {
	return &Policy{
		look:      look,
		user:      limit.New(UserMax, time.Minute, now),
		addr:      limit.New(AddrMax, time.Hour, now),
		toAddr:    limit.New(ToAddrMax, time.Hour, now),
		recipient: limit.New(RecipientMax, time.Hour, now),
	}
}

func allowed(l *limit.Limiter, key string) bool {
	ok, _ := l.Allow(key)
	return ok
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
	if !allowed(p.user, ev.Pubkey) {
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

// wrap: a gift wrap from a throwaway key, taken when its one p tag names a registered user or an authorised device.
// One sent on a connection AUTHed as its recipient's own key or device (a browser's save to its user, the phone's
// pair-ack to its browser) counts only against that key; any other against the limits above.
func (p *Policy) wrap(in Input, ev Event) Verdict {
	ps := tags(ev, "p")
	if len(ps) != 1 || !(p.look.Registered(ps[0]) || p.look.Authorised(ps[0])) {
		return reject(ev.ID, "blocked: gift wraps here are for Kefli users and their browsers")
	}
	to := ps[0]
	if p.ownSide(in.Authed, to) {
		if !allowed(p.user, in.Authed) {
			return reject(ev.ID, "rate-limited: slow down")
		}
	} else {
		// the sender's own address first, so a wrap it is refused never counts against the recipient
		addr := limit.Addr(in.SourceInfo, 64)
		if !allowed(p.addr, addr) || !allowed(p.toAddr, to+" "+addr) || !allowed(p.recipient, to) {
			return reject(ev.ID, "rate-limited: slow down")
		}
	}
	v := accept(ev.ID)
	v.Record = &Wrap{ID: ev.ID, Author: ev.Pubkey, P: to}
	return v
}

// ownSide is whether a connection AUTHed as authed speaks for the recipient to: the same key, a device of it, or the
// user whose device it is.
func (p *Policy) ownSide(authed, to string) bool {
	if authed == "" {
		return false
	}
	if authed == to {
		return true
	}
	if user, ok := p.look.DeviceUser(authed); ok && user == to {
		return true
	}
	user, ok := p.look.DeviceUser(to)
	return ok && user == authed
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
	if !allowed(p.addr, limit.Addr(in.SourceInfo, 64)) {
		return reject(ev.ID, "rate-limited: slow down")
	}
	return accept(ev.ID)
}
